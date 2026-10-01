
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const store = require('./store');
const parser = require('./parser');
const scheduler = require('./scheduler');
const channels = require('./channels');
const telegramPoller = require('./telegram-poller');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- admin sessions (in-memory; re-login after a server restart) -------
const sessions = new Map(); // sid -> { expires }
const ADMIN_COOKIE = 'meow_admin';
const SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function requireAdmin(req, res, next) {
  const sid = getCookie(req, ADMIN_COOKIE);
  const s = sid && sessions.get(sid);
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Not logged in.' });
  next();
}

app.use(express.json());

// Never cache — so design/asset updates show up immediately on refresh.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Admin dashboard page (static; data comes from the protected API below).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ---- API ---------------------------------------------------------------

// Everything the dashboard needs to bootstrap.
// (Public — bot TOKENS are never included, only usernames + links.)
app.get('/api/status', (req, res) => {
  const cfg = store.getConfig();
  const bots = (cfg.telegram.bots || []).map((b) => ({
    id: b.id,
    username: b.username,
    link: b.username ? 'https://t.me/' + b.username : null
  }));
  res.json({
    timezone: cfg.timezone,
    now: new Date().toISOString(),
    channels: channels.status(),
    telegram: {
      bots,
      defaultBotId: cfg.telegram.defaultBotId || null,
      ownerChatId: cfg.telegram.chatId || null
    },
    users: store.getUsers()
  });
});

// List tasks, upcoming first then done.
app.get('/api/tasks', (req, res) => {
  const tasks = store.getTasks();
  const upcoming = tasks
    .filter((t) => !t.done)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const done = tasks
    .filter((t) => t.done)
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  res.json([...upcoming, ...done]);
});

// Create a reminder.
//   { text }           → natural language: "call father tomorrow 9am"
//   { title, dueAt }   → exact: title kept VERBATIM, fire at this exact time
app.post('/api/tasks', async (req, res) => {
  const body = req.body || {};

  if (body.text) {
    const parsed = parser.parseTask(body.text);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const task = {
      id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title: parsed.title,
      dueAt: parsed.dueAt ? parsed.dueAt.toISOString() : null,
      recurring: parsed.recurring || null,
      time: parsed.time || null,
      chatId: body.to ? String(body.to) : null,
      createdAt: new Date().toISOString(),
      done: false
    };
    const tasks = store.getTasks();
    tasks.push(task);
    await store.saveTasks(tasks);
    return res.status(201).json(task);
  }

  if (body.title) {
    const title = String(body.title).trim();
    const dueAt = new Date(body.dueAt);
    if (!title) return res.status(400).json({ error: 'Empty reminder.' });
    if (!body.dueAt || isNaN(dueAt.getTime())) return res.status(400).json({ error: 'Pick a time.' });
    if (dueAt.getTime() <= Date.now()) return res.status(400).json({ error: 'That time is already in the past.' });

    const task = {
      id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title, // exactly as typed
      dueAt: dueAt.toISOString(),
      recurring: null,
      time: null,
      chatId: body.to ? String(body.to) : null,
      createdAt: new Date().toISOString(),
      done: false
    };
    const tasks = store.getTasks();
    tasks.push(task);
    await store.saveTasks(tasks);
    return res.status(201).json(task);
  }

  res.status(400).json({ error: 'Empty reminder.' });
});

// Mark done.
app.post('/api/tasks/:id/done', async (req, res) => {
  const tasks = store.getTasks();
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  t.done = true;
  t.completedAt = new Date().toISOString();
  await store.saveTasks(tasks);
  res.json(t);
});

// Snooze: push the fire time forward by N minutes.
app.post('/api/tasks/:id/snooze', async (req, res) => {
  const minutes = Number(req.body.minutes) || 15;
  const tasks = store.getTasks();
  const t = tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const due = new Date(Date.now() + minutes * 60 * 1000);
  t.dueAt = due.toISOString();
  t.done = false; // revive if it had already fired
  await store.saveTasks(tasks);
  await store.addActivity({
    time: new Date().toISOString(),
    title: 'Snoozed "' + t.title + '" by ' + minutes + ' min',
    via: ['snooze'],
    ok: true
  });
  res.json(t);
});

// Delete.
app.delete('/api/tasks/:id', async (req, res) => {
  const tasks = store.getTasks();
  const next = tasks.filter((x) => x.id !== req.params.id);
  await store.saveTasks(next);
  res.json({ ok: true });
});

// Recent activity feed.
app.get('/api/activity', (req, res) => {
  const list = store.getActivity();
  res.json(list.slice(-50).reverse());
});

// Read/save settings. Bots and users are managed in the Admin page;
// this endpoint only handles timezone + email (so nobody can tamper bots here).
// Admin-only: contains the email app password.
app.get('/api/config', requireAdmin, (req, res) => {
  const cfg = store.getConfig();
  res.json({ timezone: cfg.timezone, email: cfg.email });
});
app.post('/api/config', requireAdmin, async (req, res) => {
  const incoming = req.body || {};
  const current = store.getConfig();
  const next = {
    ...current,
    timezone: incoming.timezone || current.timezone,
    email: { ...current.email, ...(incoming.email || {}) }
  };
  await store.saveConfig(next);
  res.json({ timezone: next.timezone, email: next.email });
});

// ---- enrolled users (the fixed-bot roster) -----------------------------
app.get('/api/users', (req, res) => res.json(store.getUsers()));
// (set-owner / remove-user are admin-only — see the /api/admin routes below.)

// ---- admin (password protected) ----------------------------------------

app.post('/api/admin/login', (req, res) => {
  const pw = String((req.body || {}).password || '');
  const cfg = store.getConfig();
  if (!cfg.admin || !cfg.admin.passwordHash) return res.status(500).json({ error: 'Admin password not set.' });
  if (store.hashPassword(pw) !== cfg.admin.passwordHash) return res.status(401).json({ error: 'Wrong password.' });
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { expires: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', ADMIN_COOKIE + '=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_MS / 1000));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const sid = getCookie(req, ADMIN_COOKIE);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', ADMIN_COOKIE + '=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// Everything the admin page needs.
app.get('/api/admin/state', requireAdmin, (req, res) => {
  const cfg = store.getConfig();
  const bots = (cfg.telegram.bots || []).map((b) => ({
    id: b.id,
    username: b.username,
    link: b.username ? 'https://t.me/' + b.username : null,
    tokenMasked: b.token ? b.token.slice(0, 8) + '…' + b.token.slice(-4) : '',
    isDefault: b.id === cfg.telegram.defaultBotId
  }));
  res.json({
    bots,
    users: store.getUsers(),
    ownerChatId: cfg.telegram.chatId || null,
    defaultBotId: cfg.telegram.defaultBotId || null,
    dataDir: store.getDataDir(),
    db: store.getDatabaseInfo()
  });
});

// Add a bot by token (auto-discovers its @username).
app.post('/api/admin/bots', requireAdmin, async (req, res) => {
  const token = String((req.body || {}).token || '').trim();
  if (!token) return res.status(400).json({ error: 'Paste a bot token from @BotFather.' });
  const cfg = store.getConfig();
  if ((cfg.telegram.bots || []).some((b) => b.token === token)) {
    return res.status(400).json({ error: 'That bot is already added.' });
  }
  let username = null;
  try {
    const me = await telegramPoller.getMe(token);
    username = me && me.result && me.result.username;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid token: ' + (e.message || 'could not reach Telegram') });
  }
  const bot = { id: 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), token, username };
  cfg.telegram.bots = cfg.telegram.bots || [];
  cfg.telegram.bots.push(bot);
  if (!cfg.telegram.defaultBotId) cfg.telegram.defaultBotId = bot.id;
  await store.saveConfig(cfg);
  res.status(201).json({ id: bot.id, username, link: username ? 'https://t.me/' + username : null });
});

// Remove a bot.
app.delete('/api/admin/bots/:id', requireAdmin, async (req, res) => {
  const cfg = store.getConfig();
  cfg.telegram.bots = (cfg.telegram.bots || []).filter((b) => b.id !== req.params.id);
  if (cfg.telegram.defaultBotId === req.params.id) cfg.telegram.defaultBotId = (cfg.telegram.bots[0] || {}).id || null;
  await store.saveConfig(cfg);
  res.json({ ok: true });
});

// Set the default bot (used for "me" and new reminders).
app.post('/api/admin/bots/:id/default', requireAdmin, async (req, res) => {
  const cfg = store.getConfig();
  if (!(cfg.telegram.bots || []).some((b) => b.id === req.params.id)) return res.status(404).json({ error: 'Bot not found.' });
  cfg.telegram.defaultBotId = req.params.id;
  await store.saveConfig(cfg);
  res.json({ ok: true });
});

// Remove an enrolled user (admin).
app.delete('/api/admin/users/:chatId', requireAdmin, async (req, res) => {
  const id = String(req.params.chatId);
  await store.saveUsers(store.getUsers().filter((u) => String(u.chatId) !== id));
  res.json({ ok: true });
});

// Mark one enrolled user as "me" (the owner) — admin only.
app.post('/api/admin/users/:chatId/owner', requireAdmin, async (req, res) => {
  const cfg = store.getConfig();
  cfg.telegram.chatId = String(req.params.chatId);
  await store.saveConfig(cfg);
  res.json({ ok: true });
});

// Change the admin password.
app.post('/api/admin/password', requireAdmin, async (req, res) => {
  const { current, next } = req.body || {};
  const cfg = store.getConfig();
  if (store.hashPassword(String(current || '')) !== cfg.admin.passwordHash) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  if (!next || String(next).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  cfg.admin.passwordHash = store.hashPassword(String(next));
  await store.saveConfig(cfg);
  res.json({ ok: true });
});

// Connect (a new) database. Admin only.
app.post('/api/admin/mongo', requireAdmin, async (req, res) => {
  try {
    const info = await store.setDatabase(String((req.body || {}).uri || ''));
    res.json({ ok: true, db: info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Send a test notification through one channel (admin only — otherwise anyone
// could spam test messages to Telegram/email).
app.post('/api/test/:channel', requireAdmin, async (req, res) => {
  try {
    const name = await channels.test(req.params.channel, req.body.text);
    res.json({ ok: true, message: 'Test sent via ' + name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- start -------------------------------------------------------------
// Boot the data layer (loads local files, then connects the database if one
// is configured) BEFORE the scheduler and bot listener start.
(async () => {
  try {
    await store.initStore();
  } catch (e) {
    console.error('[meow] failed to initialise data store:', e);
    process.exit(1);
  }
  scheduler.start();
  telegramPoller.start();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('MEOW running at http://localhost:' + PORT);
  });
})();
