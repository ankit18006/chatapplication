from django.contrib import admin
from .models import ChatRoom, Message, OnlineStatus

@admin.register(ChatRoom)
class ChatRoomAdmin(admin.ModelAdmin):
    list_display = ('name', 'room_type', 'created_by', 'created_at')
    filter_horizontal = ('members',)

@admin.register(Message)
class MessageAdmin(admin.ModelAdmin):
    list_display = ('sender', 'room', 'message_type', 'timestamp', 'is_deleted')
    list_filter = ('message_type', 'is_deleted')

@admin.register(OnlineStatus)
class OnlineStatusAdmin(admin.ModelAdmin):
    list_display = ('user', 'is_online', 'last_seen')
