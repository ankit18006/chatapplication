import json
import base64
import uuid
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.utils import timezone
from django.core.files.base import ContentFile


class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope['user']
        if not self.user.is_authenticated:
            await self.close()
            return

        self.room_id = self.scope['url_route']['kwargs']['room_id']
        self.room_group_name = f'chat_{self.room_id}'

        # Join room group
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)

        # Mark user online
        await self.set_user_online()

        await self.accept()

        # Notify room of user join
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'user_status',
                'user_id': self.user.id,
                'username': self.user.username,
                'status': 'online',
            }
        )

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)

        if hasattr(self, 'user') and self.user.is_authenticated:
            await self.set_user_offline()
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'user_status',
                    'user_id': self.user.id,
                    'username': self.user.username,
                    'status': 'offline',
                }
            )

    async def receive(self, text_data):
        data = json.loads(text_data)
        msg_type = data.get('type', 'message')

        if msg_type == 'message':
            await self.handle_message(data)
        elif msg_type == 'typing':
            await self.handle_typing(data)
        elif msg_type == 'read':
            await self.handle_read(data)
        elif msg_type == 'delete':
            await self.handle_delete(data)

    async def handle_message(self, data):
        content = data.get('content', '').strip()
        file_data = data.get('file_data')
        file_name = data.get('file_name', '')
        reply_to_id = data.get('reply_to_id')

        if not content and not file_data:
            return

        message = await self.save_message(content, file_data, file_name, reply_to_id)
        if not message:
            return

        msg_dict = await self.get_message_dict(message)

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'chat_message',
                'message': msg_dict,
            }
        )

        # Update room's updated_at
        await self.update_room_timestamp()

        # Send notification to all room members who are not in this room
        await self.send_notifications(msg_dict)

    async def handle_typing(self, data):
        is_typing = data.get('is_typing', False)
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'typing_indicator',
                'user_id': self.user.id,
                'username': self.user.get_full_name() or self.user.username,
                'is_typing': is_typing,
            }
        )

    async def handle_read(self, data):
        await self.mark_messages_read()

    async def handle_delete(self, data):
        message_id = data.get('message_id')
        success = await self.delete_message(message_id)
        if success:
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'message_deleted',
                    'message_id': message_id,
                }
            )

    # WebSocket event handlers
    async def chat_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message',
            'message': event['message'],
        }))

    async def typing_indicator(self, event):
        if event['user_id'] != self.user.id:
            await self.send(text_data=json.dumps({
                'type': 'typing',
                'user_id': event['user_id'],
                'username': event['username'],
                'is_typing': event['is_typing'],
            }))

    async def user_status(self, event):
        await self.send(text_data=json.dumps({
            'type': 'status',
            'user_id': event['user_id'],
            'username': event['username'],
            'status': event['status'],
        }))

    async def message_deleted(self, event):
        await self.send(text_data=json.dumps({
            'type': 'deleted',
            'message_id': event['message_id'],
        }))

    async def notification(self, event):
        await self.send(text_data=json.dumps({
            'type': 'notification',
            'data': event['data'],
        }))

    # DB operations
    @database_sync_to_async
    def save_message(self, content, file_data, file_name, reply_to_id):
        from .models import ChatRoom, Message
        try:
            room = ChatRoom.objects.get(id=self.room_id, members=self.user)
            msg = Message(room=room, sender=self.user, content=content)

            if file_data:
                # Decode base64 file
                try:
                    format, data = file_data.split(';base64,')
                    ext = format.split('/')[-1]
                    decoded = base64.b64decode(data)
                    unique_name = f"{uuid.uuid4()}.{ext}"
                    msg.file.save(unique_name, ContentFile(decoded), save=False)
                    msg.file_name = file_name or unique_name
                    # Determine type
                    if ext.lower() in ['jpg', 'jpeg', 'png', 'gif', 'webp']:
                        msg.message_type = 'image'
                    else:
                        msg.message_type = 'file'
                except Exception:
                    pass

            if reply_to_id:
                try:
                    msg.reply_to = Message.objects.get(id=reply_to_id, room=room)
                except Message.DoesNotExist:
                    pass

            msg.save()
            return msg
        except ChatRoom.DoesNotExist:
            return None

    @database_sync_to_async
    def get_message_dict(self, message):
        # Refresh to get related objects
        from .models import Message
        message = Message.objects.select_related('sender', 'reply_to__sender').get(id=message.id)
        return message.to_dict(self.user)

    @database_sync_to_async
    def set_user_online(self):
        from .models import OnlineStatus
        OnlineStatus.set_online(self.user, self.channel_name)

    @database_sync_to_async
    def set_user_offline(self):
        from .models import OnlineStatus
        OnlineStatus.set_offline(self.user)

    @database_sync_to_async
    def mark_messages_read(self):
        from .models import ChatRoom, Message, MessageReadStatus
        try:
            room = ChatRoom.objects.get(id=self.room_id)
            unread = Message.objects.filter(room=room).exclude(sender=self.user)
            for msg in unread:
                MessageReadStatus.objects.get_or_create(message=msg, user=self.user)
        except Exception:
            pass

    @database_sync_to_async
    def delete_message(self, message_id):
        from .models import Message
        try:
            msg = Message.objects.get(id=message_id, sender=self.user)
            msg.is_deleted = True
            msg.content = ''
            msg.save(update_fields=['is_deleted', 'content'])
            return True
        except Message.DoesNotExist:
            return False

    @database_sync_to_async
    def update_room_timestamp(self):
        from .models import ChatRoom
        ChatRoom.objects.filter(id=self.room_id).update(updated_at=timezone.now())

    @database_sync_to_async
    def send_notifications(self, msg_dict):
        pass  # Notifications handled via presence consumer


class PresenceConsumer(AsyncWebsocketConsumer):
    """Global presence tracking for online status and notifications."""

    async def connect(self):
        self.user = self.scope['user']
        if not self.user.is_authenticated:
            await self.close()
            return

        self.user_group = f'user_{self.user.id}'
        await self.channel_layer.group_add(self.user_group, self.channel_name)
        await self.channel_layer.group_add('presence', self.channel_name)

        await self.set_online()
        await self.accept()

        # Broadcast online status
        await self.broadcast_status('online')

        # Send current online users
        online_users = await self.get_online_users()
        await self.send(text_data=json.dumps({
            'type': 'online_users',
            'users': online_users,
        }))

    async def disconnect(self, close_code):
        if hasattr(self, 'user') and self.user.is_authenticated:
            await self.set_offline()
            await self.broadcast_status('offline')

        if hasattr(self, 'user_group'):
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
            await self.channel_layer.group_discard('presence', self.channel_name)

    async def receive(self, text_data):
        data = json.loads(text_data)
        if data.get('type') == 'ping':
            await self.send(text_data=json.dumps({'type': 'pong'}))

    async def user_status_update(self, event):
        await self.send(text_data=json.dumps({
            'type': 'status_update',
            'user_id': event['user_id'],
            'username': event['username'],
            'status': event['status'],
            'last_seen': event.get('last_seen', ''),
        }))

    async def new_notification(self, event):
        await self.send(text_data=json.dumps({
            'type': 'notification',
            'data': event['data'],
        }))

    @database_sync_to_async
    def set_online(self):
        from .models import OnlineStatus
        OnlineStatus.set_online(self.user, self.channel_name)

    @database_sync_to_async
    def set_offline(self):
        from .models import OnlineStatus
        OnlineStatus.set_offline(self.user)

    @database_sync_to_async
    def get_online_users(self):
        from .models import OnlineStatus
        statuses = OnlineStatus.objects.filter(is_online=True).select_related('user')
        return [{'user_id': s.user.id, 'username': s.user.username} for s in statuses]

    async def broadcast_status(self, status):
        last_seen = ''
        if status == 'offline':
            last_seen = timezone.now().isoformat()

        await self.channel_layer.group_send(
            'presence',
            {
                'type': 'user_status_update',
                'user_id': self.user.id,
                'username': self.user.username,
                'status': status,
                'last_seen': last_seen,
            }
        )
