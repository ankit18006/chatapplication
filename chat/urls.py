from django.urls import path
from . import views

app_name = 'chat'

urlpatterns = [
    path('', views.home, name='home'),
    path('room/<uuid:room_id>/', views.room_detail, name='room'),
    path('start/<int:user_id>/', views.start_private_chat, name='start_private'),
    path('create-group/', views.create_group, name='create_group'),
    path('api/messages/<uuid:room_id>/', views.api_messages, name='api_messages'),
    path('api/online-users/', views.api_online_users, name='api_online_users'),
    path('api/search-users/', views.search_users, name='search_users'),
    path('api/upload/', views.upload_file, name='upload_file'),
]
