from django.contrib.auth.models import AbstractUser
from django.db import models
import os


def avatar_upload_path(instance, filename):
    ext = filename.split('.')[-1]
    return f'avatars/user_{instance.id}.{ext}'


class User(AbstractUser):
    avatar = models.ImageField(upload_to=avatar_upload_path, null=True, blank=True)
    bio = models.TextField(max_length=300, blank=True)
    last_seen = models.DateTimeField(null=True, blank=True)

    def get_avatar_url(self):
        if self.avatar:
            return self.avatar.url
        # Generate a consistent color avatar based on username
        return None

    def get_initials(self):
        if self.first_name and self.last_name:
            return f"{self.first_name[0]}{self.last_name[0]}".upper()
        return self.username[:2].upper()

    class Meta:
        db_table = 'accounts_user'
