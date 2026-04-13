# NexusChat — Real-Time Chat Application

A production-ready real-time chat application built with Django, Django Channels (WebSockets), and Docker.

---

## Features

- **Real-time messaging** via WebSockets (Django Channels + Redis)
- **Private chats** (1-to-1)
- **Group chats** with custom names & members
- **Typing indicators** — live "User is typing…"
- **Online/Offline status** with real-time updates
- **Last seen** timestamps
- **File & image sharing** (drag-drop ready)
- **Reply to messages** with preview
- **Delete messages**
- **Unread message badges**
- **Toast notifications** for new messages
- **User search** with live results
- **Profile management** with avatar uploads
- **WhatsApp/Slack-like UI** — dark mode, chat bubbles, sidebar

---

## Quick Start (Docker)

### 1. Clone & Configure
```bash
cp .env.example .env
# Edit .env with your settings
```

### 2. Run with Docker Compose
```bash
docker-compose up --build
```

### 3. Create a superuser (optional)
```bash
docker-compose exec web python manage.py createsuperuser
```

### 4. Open in browser
```
http://localhost
```
Register two accounts in different browser tabs and start chatting!

---

## Local Development (without Docker)

### Requirements
- Python 3.11+
- Redis server running on localhost:6379

### Setup
```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Set up environment
export REDIS_URL=redis://localhost:6379
export SECRET_KEY=dev-secret-key
export DEBUG=True

# Run migrations
python manage.py migrate

# Start server (ASGI with Daphne)
daphne -b 0.0.0.0 -p 8000 chatapp.asgi:application
```

---

## Architecture

```
Browser <──WebSocket──> Django Channels <──> Redis Channel Layer
                              │
                        Chat Consumer
                        (chat/consumers.py)
                              │
                        SQLite / PostgreSQL
                        (chat/models.py)
```

### Key Files

| File | Purpose |
|------|---------|
| `chat/consumers.py` | WebSocket consumers (ChatConsumer, PresenceConsumer) |
| `chat/models.py` | ChatRoom, Message, OnlineStatus models |
| `chat/views.py` | HTTP views + REST API endpoints |
| `chat/routing.py` | WebSocket URL routing |
| `chatapp/asgi.py` | ASGI application entry point |
| `static/js/chat.js` | Frontend WebSocket client + UI logic |
| `static/css/main.css` | Complete dark-mode UI stylesheet |

---

## WebSocket Protocol

### Client → Server
```json
{ "type": "message", "content": "Hello!", "reply_to_id": null }
{ "type": "typing", "is_typing": true }
{ "type": "read" }
{ "type": "delete", "message_id": "uuid" }
```

### Server → Client
```json
{ "type": "message", "message": { ...messageData } }
{ "type": "typing", "username": "Alice", "is_typing": true }
{ "type": "status", "user_id": 1, "status": "online" }
{ "type": "deleted", "message_id": "uuid" }
```

---

## Production Checklist

- [ ] Change `SECRET_KEY` in `.env`
- [ ] Set `DEBUG=False`
- [ ] Configure `ALLOWED_HOSTS`
- [ ] Use PostgreSQL instead of SQLite
- [ ] Configure proper Redis password
- [ ] Set up SSL/TLS (WSS required for HTTPS)
- [ ] Run `collectstatic`
- [ ] Configure media file storage (S3 recommended)

---

## Tech Stack

- **Backend**: Django 4.2
- **WebSockets**: Django Channels 4.0
- **Channel Layer**: channels-redis (Redis)
- **ASGI Server**: Daphne
- **Database**: SQLite (PostgreSQL ready)
- **Frontend**: Vanilla JS + CSS (no frameworks)
- **Container**: Docker + Docker Compose
- **Reverse Proxy**: Nginx

---

## Deploying to Render.com

### Option A — Blueprint (recommended, one click)
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New → Blueprint**
3. Connect your repo — Render reads `render.yaml` and creates:
   - A **Web Service** (Docker) running Daphne
   - A **Redis** instance wired in automatically
4. Click **Apply** — done ✅

### Option B — Manual setup
1. **New → Web Service** → connect your GitHub repo
2. Set **Environment** = `Docker`
3. Add these environment variables:

| Key | Value |
|-----|-------|
| `SECRET_KEY` | (generate a long random string) |
| `DEBUG` | `False` |
| `REDIS_URL` | (from your Render Redis instance → Connection String) |

4. **New → Redis** → free plan → copy the **Internal Connection String** into `REDIS_URL`
5. Deploy

### Why "Application exited early" happens
Render runs **only** the `Dockerfile` — not `docker-compose.yml`.
The original Dockerfile had no `CMD`, so the container started and immediately exited.
This is fixed: `entrypoint.sh` now runs migrations → collectstatic → daphne.

### Without Redis (free tier, no Redis add-on)
The app still works using Django Channels' **InMemory** channel layer.
Real-time works within a single dyno. To scale or use multiple workers, add Redis.
