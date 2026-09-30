// ==============================================================
// منطق فرانت‌اند پیام‌رسان «هم‌صحبت»
// ==============================================================

(function () {
  'use strict';

  // متغیرهای وضعیت کلاینت
  let currentUser = null;
  let token = localStorage.getItem('hamsohbat_token') || null;
  let socket = null;
  let usersList = [];
  let onlineUserIds = new Set();
  let activeChatUserId = null;
  let typingTimeout = null;
  let isCurrentlyTyping = false;

  // المان‌های DOM
  const authSection = document.getElementById('authSection');
  const chatSection = document.getElementById('chatSection');
  const tabLoginBtn = document.getElementById('tabLoginBtn');
  const tabRegisterBtn = document.getElementById('tabRegisterBtn');
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const authAlert = document.getElementById('authAlert');

  const myAvatarLetter = document.getElementById('myAvatarLetter');
  const myDisplayName = document.getElementById('myDisplayName');
  const myUsername = document.getElementById('myUsername');
  const logoutBtn = document.getElementById('logoutBtn');
  const userSearchInput = document.getElementById('userSearchInput');
  const usersCountBadge = document.getElementById('usersCountBadge');
  const usersListContainer = document.getElementById('usersList');

  const emptyChatView = document.getElementById('emptyChatView');
  const activeChatView = document.getElementById('activeChatView');
  const backToListBtn = document.getElementById('backToListBtn');
  const activeUserAvatar = document.getElementById('activeUserAvatar');
  const activeUserName = document.getElementById('activeUserName');
  const activeStatusDot = document.getElementById('activeStatusDot');
  const activeStatusLabel = document.getElementById('activeStatusLabel');
  const messagesContainer = document.getElementById('messagesContainer');
  const typingIndicator = document.getElementById('typingIndicator');
  const typingIndicatorText = document.getElementById('typingIndicatorText');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const sidebar = document.getElementById('sidebar');
  const chatMain = document.getElementById('chatMain');

  // -------------------------------------------------------------
  // توابع کمکی و امنیتی
  // -------------------------------------------------------------
  function showAlert(message, type = 'error') {
    authAlert.textContent = message;
    authAlert.className = `auth-alert ${type}`;
    authAlert.classList.remove('hidden');
  }

  function hideAlert() {
    authAlert.classList.add('hidden');
    authAlert.textContent = '';
  }

  function formatTime(isoString) {
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------
  // تب‌های احراز هویت
  // -------------------------------------------------------------
  tabLoginBtn.addEventListener('click', () => {
    tabLoginBtn.classList.add('active');
    tabRegisterBtn.classList.remove('active');
    loginForm.classList.remove('hidden');
    registerForm.classList.add('hidden');
    hideAlert();
  });

  tabRegisterBtn.addEventListener('click', () => {
    tabRegisterBtn.classList.add('active');
    tabLoginBtn.classList.remove('active');
    registerForm.classList.remove('hidden');
    loginForm.classList.add('hidden');
    hideAlert();
  });

  // -------------------------------------------------------------
  // فرایند لاگین و ثبت‌نام
  // -------------------------------------------------------------
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        return showAlert(data.error || 'خطا در ورود به حساب.');
      }

      setSession(data.token, data.user);
    } catch (err) {
      showAlert('عدم برقراری ارتباط با سرور. لطفا اتصال خود را بررسی نمایید.');
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const displayName = document.getElementById('regDisplayName').value.trim();
    const username = document.getElementById('regUsername').value.trim();
    const password = document.getElementById('regPassword').value;

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName, username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        return showAlert(data.error || 'خطا در ثبت‌نام.');
      }

      setSession(data.token, data.user);
    } catch (err) {
      showAlert('عدم برقراری ارتباط با سرور.');
    }
  });

  function setSession(newToken, user) {
    token = newToken;
    currentUser = user;
    localStorage.setItem('hamsohbat_token', token);
    initApp();
  }

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('hamsohbat_token');
    token = null;
    currentUser = null;
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    showAuth();
  });

  function showAuth() {
    authSection.classList.remove('hidden');
    chatSection.classList.add('hidden');
  }

  function showChat() {
    authSection.classList.add('hidden');
    chatSection.classList.remove('hidden');
  }

  // -------------------------------------------------------------
  // راه‌اندازی و بررسی توکن
  // -------------------------------------------------------------
  async function checkAuth() {
    if (!token) {
      showAuth();
      return;
    }

    try {
      const res = await fetch('/api/me', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        currentUser = data.user;
        initApp();
      } else {
        localStorage.removeItem('hamsohbat_token');
        showAuth();
      }
    } catch (err) {
      localStorage.removeItem('hamsohbat_token');
      showAuth();
    }
  }

  function initApp() {
    showChat();
    myDisplayName.textContent = currentUser.displayName || currentUser.username;
    myUsername.textContent = '@' + currentUser.username;
    myAvatarLetter.textContent = (currentUser.displayName || currentUser.username)[0].toUpperCase();

    initSocket();
    loadUsers();
  }

  // -------------------------------------------------------------
  // ارتباط زنده با Socket.IO
  // -------------------------------------------------------------
  function initSocket() {
    if (socket) socket.disconnect();

    socket = io({
      auth: { token }
    });

    socket.on('connect', () => {
      console.log('✅ اتصال سوکت با موفقیت برقرار شد.');
    });

    socket.on('online_users_list', (data) => {
      onlineUserIds = new Set(data.onlineUserIds.map(Number));
      renderUsersList();
      updateActiveUserStatus();
    });

    socket.on('user_status', (data) => {
      const uId = Number(data.userId);
      if (data.status === 'online') {
        onlineUserIds.add(uId);
      } else {
        onlineUserIds.delete(uId);
      }
      renderUsersList();
      updateActiveUserStatus();
    });

    // دریافت پیام زنده
    socket.on('new_message', (msg) => {
      const senderId = Number(msg.senderId);
      const receiverId = Number(msg.receiverId);

      // اگر گفت‌وگو با همین کاربر باز است
      if (activeChatUserId && (activeChatUserId === senderId || (senderId === currentUser.id && receiverId === activeChatUserId))) {
        appendMessageElement(msg);
        scrollToBottom();
      } else {
        // اعلان بصری یا صوتی کوتاه برای سایر چت‌ها
        highlightUserUnread(senderId);
      }
    });

    // وضعیت تایپ
    socket.on('user_typing', (data) => {
      if (activeChatUserId && Number(data.userId) === activeChatUserId) {
        if (data.isTyping) {
          const activeUser = usersList.find(u => u.id === activeChatUserId);
          const name = activeUser ? activeUser.displayName : 'مخاطب';
          typingIndicatorText.textContent = `${name} در حال نوشتن...`;
          typingIndicator.classList.remove('hidden');
        } else {
          typingIndicator.classList.add('hidden');
        }
      }
    });
  }

  function highlightUserUnread(userId) {
    const user = usersList.find(u => u.id === userId);
    if (user) {
      user.hasUnread = (user.hasUnread || 0) + 1;
      renderUsersList();
    }
  }

  // -------------------------------------------------------------
  // بارگذاری و نمایش لیست کاربران
  // -------------------------------------------------------------
  async function loadUsers() {
    try {
      const res = await fetch('/api/users', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      usersList = data.users || [];
      renderUsersList();
    } catch (err) {
      console.error('خطا در دریافت کاربران:', err);
    }
  }

  function renderUsersList() {
    const searchTerm = userSearchInput.value.trim().toLowerCase();
    const filtered = usersList.filter(u => 
      u.displayName.toLowerCase().includes(searchTerm) || 
      u.username.toLowerCase().includes(searchTerm)
    );

    usersCountBadge.textContent = filtered.length.toLocaleString('fa-IR');
    usersListContainer.innerHTML = '';

    if (filtered.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty-state-small';
      emptyDiv.textContent = 'کاربری یافت نشد.';
      usersListContainer.appendChild(emptyDiv);
      return;
    }

    filtered.forEach(user => {
      const isOnline = onlineUserIds.has(Number(user.id));
      const isActive = activeChatUserId === user.id;

      const item = document.createElement('div');
      item.className = `user-item ${isActive ? 'active' : ''}`;
      item.addEventListener('click', () => selectUser(user));

      // آواتار
      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'user-avatar-wrap';

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = (user.displayName || user.username)[0].toUpperCase();

      const badge = document.createElement('span');
      badge.className = `status-badge ${isOnline ? 'online' : ''}`;

      avatarWrap.appendChild(avatar);
      avatarWrap.appendChild(badge);

      // متادیتا
      const meta = document.createElement('div');
      meta.className = 'user-meta';

      const topRow = document.createElement('div');
      topRow.className = 'user-meta-top';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'user-display-name';
      nameSpan.textContent = user.displayName;

      topRow.appendChild(nameSpan);

      if (user.hasUnread && !isActive) {
        const unreadBadge = document.createElement('span');
        unreadBadge.className = 'unread-pill';
        unreadBadge.textContent = 'جدید';
        topRow.appendChild(unreadBadge);
      }

      const handleSpan = document.createElement('div');
      handleSpan.className = 'user-handle';
      handleSpan.textContent = '@' + user.username;

      meta.appendChild(topRow);
      meta.appendChild(handleSpan);

      item.appendChild(avatarWrap);
      item.appendChild(meta);
      usersListContainer.appendChild(item);
    });
  }

  userSearchInput.addEventListener('input', renderUsersList);

  // -------------------------------------------------------------
  // انتخاب کاربر برای گفت‌وگو
  // -------------------------------------------------------------
  async function selectUser(user) {
    activeChatUserId = user.id;
    user.hasUnread = 0;

    renderUsersList();
    emptyChatView.classList.add('hidden');
    activeChatView.classList.remove('hidden');

    activeUserName.textContent = user.displayName;
    activeUserAvatar.textContent = (user.displayName || user.username)[0].toUpperCase();
    updateActiveUserStatus();

    // برای نمای موبایل
    if (window.innerWidth <= 768) {
      sidebar.classList.add('mobile-hidden');
      chatMain.classList.remove('mobile-hidden');
    }

    // بارگذاری تاریخچه پیام‌ها
    await loadMessages(user.id);
    messageInput.focus();
  }

  function updateActiveUserStatus() {
    if (!activeChatUserId) return;
    const isOnline = onlineUserIds.has(Number(activeChatUserId));
    if (isOnline) {
      activeStatusDot.className = 'status-dot online';
      activeStatusLabel.textContent = 'آنلاین';
    } else {
      activeStatusDot.className = 'status-dot offline';
      activeStatusLabel.textContent = 'آفلاین';
    }
  }

  // دکمه بازگشت در موبایل
  backToListBtn.addEventListener('click', () => {
    sidebar.classList.remove('mobile-hidden');
    chatMain.classList.add('mobile-hidden');
  });

  // -------------------------------------------------------------
  // بارگذاری و نمایش پیام‌ها (امن بدون innerHTML برای متن پیام)
  // -------------------------------------------------------------
  async function loadMessages(targetUserId) {
    messagesContainer.innerHTML = '';
    typingIndicator.classList.add('hidden');

    try {
      const res = await fetch(`/api/messages/${targetUserId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return;

      const data = await res.json();
      const messages = data.messages || [];

      if (messages.length === 0) {
        const welcome = document.createElement('div');
        welcome.className = 'empty-state-small';
        welcome.textContent = 'هنوز پیامی رد و بدل نشده است. اولین پیام را شما ارسال کنید!';
        messagesContainer.appendChild(welcome);
      } else {
        messages.forEach(msg => appendMessageElement(msg));
      }
      scrollToBottom();
    } catch (err) {
      console.error('خطا در بارگذاری پیام‌ها:', err);
    }
  }

  function appendMessageElement(msg) {
    // پاک کردن پیام خالی اولیه در صورت وجود
    const emptyNotice = messagesContainer.querySelector('.empty-state-small');
    if (emptyNotice) emptyNotice.remove();

    const isOutgoing = Number(msg.senderId) === Number(currentUser.id);

    const row = document.createElement('div');
    row.className = `message-row ${isOutgoing ? 'outgoing' : 'incoming'}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = msg.content; // ایمن در برابر XSS

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatTime(msg.createdAt);

    row.appendChild(bubble);
    row.appendChild(time);
    messagesContainer.appendChild(row);
  }

  function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // -------------------------------------------------------------
  // ارسال پیام و رویدادهای تایپ
  // -------------------------------------------------------------
  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else {
      handleTypingNotification();
    }
  });

  function handleTypingNotification() {
    if (!socket || !activeChatUserId) return;

    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      socket.emit('typing_start', { receiverId: activeChatUserId });
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isCurrentlyTyping = false;
      socket.emit('typing_stop', { receiverId: activeChatUserId });
    }, 1500);
  }

  function sendMessage() {
    const content = messageInput.value.trim();
    if (!content || !activeChatUserId || !socket) return;

    messageInput.value = '';
    messageInput.style.height = 'auto';

    if (isCurrentlyTyping) {
      isCurrentlyTyping = false;
      socket.emit('typing_stop', { receiverId: activeChatUserId });
    }

    socket.emit('private_message', {
      receiverId: activeChatUserId,
      content
    }, (response) => {
      if (response && response.success) {
        appendMessageElement(response.message);
        scrollToBottom();
      } else if (response && response.error) {
        alert(response.error);
      }
    });
  }

  // تغییر خودکار ارتفاع تکست‌اریا
  messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });

  // اجرای اولیه
  checkAuth();
})();
