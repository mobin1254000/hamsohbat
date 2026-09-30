require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'hamsohbat_dev_secret_key_987654321';
const DATABASE_URL = process.env.DATABASE_URL;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// -------------------------------------------------------------
// لایه ذخیره‌سازی داده‌ها (PostgreSQL یا حافظه موقت RAM)
// -------------------------------------------------------------
let dbMode = 'memory';
let pool = null;

// حافظه موقت در صورت نبود دیتابیس
const memoryUsers = []; // { id, username, displayName, passwordHash, createdAt }
const memoryMessages = []; // { id, senderId, receiverId, content, createdAt }
let userAutoId = 1;
let messageAutoId = 1;

async function initDatabase() {
  if (DATABASE_URL) {
    try {
      const isSsl = DATABASE_URL.includes('sslmode=require') || !DATABASE_URL.includes('localhost');
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: isSsl ? { rejectUnauthorized: false } : false
      });

      // تست اتصال
      const client = await pool.connect();
      
      // ساخت جداول در صورت عدم وجود
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(50) UNIQUE NOT NULL,
          display_name VARCHAR(100) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id);
      `);

      client.release();
      dbMode = 'postgres';
      console.log('✅ اتصال به پایگاه‌داده PostgreSQL با موفقیت برقرار شد و جداول آماده هستند.');
    } catch (err) {
      console.error('⚠️ خطا در اتصال به دیتابیس PostgreSQL! برنامه با حافظه موقت (RAM) اجرا می‌شود.', err.message);
      dbMode = 'memory';
    }
  } else {
    console.log('ℹ️ متغیر DATABASE_URL یافت نشد. برنامه در حالت حافظه موقت (Memory Mode) اجرا می‌شود.');
    console.log('⚠️ توجه: با ری‌استارت شدن سرور، پیام‌ها و کاربران پاک خواهند شد.');
  }
}

// -------------------------------------------------------------
// توابع کمکی دسترسی به داده‌ها (DAO)
// -------------------------------------------------------------
async function findUserByUsername(username) {
  const cleanUsername = username.trim().toLowerCase();
  if (dbMode === 'postgres') {
    const res = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [cleanUsername]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      passwordHash: r.password_hash,
      createdAt: r.created_at
    };
  } else {
    return memoryUsers.find(u => u.username.toLowerCase() === cleanUsername) || null;
  }
}

async function findUserById(id) {
  const userId = parseInt(id, 10);
  if (isNaN(userId)) return null;

  if (dbMode === 'postgres') {
    const res = await pool.query('SELECT id, username, display_name, created_at FROM users WHERE id = $1', [userId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at
    };
  } else {
    const u = memoryUsers.find(u => u.id === userId);
    if (!u) return null;
    return {
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      createdAt: u.createdAt
    };
  }
}

async function createUser(username, displayName, passwordHash) {
  const cleanUsername = username.trim().toLowerCase();
  const cleanDisplay = displayName.trim() || cleanUsername;

  if (dbMode === 'postgres') {
    const res = await pool.query(
      'INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, username, display_name, created_at',
      [cleanUsername, cleanDisplay, passwordHash]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at
    };
  } else {
    const newUser = {
      id: userAutoId++,
      username: cleanUsername,
      displayName: cleanDisplay,
      passwordHash,
      createdAt: new Date()
    };
    memoryUsers.push(newUser);
    return {
      id: newUser.id,
      username: newUser.username,
      displayName: newUser.displayName,
      createdAt: newUser.createdAt
    };
  }
}

async function getAllOtherUsers(currentUserId) {
  const currentId = parseInt(currentUserId, 10);
  if (dbMode === 'postgres') {
    const res = await pool.query(
      'SELECT id, username, display_name, created_at FROM users WHERE id != $1 ORDER BY id DESC',
      [currentId]
    );
    return res.rows.map(r => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at
    }));
  } else {
    return memoryUsers
      .filter(u => u.id !== currentId)
      .map(u => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        createdAt: u.createdAt
      }));
  }
}

async function saveMessage(senderId, receiverId, content) {
  const sId = parseInt(senderId, 10);
  const rId = parseInt(receiverId, 10);
  const cleanContent = content.trim();

  if (dbMode === 'postgres') {
    const res = await pool.query(
      'INSERT INTO messages (sender_id, receiver_id, content) VALUES ($1, $2, $3) RETURNING id, sender_id, receiver_id, content, created_at',
      [sId, rId, cleanContent]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      senderId: r.sender_id,
      receiverId: r.receiver_id,
      content: r.content,
      createdAt: r.created_at
    };
  } else {
    const msg = {
      id: messageAutoId++,
      senderId: sId,
      receiverId: rId,
      content: cleanContent,
      createdAt: new Date()
    };
    memoryMessages.push(msg);
    return msg;
  }
}

async function getConversation(user1Id, user2Id) {
  const u1 = parseInt(user1Id, 10);
  const u2 = parseInt(user2Id, 10);

  if (dbMode === 'postgres') {
    const res = await pool.query(
      `SELECT id, sender_id, receiver_id, content, created_at 
       FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) 
          OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at ASC`,
      [u1, u2]
    );
    return res.rows.map(r => ({
      id: r.id,
      senderId: r.sender_id,
      receiverId: r.receiver_id,
      content: r.content,
      createdAt: r.created_at
    }));
  } else {
    return memoryMessages
      .filter(m => (m.senderId === u1 && m.receiverId === u2) || (m.senderId === u2 && m.receiverId === u1))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
}

// -------------------------------------------------------------
// میدل‌ور احراز هویت توکن JWT
// -------------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'توکن دسترسی ارسال نشده است یا نامعتبر است.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'توکن نامعتبر یا منقضی شده است. لطفا مجدد وارد شوید.' });
  }
}

// -------------------------------------------------------------
// مسیرهای API
// -------------------------------------------------------------

// وضعیت سرور
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    appName: 'هم‌صحبت',
    dbMode,
    timestamp: new Date().toISOString()
  });
});

// ثبت نام
app.post('/api/register', async (req, res) => {
  try {
    const { username, displayName, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ error: 'نام کاربری باید حداقل ۳ کاراکتر باشد.' });
    }
    if (username.trim().length > 30) {
      return res.status(400).json({ error: 'نام کاربری نمی‌تواند بیش از ۳۰ کاراکتر باشد.' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) {
      return res.status(400).json({ error: 'نام کاربری فقط می‌تواند شامل حروف انگلیسی، اعداد و خط زیر (_) باشد.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'رمز عبور باید حداقل ۶ کاراکتر باشد.' });
    }
    if (password.length > 64) {
      return res.status(400).json({ error: 'رمز عبور بسیار طولانی است.' });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ error: 'این نام کاربری قبلاً توسط کاربر دیگری ثبت شده است.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const safeDisplayName = (displayName && displayName.trim()) ? displayName.trim().slice(0, 50) : username.trim();
    const newUser = await createUser(username, safeDisplayName, passwordHash);

    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, displayName: newUser.displayName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'ثبت‌نام با موفقیت انجام شد.',
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        displayName: newUser.displayName,
        createdAt: newUser.createdAt
      }
    });
  } catch (err) {
    console.error('خطا در ثبت نام:', err);
    return res.status(500).json({ error: 'خطای غیرمنتظره در سرور رخ داد.' });
  }
});

// ورود
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'لطفاً نام کاربری و رمز عبور را وارد کنید.' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'نام کاربری یا رمز عبور اشتباه است.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, displayName: user.displayName },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'با موفقیت وارد شدید.',
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error('خطا در ورود:', err);
    return res.status(500).json({ error: 'خطای سرور در فرایند ورود.' });
  }
});

// اطلاعات کاربر جاری
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'کاربر پیدا نشد.' });
    }
    return res.json({ user });
  } catch (err) {
    console.error('خطا در api/me:', err);
    return res.status(500).json({ error: 'خطای سرور در بازیابی اطلاعات کاربر.' });
  }
});

// لیست سایر کاربران
app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const users = await getAllOtherUsers(req.user.id);
    return res.json({ users });
  } catch (err) {
    console.error('خطا در دریافت لیست کاربران:', err);
    return res.status(500).json({ error: 'خطا در بازیابی لیست کاربران.' });
  }
});

// دریافت تاریخچه پیام‌ها با یک مخاطب
app.get('/api/messages/:userId', authMiddleware, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'شناسه مخاطب نامعتبر است.' });
    }

    const targetUser = await findUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: 'مخاطب مورد نظر پیدا نشد.' });
    }

    const messages = await getConversation(req.user.id, targetUserId);
    return res.json({ messages });
  } catch (err) {
    console.error('خطا در دریافت پیام‌ها:', err);
    return res.status(500).json({ error: 'خطا در خواندن پیام‌ها.' });
  }
});

// -------------------------------------------------------------
// مدیریت بلادرنگ و سوکت‌ها (Socket.IO)
// -------------------------------------------------------------
// نگهداری وضعیت کاربران آنلاین: userId -> Set of socketIds
const onlineUsers = new Map();

// میدل‌ور احراز هویت سوکت
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('احراز هویت انجام نشد. توکن ارسال نشده است.'));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    return next(new Error('توکن نامعتبر یا منقضی شده است.'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.user.id;
  
  // ثبت کاربر در لیست آنلاین‌ها
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }
  onlineUsers.get(userId).add(socket.id);

  // عضویت در اتاق اختصاصی کاربر (جهت ارسال پیام مستقیم)
  socket.join(`user_${userId}`);

  // اطلاع‌رسانی آنلاین بودن به همه
  io.emit('user_status', {
    userId,
    status: 'online',
    onlineUserIds: Array.from(onlineUsers.keys())
  });

  // ارسال لیست کاربران آنلاین به کاربر تازه وصل شده
  socket.emit('online_users_list', {
    onlineUserIds: Array.from(onlineUsers.keys())
  });

  // ارسال پیام متنی خصوصی
  socket.on('private_message', async (data, callback) => {
    try {
      const { receiverId, content } = data;
      const rId = parseInt(receiverId, 10);
      const cleanText = (content || '').trim();

      if (!rId || isNaN(rId)) {
        if (typeof callback === 'function') callback({ success: false, error: 'شناسه گیرنده نامعتبر است.' });
        return;
      }
      if (!cleanText) {
        if (typeof callback === 'function') callback({ success: false, error: 'متن پیام نمی‌تواند خالی باشد.' });
        return;
      }
      if (cleanText.length > 2000) {
        if (typeof callback === 'function') callback({ success: false, error: 'حداکثر طول پیام ۲۰۰۰ کاراکتر است.' });
        return;
      }

      // ذخیره در دیتابیس یا حافظه
      const savedMsg = await saveMessage(userId, rId, cleanText);

      const messagePayload = {
        id: savedMsg.id,
        senderId: savedMsg.senderId,
        receiverId: savedMsg.receiverId,
        content: savedMsg.content,
        createdAt: savedMsg.createdAt,
        senderName: socket.user.displayName || socket.user.username
      };

      // ارسال به گیرنده
      io.to(`user_${rId}`).emit('new_message', messagePayload);
      
      // ارسال به سایر تب‌های خود فرستنده (در صورت وجود)
      socket.to(`user_${userId}`).emit('new_message', messagePayload);

      if (typeof callback === 'function') {
        callback({ success: true, message: messagePayload });
      }
    } catch (err) {
      console.error('خطا در پردازش پیام سوکت:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'خطا در ثبت پیام.' });
    }
  });

  // اطلاع‌رسانی وضعیت تایپ (Typing)
  socket.on('typing_start', ({ receiverId }) => {
    const rId = parseInt(receiverId, 10);
    if (rId) {
      io.to(`user_${rId}`).emit('user_typing', {
        userId,
        isTyping: true
      });
    }
  });

  socket.on('typing_stop', ({ receiverId }) => {
    const rId = parseInt(receiverId, 10);
    if (rId) {
      io.to(`user_${rId}`).emit('user_typing', {
        userId,
        isTyping: false
      });
    }
  });

  // قطع اتصال
  socket.on('disconnect', () => {
    if (onlineUsers.has(userId)) {
      const userSockets = onlineUsers.get(userId);
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(userId);
        io.emit('user_status', {
          userId,
          status: 'offline',
          onlineUserIds: Array.from(onlineUsers.keys())
        });
      }
    }
  });
});

// راه‌اندازی سرور
initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 سرور پیام‌رسان «هم‌صحبت» روی پورت ${PORT} آماده پاسخگویی است.`);
    console.log(`🔗 آدرس محلی: http://localhost:${PORT}`);
  });
});
