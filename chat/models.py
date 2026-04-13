from django.db import models
from django.conf import settings
from django.utils import timezone
import uuid


class ChatRoom(models.Model):
    ROOM_TYPES = (
        ('private', 'Private'),
        ('group', 'Group'),
    )
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200, blank=True)
    description = models.TextField(blank=True)
    room_type = models.CharField(max_length=10, choices=ROOM_TYPES, default='group')
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name='chat_rooms', blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name='created_rooms'
    )
    avatar = models.ImageField(upload_to='room_avatars/', null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at']

    def __str__(self):
        return self.name or f"Private Chat {self.id}"

    def get_display_name(self, user):
        """For private chats, return the other person's name."""
        if self.room_type == 'private':
            other = self.members.exclude(id=user.id).first()
            if other:
                return other.get_full_name() or other.username
        return self.name

    def get_other_user(self, user):
        """For private chats, return the other member."""
        if self.room_type == 'private':
            return self.members.exclude(id=user.id).first()
        return None

    def get_last_message(self):
        return self.messages.order_by('-timestamp').first()

    def get_unread_count(self, user):
        return self.messages.exclude(sender=user).filter(
            timestamp__gt=user.last_seen or timezone.datetime.min.replace(tzinfo=timezone.utc)
        ).count()

    @staticmethod
    def get_or_create_private(user1, user2):
        """Get or create a private chat room between two users."""
        rooms = ChatRoom.objects.filter(
            room_type='private',
            members=user1
        ).filter(members=user2)
        if rooms.exists():
            return rooms.first(), False
        room = ChatRoom.objects.create(room_type='private', created_by=user1)
        room.members.add(user1, user2)
        return room, True


class Message(models.Model):
    MESSAGE_TYPES = (
        ('text', 'Text'),
        ('image', 'Image'),
        ('file', 'File'),
        ('system', 'System'),
    )
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    room = models.ForeignKey(ChatRoom, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='sent_messages'
    )
    content = models.TextField(blank=True)
    message_type = models.CharField(max_length=10, choices=MESSAGE_TYPES, default='text')
    file = models.FileField(upload_to='uploads/', null=True, blank=True)
    file_name = models.CharField(max_length=255, blank=True)
    is_edited = models.BooleanField(default=False)
    is_deleted = models.BooleanField(default=False)
    reply_to = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, blank=True, related_name='replies')
    timestamp = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"{self.sender.username}: {self.content[:50]}"

    def get_file_url(self):
        if self.file:
            return self.file.url
        return None

    def to_dict(self, current_user=None):
        data = {
            'id': str(self.id),
            'room_id': str(self.room_id),
            'sender_id': self.sender_id,
            'sender_name': self.sender.get_full_name() or self.sender.username,
            'sender_username': self.sender.username,
            'sender_initials': self.sender.get_initials(),
            'sender_avatar': self.sender.get_avatar_url(),
            'content': self.content if not self.is_deleted else 'This message was deleted',
            'message_type': self.message_type,
            'file_url': self.get_file_url(),
            'file_name': self.file_name,
            'is_deleted': self.is_deleted,
            'is_edited': self.is_edited,
            'timestamp': self.timestamp.isoformat(),
            'timestamp_display': self.timestamp.strftime('%I:%M %p'),
            'is_own': current_user and self.sender_id == current_user.id,
        }
        if self.reply_to:
            data['reply_to'] = {
                'id': str(self.reply_to.id),
                'sender_name': self.reply_to.sender.get_full_name() or self.reply_to.sender.username,
                'content': self.reply_to.content[:100],
            }
        return data


class OnlineStatus(models.Model):
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='online_status'
    )
    is_online = models.BooleanField(default=False)
    last_seen = models.DateTimeField(null=True, blank=True)
    channel_name = models.CharField(max_length=255, blank=True)

    def __str__(self):
        return f"{self.user.username} - {'Online' if self.is_online else 'Offline'}"

    @classmethod
    def set_online(cls, user, channel_name=''):
        status, _ = cls.objects.get_or_create(user=user)
        status.is_online = True
        status.channel_name = channel_name
        status.save(update_fields=['is_online', 'channel_name'])
        return status

    @classmethod
    def set_offline(cls, user):
        now = timezone.now()
        status, _ = cls.objects.get_or_create(user=user)
        status.is_online = False
        status.last_seen = now
        status.save(update_fields=['is_online', 'last_seen'])
        user.last_seen = now
        user.save(update_fields=['last_seen'])
        return status

    def get_last_seen_display(self):
        if self.is_online:
            return 'Online'
        if not self.last_seen:
            return 'Never'
        from django.utils.timesince import timesince
        return f"Last seen {timesince(self.last_seen)} ago"


class MessageReadStatus(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='read_statuses')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    read_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'user')
