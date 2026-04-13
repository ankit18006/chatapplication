/* ══════════════════════════════════════════════════
   NexusChat — chat.js
   Real-time WebSocket chat engine
   ══════════════════════════════════════════════════ */

let chatSocket = null;
let presenceSocket = null;
let typingTimer = null;
let isTyping = false;
let replyToId = null;
let replyToName = null;
let replyToText = null;
let ctxMessageId = null;
let ctxIsOwn = false;
let oldestMessageId = null;
let hasMoreMessages = true;
let selectedMembers = {};

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initPresenceSocket();
  if (ROOM_ID) {
    initChatSocket();
    scrollToBottom();
    setupLoadMore();
  }
  document.addEventListener('click', handleGlobalClick);
  applyAvatarColors();
});

function applyAvatarColors() {
  document.querySelectorAll('.avatar-initials').forEach(el => {
    const c = parseInt(el.dataset.color || '0') % 11;
    el.dataset.color = c;
  });
}

// ══════════════════════════════════════════════════
// WEBSOCKET — CHAT
// ══════════════════════════════════════════════════
function initChatSocket() {
  const url = `${WS_SCHEME}://${WS_HOST}/ws/chat/${ROOM_ID}/`;
  chatSocket = new WebSocket(url);

  chatSocket.onopen = () => {
    console.log('[WS] Chat connected');
    chatSocket.send(JSON.stringify({ type: 'read' }));
    clearBadge(ROOM_ID);
  };

  chatSocket.onmessage = (e) => {
    const data = JSON.parse(e.data);
    switch (data.type) {
      case 'message':   handleIncomingMessage(data.message); break;
      case 'typing':    handleTypingIndicator(data); break;
      case 'status':    handleStatusUpdate(data); break;
      case 'deleted':   handleMessageDeleted(data.message_id); break;
    }
  };

  chatSocket.onclose = () => {
    console.log('[WS] Chat disconnected — reconnecting...');
    setTimeout(initChatSocket, 2000);
  };

  chatSocket.onerror = (e) => console.error('[WS] Chat error', e);
}

// ══════════════════════════════════════════════════
// WEBSOCKET — PRESENCE
// ══════════════════════════════════════════════════
function initPresenceSocket() {
  const url = `${WS_SCHEME}://${WS_HOST}/ws/presence/`;
  presenceSocket = new WebSocket(url);

  presenceSocket.onopen = () => {
    console.log('[WS] Presence connected');
    setInterval(() => {
      if (presenceSocket.readyState === WebSocket.OPEN) {
        presenceSocket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  };

  presenceSocket.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'status_update') {
      updateUserOnlineStatus(data.user_id, data.status === 'online');
    } else if (data.type === 'online_users') {
      data.users.forEach(u => updateUserOnlineStatus(u.user_id, true));
    } else if (data.type === 'notification') {
      showToast(data.data.sender, data.data.content, data.data.room_id);
    }
  };

  presenceSocket.onclose = () => {
    setTimeout(initPresenceSocket, 3000);
  };
}

function updateUserOnlineStatus(userId, isOnline) {
  // Update all dots for this user
  document.querySelectorAll(`#dot-${userId}`).forEach(dot => {
    dot.style.display = isOnline ? 'block' : 'none';
  });
  // Update header dot if in private chat with this user
  if (OTHER_USER_ID && userId === OTHER_USER_ID) {
    const headerDot = document.getElementById('header-dot');
    const headerStatus = document.getElementById('headerStatus');
    if (headerDot) headerDot.style.display = isOnline ? 'block' : 'none';
    if (headerStatus) {
      headerStatus.innerHTML = isOnline
        ? '<span class="status-online">Online</span>'
        : 'Last seen recently';
    }
  }
  // Update people list status text
  const statusEl = document.getElementById(`status-${userId}`);
  if (statusEl) {
    statusEl.textContent = isOnline ? 'Online' : 'Offline';
    statusEl.style.color = isOnline ? 'var(--online-green)' : '';
  }
}

// ══════════════════════════════════════════════════
// SEND MESSAGE
// ══════════════════════════════════════════════════
function sendMessage() {
  if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content) return;

  const payload = { type: 'message', content };
  if (replyToId) {
    payload.reply_to_id = replyToId;
    cancelReply();
  }

  chatSocket.send(JSON.stringify(payload));
  input.value = '';
  input.style.height = 'auto';

  // Stop typing
  if (isTyping) {
    isTyping = false;
    chatSocket.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }
}

// ══════════════════════════════════════════════════
// RECEIVE MESSAGE
// ══════════════════════════════════════════════════
function handleIncomingMessage(msg) {
  appendMessage(msg);
  scrollToBottom();

  // Mark read if our window is active
  if (document.visibilityState === 'visible' && chatSocket.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'read' }));
    clearBadge(ROOM_ID);
  }

  // Update sidebar preview
  updateSidebarPreview(msg.room_id, msg.content, msg.timestamp_display);

  // Show notification if message is from others and page is hidden
  if (!msg.is_own && document.visibilityState !== 'visible') {
    showToast(msg.sender_name, msg.content || '📎 Attachment', msg.room_id);
  }
}

function appendMessage(msg) {
  const container = document.getElementById('messagesContainer');
  if (!container) return;

  // Check if already exists
  if (document.getElementById(`msg-${msg.id}`)) return;

  const el = buildMessageEl(msg);
  container.appendChild(el);
}

function buildMessageEl(msg) {
  const wrapper = document.createElement('div');
  wrapper.id = `msg-${msg.id}`;
  wrapper.dataset.msgId = msg.id;
  wrapper.className = `message-wrapper${msg.is_own ? ' own' : ''}`;

  if (msg.message_type === 'system') {
    wrapper.innerHTML = `<div class="system-message">${escapeHtml(msg.content)}</div>`;
    return wrapper;
  }

  let avatarHtml = '';
  if (!msg.is_own) {
    if (msg.sender_avatar) {
      avatarHtml = `<div class="msg-avatar"><img src="${msg.sender_avatar}" class="avatar avatar-xs" alt=""></div>`;
    } else {
      const color = msg.sender_username.length % 11;
      avatarHtml = `<div class="msg-avatar"><div class="avatar avatar-xs avatar-initials" data-color="${color}">${escapeHtml(msg.sender_initials)}</div></div>`;
    }
  }

  let senderName = '';
  if (!msg.is_own && ROOM_TYPE === 'group') {
    senderName = `<span class="msg-sender-name">${escapeHtml(msg.sender_name)}</span>`;
  }

  let replyHtml = '';
  if (msg.reply_to) {
    replyHtml = `
      <div class="msg-reply-preview">
        <span class="reply-sender">${escapeHtml(msg.reply_to.sender_name)}</span>
        <span class="reply-text">${escapeHtml(msg.reply_to.content)}</span>
      </div>`;
  }

  let contentHtml = '';
  if (msg.is_deleted) {
    contentHtml = `<span class="deleted-text">🚫 This message was deleted</span>`;
  } else if (msg.message_type === 'image' && msg.file_url) {
    contentHtml = `<img src="${msg.file_url}" class="msg-image" onclick="openImageViewer('${msg.file_url}')" alt="Image">`;
    if (msg.content) contentHtml += `<p class="msg-text">${escapeHtml(msg.content)}</p>`;
  } else if (msg.message_type === 'file' && msg.file_url) {
    contentHtml = `
      <a href="${msg.file_url}" target="_blank" class="msg-file">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span>${escapeHtml(msg.file_name || 'Download')}</span>
      </a>`;
  } else {
    contentHtml = `<p class="msg-text">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</p>`;
  }

  const ownStr = msg.is_own ? 'true' : 'false';

  wrapper.innerHTML = `
    ${avatarHtml}
    <div class="msg-bubble-wrap">
      ${senderName}
      ${replyHtml}
      <div class="msg-bubble${msg.is_deleted ? ' deleted' : ''}"
           oncontextmenu="showMsgMenu(event, '${msg.id}', ${ownStr})">
        ${contentHtml}
        <div class="msg-meta">
          <span class="msg-time">${escapeHtml(msg.timestamp_display)}</span>
          ${msg.is_own ? '<span class="msg-status">✓✓</span>' : ''}
          ${msg.is_edited ? '<span class="msg-edited">edited</span>' : ''}
        </div>
      </div>
    </div>`;

  return wrapper;
}

// ══════════════════════════════════════════════════
// TYPING
// ══════════════════════════════════════════════════
function handleInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function handleTyping(textarea) {
  // Auto-resize
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';

  if (!chatSocket || chatSocket.readyState !== WebSocket.OPEN) return;

  if (!isTyping) {
    isTyping = true;
    chatSocket.send(JSON.stringify({ type: 'typing', is_typing: true }));
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    chatSocket.send(JSON.stringify({ type: 'typing', is_typing: false }));
  }, 2000);
}

function handleTypingIndicator(data) {
  const indicator = document.getElementById('typingIndicator');
  const typingText = document.getElementById('typingText');
  if (!indicator || !typingText) return;

  if (data.is_typing) {
    typingText.textContent = `${data.username} is typing…`;
    indicator.classList.remove('hidden');
    scrollToBottom();
  } else {
    indicator.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════
// STATUS
// ══════════════════════════════════════════════════
function handleStatusUpdate(data) {
  updateUserOnlineStatus(data.user_id, data.status === 'online');
}

// ══════════════════════════════════════════════════
// DELETE MESSAGE
// ══════════════════════════════════════════════════
function deleteMessage() {
  if (!ctxMessageId || !chatSocket) return;
  chatSocket.send(JSON.stringify({ type: 'delete', message_id: ctxMessageId }));
  hideCtxMenu();
}

function handleMessageDeleted(messageId) {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return;
  const bubble = el.querySelector('.msg-bubble');
  if (bubble) {
    bubble.classList.add('deleted');
    const contentArea = bubble.querySelector('.msg-text, .msg-image, .msg-file');
    if (contentArea) contentArea.outerHTML = `<span class="deleted-text">🚫 This message was deleted</span>`;
  }
}

// ══════════════════════════════════════════════════
// REPLY
// ══════════════════════════════════════════════════
function replyToMessage() {
  if (!ctxMessageId) return;
  const el = document.getElementById(`msg-${ctxMessageId}`);
  if (!el) return;

  const textEl = el.querySelector('.msg-text');
  const senderEl = el.querySelector('.msg-sender-name');
  const bubbleWrap = el.querySelector('.msg-bubble-wrap');

  replyToId = ctxMessageId;
  replyToText = textEl ? textEl.textContent.slice(0, 80) : '📎 Attachment';

  // Figure out sender name
  if (el.classList.contains('own')) {
    replyToName = 'You';
  } else if (senderEl) {
    replyToName = senderEl.textContent;
  } else {
    replyToName = 'User';
  }

  document.getElementById('replyPreviewName').textContent = replyToName;
  document.getElementById('replyPreviewText').textContent = replyToText;
  document.getElementById('replyPreview').classList.remove('hidden');
  document.getElementById('messageInput').focus();
  hideCtxMenu();
}

function cancelReply() {
  replyToId = null;
  replyToName = null;
  replyToText = null;
  document.getElementById('replyPreview').classList.add('hidden');
}

// ══════════════════════════════════════════════════
// COPY
// ══════════════════════════════════════════════════
function copyMessage() {
  if (!ctxMessageId) return;
  const el = document.getElementById(`msg-${ctxMessageId}`);
  const textEl = el && el.querySelector('.msg-text');
  if (textEl) {
    navigator.clipboard.writeText(textEl.textContent).catch(() => {});
  }
  hideCtxMenu();
}

// ══════════════════════════════════════════════════
// CONTEXT MENU
// ══════════════════════════════════════════════════
function showMsgMenu(e, messageId, isOwn) {
  e.preventDefault();
  ctxMessageId = messageId;
  ctxIsOwn = isOwn;

  const menu = document.getElementById('ctxMenu');
  const deleteBtn = document.getElementById('ctxDelete');

  if (isOwn) {
    deleteBtn.classList.remove('hidden');
  } else {
    deleteBtn.classList.add('hidden');
  }

  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
  menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 130)}px`;
  menu.classList.remove('hidden');
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').classList.add('hidden');
}

function handleGlobalClick(e) {
  const menu = document.getElementById('ctxMenu');
  if (menu && !menu.contains(e.target)) hideCtxMenu();

  const userMenu = document.getElementById('userMenu');
  if (userMenu && !userMenu.closest('.user-menu-wrap').contains(e.target)) {
    userMenu.classList.add('hidden');
  }

  const searchResults = document.getElementById('searchResults');
  const searchInput = document.getElementById('searchInput');
  if (searchResults && !searchResults.contains(e.target) && e.target !== searchInput) {
    searchResults.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════
// FILE UPLOAD
// ══════════════════════════════════════════════════
function handleFileUpload(input) {
  const file = input.files[0];
  if (!file || !ROOM_ID) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('room_id', ROOM_ID);

  fetch('/api/upload/', {
    method: 'POST',
    headers: { 'X-CSRFToken': CSRF_TOKEN },
    body: formData
  })
  .then(r => r.json())
  .then(data => {
    if (data.message) {
      appendMessage({ ...data.message, is_own: true });
      scrollToBottom();
    }
  })
  .catch(console.error);

  input.value = '';
}

// ══════════════════════════════════════════════════
// LOAD MORE MESSAGES
// ══════════════════════════════════════════════════
function setupLoadMore() {
  const container = document.getElementById('messagesContainer');
  const messages = container ? container.querySelectorAll('.message-wrapper') : [];
  if (messages.length > 0) {
    oldestMessageId = messages[0].dataset.msgId;
  }
  if (messages.length < 100) {
    const wrap = document.getElementById('loadMoreWrap');
    if (wrap) wrap.classList.add('hidden');
    hasMoreMessages = false;
  }
}

function loadMoreMessages() {
  if (!hasMoreMessages || !oldestMessageId) return;

  fetch(`/api/messages/${ROOM_ID}/?before=${oldestMessageId}&limit=50`)
    .then(r => r.json())
    .then(data => {
      const container = document.getElementById('messagesContainer');
      const area = document.getElementById('messagesArea');
      const scrollBottom = area.scrollHeight - area.scrollTop;

      const frag = document.createDocumentFragment();
      data.messages.forEach(msg => {
        if (!document.getElementById(`msg-${msg.id}`)) {
          frag.appendChild(buildMessageEl(msg));
        }
      });

      const loadMoreWrap = document.getElementById('loadMoreWrap');
      loadMoreWrap.after(frag);

      if (data.messages.length > 0) {
        oldestMessageId = data.messages[0].id;
      }
      if (!data.has_more) {
        document.getElementById('loadMoreWrap').classList.add('hidden');
        hasMoreMessages = false;
      }

      // Restore scroll position
      area.scrollTop = area.scrollHeight - scrollBottom;
    })
    .catch(console.error);
}

// ══════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════
let searchTimeout = null;

function handleSearch(val) {
  clearTimeout(searchTimeout);
  const results = document.getElementById('searchResults');
  if (!val.trim()) { results.classList.add('hidden'); return; }

  searchTimeout = setTimeout(() => {
    fetch(`/api/search-users/?q=${encodeURIComponent(val)}`)
      .then(r => r.json())
      .then(data => {
        if (!data.users.length) { results.classList.add('hidden'); return; }
        results.innerHTML = '';
        data.users.forEach(u => {
          const color = u.username.length % 11;
          const avatarHtml = u.avatar
            ? `<img src="${u.avatar}" class="avatar avatar-xs" alt="">`
            : `<div class="avatar avatar-xs avatar-initials" data-color="${color}">${escapeHtml(u.initials || u.username.slice(0,2).toUpperCase())}</div>`;

          const item = document.createElement('a');
          item.href = `/start/${u.id}/`;
          item.className = 'search-result-item';
          item.innerHTML = `
            <div style="position:relative">
              ${avatarHtml}
              ${u.is_online ? '<span class="online-dot"></span>' : ''}
            </div>
            <div>
              <div style="font-weight:600;font-size:13.5px">${escapeHtml(u.full_name)}</div>
              <div style="font-size:12px;color:var(--text-muted)">@${escapeHtml(u.username)}</div>
            </div>`;
          results.appendChild(item);
        });
        results.classList.remove('hidden');
      });
  }, 200);
}

// ══════════════════════════════════════════════════
// GROUP CHAT CREATION
// ══════════════════════════════════════════════════
function openGroupModal() {
  document.getElementById('groupModal').classList.remove('hidden');
}

function closeGroupModal(e) {
  if (!e || e.target === document.getElementById('groupModal')) {
    document.getElementById('groupModal').classList.add('hidden');
    document.getElementById('groupName').value = '';
    document.getElementById('memberSearch').value = '';
    document.getElementById('memberSearchResults').innerHTML = '';
    document.getElementById('selectedMembers').innerHTML = '';
    selectedMembers = {};
  }
}

let memberSearchTimeout = null;

function searchMembers(val) {
  clearTimeout(memberSearchTimeout);
  const results = document.getElementById('memberSearchResults');
  if (!val.trim()) { results.innerHTML = ''; return; }

  memberSearchTimeout = setTimeout(() => {
    fetch(`/api/search-users/?q=${encodeURIComponent(val)}`)
      .then(r => r.json())
      .then(data => {
        results.innerHTML = '';
        data.users.forEach(u => {
          if (selectedMembers[u.id]) return;
          const color = u.username.length % 11;
          const item = document.createElement('div');
          item.className = 'member-result-item';
          item.innerHTML = `
            <div class="avatar avatar-xs avatar-initials" data-color="${color}">${escapeHtml(u.initials || u.username.slice(0,2).toUpperCase())}</div>
            <span>${escapeHtml(u.full_name)}</span>
            <span style="color:var(--text-muted);font-size:12px">@${escapeHtml(u.username)}</span>`;
          item.onclick = () => addMember(u);
          results.appendChild(item);
        });
      });
  }, 200);
}

function addMember(user) {
  if (selectedMembers[user.id]) return;
  selectedMembers[user.id] = user;

  const chip = document.createElement('div');
  chip.className = 'selected-chip';
  chip.id = `chip-${user.id}`;
  chip.innerHTML = `
    <span>${escapeHtml(user.full_name)}</span>
    <span class="chip-remove" onclick="removeMember(${user.id})">×</span>`;
  document.getElementById('selectedMembers').appendChild(chip);
  document.getElementById('memberSearch').value = '';
  document.getElementById('memberSearchResults').innerHTML = '';
}

function removeMember(userId) {
  delete selectedMembers[userId];
  const chip = document.getElementById(`chip-${userId}`);
  if (chip) chip.remove();
}

function createGroup() {
  const name = document.getElementById('groupName').value.trim();
  if (!name) { alert('Please enter a group name'); return; }

  const memberIds = Object.keys(selectedMembers);
  fetch('/create-group/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': CSRF_TOKEN
    },
    body: JSON.stringify({ name, members: memberIds })
  })
  .then(r => r.json())
  .then(data => {
    if (data.room_id) {
      window.location.href = `/room/${data.room_id}/`;
    }
  })
  .catch(console.error);
}

// ══════════════════════════════════════════════════
// SIDEBAR TABS
// ══════════════════════════════════════════════════
function switchTab(tab, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'chats') {
    document.getElementById('chatsList').classList.remove('hidden');
    document.getElementById('peopleList').classList.add('hidden');
  } else {
    document.getElementById('chatsList').classList.add('hidden');
    document.getElementById('peopleList').classList.remove('hidden');
  }
}

// ══════════════════════════════════════════════════
// USER MENU
// ══════════════════════════════════════════════════
function toggleUserMenu() {
  document.getElementById('userMenu').classList.toggle('hidden');
}

// ══════════════════════════════════════════════════
// IMAGE VIEWER
// ══════════════════════════════════════════════════
function openImageViewer(url) {
  const viewer = document.getElementById('imgViewer');
  document.getElementById('imgViewerSrc').src = url;
  viewer.classList.remove('hidden');
}

function closeImageViewer() {
  document.getElementById('imgViewer').classList.add('hidden');
}

// ══════════════════════════════════════════════════
// SIDEBAR PREVIEW UPDATE
// ══════════════════════════════════════════════════
function updateSidebarPreview(roomId, content, timeDisplay) {
  const chatItem = document.querySelector(`[data-room-id="${roomId}"]`);
  if (!chatItem) return;
  const preview = chatItem.querySelector('.chat-item-preview');
  const timeEl = chatItem.querySelector('.chat-item-time');
  if (preview) preview.textContent = content || '📎 Attachment';
  if (timeEl) timeEl.textContent = timeDisplay;
  // Move to top
  const list = chatItem.parentElement;
  if (list) list.prepend(chatItem);
}

function clearBadge(roomId) {
  const badge = document.getElementById(`badge-${roomId}`);
  if (badge) badge.classList.add('hidden');
}

// ══════════════════════════════════════════════════
// SCROLL
// ══════════════════════════════════════════════════
function scrollToBottom(smooth = false) {
  const area = document.getElementById('messagesArea');
  if (!area) return;
  area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}
