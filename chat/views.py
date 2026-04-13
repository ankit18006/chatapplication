from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.db.models import Q, Max, Count
from django.utils import timezone
from django.views.decorators.http import require_POST, require_GET
from .models import ChatRoom, Message, OnlineStatus
from accounts.models import User
import json


@login_required
def home(request):
    """Main chat home page."""
    rooms = request.user.chat_rooms.prefetch_related('members').order_by('-updated_at')
    users = User.objects.exclude(id=request.user.id).select_related('online_status')

    # Annotate rooms with unread counts
    room_data = []
    for room in rooms:
        last_msg = room.get_last_message()
        unread = room.messages.exclude(sender=request.user).filter(
            read_statuses__user=request.user
        ).count()
        total = room.messages.exclude(sender=request.user).count()
        unread_count = total - unread

        room_data.append({
            'room': room,
            'last_message': last_msg,
            'unread_count': max(0, unread_count),
            'display_name': room.get_display_name(request.user),
            'other_user': room.get_other_user(request.user),
        })

    context = {
        'room_data': room_data,
        'users': users,
        'current_user': request.user,
    }
    return render(request, 'chat/home.html', context)


@login_required
def room_detail(request, room_id):
    """Individual chat room view."""
    room = get_object_or_404(ChatRoom, id=room_id, members=request.user)
    messages = Message.objects.filter(room=room).select_related(
        'sender', 'reply_to__sender'
    ).order_by('timestamp')[:100]

    other_user = room.get_other_user(request.user)
    online_status = None
    if other_user:
        try:
            online_status = other_user.online_status
        except OnlineStatus.DoesNotExist:
            pass

    rooms = request.user.chat_rooms.prefetch_related('members').order_by('-updated_at')
    room_data = []
    for r in rooms:
        last_msg = r.get_last_message()
        unread = r.messages.exclude(sender=request.user).filter(
            read_statuses__user=request.user
        ).count()
        total = r.messages.exclude(sender=request.user).count()
        unread_count = total - unread
        room_data.append({
            'room': r,
            'last_message': last_msg,
            'unread_count': max(0, unread_count),
            'display_name': r.get_display_name(request.user),
            'other_user': r.get_other_user(request.user),
        })

    users = User.objects.exclude(id=request.user.id).select_related('online_status')

    context = {
        'room': room,
        'messages': messages,
        'other_user': other_user,
        'online_status': online_status,
        'room_data': room_data,
        'users': users,
        'current_user': request.user,
        'active_room_id': str(room.id),
    }
    return render(request, 'chat/home.html', context)


@login_required
def start_private_chat(request, user_id):
    """Start or open a private chat with a user."""
    other_user = get_object_or_404(User, id=user_id)
    if other_user == request.user:
        return redirect('chat:home')

    room, created = ChatRoom.get_or_create_private(request.user, other_user)
    return redirect('chat:room', room_id=room.id)


@login_required
@require_POST
def create_group(request):
    """Create a new group chat."""
    data = json.loads(request.body)
    name = data.get('name', '').strip()
    member_ids = data.get('members', [])

    if not name:
        return JsonResponse({'error': 'Group name is required'}, status=400)

    room = ChatRoom.objects.create(
        name=name,
        description=data.get('description', ''),
        room_type='group',
        created_by=request.user,
    )
    room.members.add(request.user)
    members = User.objects.filter(id__in=member_ids)
    room.members.add(*members)

    # System message
    Message.objects.create(
        room=room,
        sender=request.user,
        content=f'{request.user.get_full_name() or request.user.username} created this group',
        message_type='system',
    )

    return JsonResponse({
        'room_id': str(room.id),
        'name': room.name,
    })


@login_required
@require_GET
def api_messages(request, room_id):
    """Load more messages (pagination)."""
    room = get_object_or_404(ChatRoom, id=room_id, members=request.user)
    before_id = request.GET.get('before')
    limit = int(request.GET.get('limit', 50))

    qs = Message.objects.filter(room=room).select_related('sender', 'reply_to__sender')
    if before_id:
        try:
            before_msg = Message.objects.get(id=before_id)
            qs = qs.filter(timestamp__lt=before_msg.timestamp)
        except Message.DoesNotExist:
            pass

    messages = list(qs.order_by('-timestamp')[:limit])
    messages.reverse()

    return JsonResponse({
        'messages': [m.to_dict(request.user) for m in messages],
        'has_more': len(messages) == limit,
    })


@login_required
@require_GET
def api_online_users(request):
    """Get list of online users."""
    online = OnlineStatus.objects.filter(is_online=True).select_related('user')
    return JsonResponse({
        'users': [{'id': s.user.id, 'username': s.user.username} for s in online]
    })


@login_required
@require_GET
def search_users(request):
    """Search users."""
    q = request.GET.get('q', '').strip()
    if len(q) < 1:
        return JsonResponse({'users': []})

    users = User.objects.filter(
        Q(username__icontains=q) | Q(first_name__icontains=q) | Q(last_name__icontains=q)
    ).exclude(id=request.user.id).select_related('online_status')[:10]

    result = []
    for u in users:
        try:
            is_online = u.online_status.is_online
        except OnlineStatus.DoesNotExist:
            is_online = False
        result.append({
            'id': u.id,
            'username': u.username,
            'full_name': u.get_full_name() or u.username,
            'initials': u.get_initials(),
            'avatar': u.get_avatar_url(),
            'is_online': is_online,
        })

    return JsonResponse({'users': result})


@login_required
@require_POST
def upload_file(request):
    """Handle file uploads for chat."""
    room_id = request.POST.get('room_id')
    file = request.FILES.get('file')

    if not file or not room_id:
        return JsonResponse({'error': 'Missing data'}, status=400)

    room = get_object_or_404(ChatRoom, id=room_id, members=request.user)

    # Validate file size (10MB max)
    if file.size > 10 * 1024 * 1024:
        return JsonResponse({'error': 'File too large (max 10MB)'}, status=400)

    ext = file.name.split('.')[-1].lower()
    msg_type = 'image' if ext in ['jpg', 'jpeg', 'png', 'gif', 'webp'] else 'file'

    message = Message.objects.create(
        room=room,
        sender=request.user,
        content=file.name,
        message_type=msg_type,
        file=file,
        file_name=file.name,
    )

    return JsonResponse({'message': message.to_dict(request.user)})
