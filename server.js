// server.js — the web server + API.
// Run with:  npm start   (then open http://localhost:3000)

// Fix the timezone BEFORE anything creates a Date, so "tomorrow 9am" is
// interpreted in your local time. Change this (or set the TZ env var) to
// match where the server actually runs.
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

// Wrap async handlers so a rejected promise becomes a 500 response instead of
// crashing the whole process (Express 4 does not catch throws inside async
// handlers, and an unhandled rejection would take the site down with it).
function ah(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[meow] request handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on my side — try again.' });
    });
  };
}

// Last line of defence: if any error still slips past every handler above,
// log it loudly but keep the process (and the site) alive rather than dying.
process.on('uncaughtException', (err) => {
  console.error('[meow] uncaught exception (process kept alive):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[meow] unhandled rejection (process kept alive):', err);
});

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

// ---- per-browser identity ----------------------------------------------
// Each browser that completes the Telegram "GET THE MEOW" handoff gets a
// signed cookie identifying its person. "Me" is therefore per-browser, and
// every visitor only ever sees/changes their own reminders.
const MEOW_COOKIE = 'meow_uid';
const HANDOFF_COOKIE = 'meow_handoff';
const IDENTITY_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

function currentIdentity(req) {
  const tok = getCookie(req, MEOW_COOKIE);
  if (!tok) return null;
  const chatId = store.verifyUserToken(tok);
  if (!chatId) return null;
  return store.findUserByChatId(chatId) || null;
}

function publicUser(u) {
  return {
    chatId: String(u.chatId),
    username: u.username || null,
    firstName: u.firstName || null,
    name: u.username ? '@' + u.username : (u.firstName || 'friend')
  };
}

// Only the owner of a task may read or modify it.
function ownedTask(req, id) {
  if (!req.meowUser) return null;
  const t = store.getTasks().find((x) => x.id === id);
  if (!t) return null;
  const owner = String(t.ownerChatId || t.chatId || '');
  if (owner !== String(req.meowUser.chatId)) return null;
  return t;
}

app.use(express.json());

// Attach the signed-identity user (if any) to every request.
app.use((req, res, next) => {
  req.meowUser = currentIdentity(req);
  next();
});

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
// Private by design: only "you" (this browser's identity) — never other
// people's names or reminders. Bot tokens are never included, only the
// public @username needed for the enroll link.
// Health endpoint — probed by the container's HEALTHCHECK and uptime checks.
app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), now: new Date().toISOString() });
});

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
    you: req.meowUser ? publicUser(req.meowUser) : null,
    telegram: {
      bots,
      defaultBotId: cfg.telegram.defaultBotId || null
    }
  });
});

// List tasks — ONLY this browser's own reminders, upcoming first then done.
app.get('/api/tasks', (req, res) => {
  const all = store.getTasks();
  const mine = req.meowUser
    ? all.filter((t) => String(t.ownerChatId || t.chatId || '') === String(req.meowUser.chatId))
    : [];
  const upcoming = mine
    .filter((t) => !t.done)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const done = mine
    .filter((t) => t.done)
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  res.json([...upcoming, ...done]);
});

// Create a reminder — always for THIS browser's person (never for someone
// else). There is deliberately no "send to" here.
//   { text }                    → natural language: "call father tomorrow 9am"
//   { title, dueAt }            → exact: title kept VERBATIM, fire at this exact time
//   { title, recurring, time }  → repeat: title VERBATIM, fires again on the
//                                 schedule (from the 🔁 REPEAT panel)
app.post('/api/tasks', ah(async (req, res) => {
  if (!req.meowUser) {
    return res.status(401).json({ error: 'Link your meow first — press 🐾 GET THE MEOW and tap Start in Telegram.' });
  }
  const me = String(req.meowUser.chatId);
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
      ownerChatId: me,
      chatId: me, // delivery target = the owner (kept for the channel layer)
      createdAt: new Date().toISOString(),
      done: false
    };
    const tasks = store.getTasks();
    tasks.push(task);
    await store.saveTasks(tasks);
    return res.status(201).json(task);
  }

  // Repeat: "water plants" every day at 9:00, "standup" every weekday at 9:30…
  // dueAt is computed server-side with the same rule the parser uses, so the
  // chip path and the "every day 9am …" text path stay in lockstep.
  if (body.title && body.recurring) {
    const title = String(body.title).trim();
    const rec = body.recurring || {};
    const rt = body.time || {};
    if (!title) return res.status(400).json({ error: 'Empty reminder.' });
    const recOk =
      rec.type === 'daily' || rec.type === 'weekdays' || rec.type === 'weekends' ||
      (rec.type === 'weekly' && Number.isInteger(rec.day) && rec.day >= 0 && rec.day <= 6);
    const timeOk =
      Number.isInteger(rt.h) && Number.isInteger(rt.m) &&
      rt.h >= 0 && rt.h <= 23 && rt.m >= 0 && rt.m <= 59;
    if (!recOk) return res.status(400).json({ error: 'That repeat schedule looks off.' });
    if (!timeOk) return res.status(400).json({ error: 'Pick a time for the repeat.' });

    const recurring = rec.type === 'weekly' ? { type: 'weekly', day: rec.day } : { type: rec.type };
    const time = { h: rt.h, m: rt.m };
    const dueAt = parser.nextOccurrence(recurring, time, new Date());

    const task = {
      id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title, // exactly as typed
      dueAt: dueAt.toISOString(),
      recurring,
      time,
      ownerChatId: me,
      chatId: me,
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
      ownerChatId: me,
      chatId: me,
      createdAt: new Date().toISOString(),
      done: false
    };
    const tasks = store.getTasks();
    tasks.push(task);
    await store.saveTasks(tasks);
    return res.status(201).json(task);
  }

  res.status(400).json({ error: 'Empty reminder.' });
}));

// Mark done — own tasks only.
app.post('/api/tasks/:id/done', ah(async (req, res) => {
  const t = ownedTask(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.recurring && t.time) {
    // "Done" on a repeat = this round is finished. Roll it to its next
    // occurrence and keep it active, so it goes back to the schedule
    // instead of retiring.
    const next = parser.nextOccurrence(t.recurring, t.time, new Date());
    t.dueAt = next.toISOString();
    t.done = false;
  } else {
    t.done = true;
    t.completedAt = new Date().toISOString();
  }
  await store.saveTasks(store.getTasks());
  res.json(t);
}));

// Snooze — own tasks only.
app.post('/api/tasks/:id/snooze', ah(async (req, res) => {
  const minutes = Number(req.body.minutes) || 15;
  const t = ownedTask(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const due = new Date(Date.now() + minutes * 60 * 1000);
  t.dueAt = due.toISOString();
  t.done = false; // revive if it had already fired
  await store.saveTasks(store.getTasks());
  await store.addActivity({
    time: new Date().toISOString(),
    title: 'Snoozed "' + t.title + '" by ' + minutes + ' min',
    via: ['snooze'],
    ok: true,
    ownerChatId: req.meowUser ? String(req.meowUser.chatId) : null
  });
  res.json(t);
}));

// Delete — own tasks only.
app.delete('/api/tasks/:id', ah(async (req, res) => {
  const t = ownedTask(req, req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  await store.saveTasks(store.getTasks().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
}));

// Recent activity feed — only this browser's own events.
app.get('/api/activity', (req, res) => {
  const legacyOwner = store.getConfig().telegram.chatId || null;
  const me = req.meowUser ? String(req.meowUser.chatId) : null;
  const list = store.getActivity().filter((a) => {
    const owner = a.ownerChatId || legacyOwner || null; // pre-ownership entries → old owner
    return me && owner === me;
  });
  res.json(list.slice(-50).reverse());
});

// ---- per-browser enrollment ("GET THE MEOW") ----------------------------
// Visitor clicks the paw → we store a one-time code (cookie on THIS browser)
// and hand back a Telegram deep link t.me/<bot>?start=<code>. When their
// /start (or a message containing the code) arrives, the poller matches the
// code to their chat. This browser then picks up a signed identity cookie —
// from now on, "me" in this browser is that person. Nobody else's browser is
// affected, and no roster is ever exposed.

app.post('/api/enroll', ah(async (req, res) => {
  const cfg = store.getConfig();
  const bots = cfg.telegram.bots || [];
  const def = bots.find((b) => b.id === cfg.telegram.defaultBotId) || bots[0];
  if (!def || !def.username) {
    return res.status(400).json({ error: 'No bot is set up yet — an admin needs to add one first.' });
  }
  const code = store.randomHandoffCode();
  await store.createHandoff({
    code,
    botId: def.id,
    chatId: null,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + store.HANDOFF_TTL_MS
  });
  res.setHeader('Set-Cookie', HANDOFF_COOKIE + '=' + code + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(store.HANDOFF_TTL_MS / 1000));
  res.json({ code, botLink: 'https://t.me/' + def.username + '?start=' + code });
}));

// Polled by the browser while waiting; issues the identity cookie on match.
app.get('/api/enroll/status', ah(async (req, res) => {
  const code = getCookie(req, HANDOFF_COOKIE);
  if (!code) return res.json({ state: 'none' });
  const h = store.findHandoff(code);
  if (!h) {
    res.setHeader('Set-Cookie', HANDOFF_COOKIE + '=; Path=/; Max-Age=0');
    return res.json({ state: 'expired' });
  }
  if (!h.chatId) return res.json({ state: 'waiting' });
  const u = store.findUserByChatId(h.chatId);
  await store.deleteHandoff(code);
  res.append('Set-Cookie', MEOW_COOKIE + '=' + store.signUserToken(h.chatId) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + IDENTITY_MAX_AGE);
  res.append('Set-Cookie', HANDOFF_COOKIE + '=; Path=/; Max-Age=0');
  res.json({ state: 'linked', you: u ? publicUser(u) : null });
}));

// Unlink this browser (also "switch account" — enroll again to re-link).
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', MEOW_COOKIE + '=; Path=/; Max-Age=0');
  res.setHeader('Set-Cookie', HANDOFF_COOKIE + '=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Read/save settings. Bots and users are managed in the Admin page;
// this endpoint only handles timezone + email (so nobody can tamper bots here).
// Admin-only: contains the email app password.
app.get('/api/config', requireAdmin, (req, res) => {
  const cfg = store.getConfig();
  res.json({ timezone: cfg.timezone, email: cfg.email });
});
app.post('/api/config', requireAdmin, ah(async (req, res) => {
  const incoming = req.body || {};
  const current = store.getConfig();
  const next = {
    ...current,
    timezone: incoming.timezone || current.timezone,
    email: { ...current.email, ...(incoming.email || {}) }
  };
  await store.saveConfig(next);
  res.json({ timezone: next.timezone, email: next.email });
}));

// ---- ledger (admin-curated notice board on the public page) ------------
// Read is public — it's the page's notice board. The write paths live under
// /api/admin and are session-gated, so only the admin can add, edit or
// remove ledger entries.
app.get('/api/ledger', (req, res) => {
  // Newest first for display.
  res.json(store.getLedger().slice().reverse());
});

app.post('/api/admin/ledger', requireAdmin, ah(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something for the ledger first.' });
  if (text.length > 300) return res.status(400).json({ error: 'Keep ledger entries under 300 characters.' });
  const entry = {
    id: 'l-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    text,
    time: new Date().toISOString()
  };
  const entries = store.getLedger();
  entries.push(entry);
  await store.saveLedger(entries);
  res.status(201).json(entry);
}));

app.put('/api/admin/ledger/:id', requireAdmin, ah(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something for the ledger first.' });
  if (text.length > 300) return res.status(400).json({ error: 'Keep ledger entries under 300 characters.' });
  const entries = store.getLedger();
  const e = entries.find((x) => x.id === req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  e.text = text;
  await store.saveLedger(entries);
  res.json(e);
}));

app.delete('/api/admin/ledger/:id', requireAdmin, ah(async (req, res) => {
  const entries = store.getLedger();
  const i = entries.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  const [removed] = entries.splice(i, 1);
  await store.saveLedger(entries);
  res.json(removed);
}));

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
    users: store.getUsers(), // the roster is admin-visible ONLY
    defaultBotId: cfg.telegram.defaultBotId || null,
    dataDir: store.getDataDir(),
    db: store.getDatabaseInfo()
  });
});

// Add a bot by token (auto-discovers its @username).
app.post('/api/admin/bots', requireAdmin, ah(async (req, res) => {
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
}));

// Remove a bot.
app.delete('/api/admin/bots/:id', requireAdmin, ah(async (req, res) => {
  const cfg = store.getConfig();
  cfg.telegram.bots = (cfg.telegram.bots || []).filter((b) => b.id !== req.params.id);
  if (cfg.telegram.defaultBotId === req.params.id) cfg.telegram.defaultBotId = (cfg.telegram.bots[0] || {}).id || null;
  await store.saveConfig(cfg);
  res.json({ ok: true });
}));

// Set the default bot (used for "me" and new reminders).
app.post('/api/admin/bots/:id/default', requireAdmin, ah(async (req, res) => {
  const cfg = store.getConfig();
  if (!(cfg.telegram.bots || []).some((b) => b.id === req.params.id)) return res.status(404).json({ error: 'Bot not found.' });
  cfg.telegram.defaultBotId = req.params.id;
  await store.saveConfig(cfg);
  res.json({ ok: true });
}));

// Remove an enrolled user (admin).
app.delete('/api/admin/users/:chatId', requireAdmin, ah(async (req, res) => {
  const id = String(req.params.chatId);
  await store.saveUsers(store.getUsers().filter((u) => String(u.chatId) !== id));
  res.json({ ok: true });
}));

// Change the admin password.
app.post('/api/admin/password', requireAdmin, ah(async (req, res) => {
  const { current, next } = req.body || {};
  const cfg = store.getConfig();
  if (store.hashPassword(String(current || '')) !== cfg.admin.passwordHash) {
    return res.status(401).json({ error: 'Current password is wrong.' });
  }
  if (!next || String(next).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  cfg.admin.passwordHash = store.hashPassword(String(next));
  await store.saveConfig(cfg);
  res.json({ ok: true });
}));

// Connect (a new) database. Admin only.
app.post('/api/admin/mongo', requireAdmin, ah(async (req, res) => {
  try {
    const info = await store.setDatabase(String((req.body || {}).uri || ''));
    res.json({ ok: true, db: info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// Send a test notification through one channel (admin only — otherwise anyone
// could spam test messages to Telegram/email).
app.post('/api/test/:channel', requireAdmin, ah(async (req, res) => {
  try {
    const name = await channels.test(req.params.channel, req.body.text);
    res.json({ ok: true, message: 'Test sent via ' + name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

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
