#!/bin/bash
set -e

echo "==> Running database migrations..."
python manage.py migrate --noinput

echo "==> Collecting static files..."
python manage.py collectstatic --noinput

echo "==> Starting Daphne ASGI server..."
exec daphne -b 0.0.0.0 -p "${PORT:-8000}" chatapp.asgi:application
