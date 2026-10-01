// telegram-poller.js — the fixed-bot "doorman" (supports MULTIPLE bots).
//
// Each bot serves everyone who messages it. This runs in the background and
// long-polls Telegram's getUpdates for every bot. The moment someone presses
// Start (or messages a bot), it registers them with their unique chat id +
// username + which bot they used, and sends a welcome note. After that the
// bot can message them anytime, on schedule.
const store = require('./store');

let stopped = false;
const offsets = {}; // botId -> last processed update id

function bots() {
  return store.getConfig().telegram.bots || [];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function apiCall(token, method, params = {}) {
  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.description || 'HTTP ' + res.status);
  return data;
}

function getMe(token) {
  return apiCall(token, 'getMe');
}

// Register or refresh a user record under a specific bot. Returns { user, isNew }.
async function upsertUser(chat, botId) {
  const chatId = String(chat.id);
  const users = store.getUsers();
  let user = users.find((u) => String(u.chatId) === chatId);
  const isNew = !user;

  if (isNew) {
    user = {
      chatId,
      botId,
      username: chat.username || null,
      firstName: chat.first_name || null,
      lastName: chat.last_name || null,
      joinedAt: new Date().toISOString()
    };
    users.push(user);
  } else {
    user.botId = botId || user.botId;
    user.username = chat.username || user.username;
    user.firstName = chat.first_name || user.firstName;
    user.lastName = chat.last_name || user.lastName;
    user.lastSeen = new Date().toISOString();
  }
  await store.saveUsers(users);

  // First person to press Start becomes the owner ("me") if none is set yet.
  if (isNew) {
    const cfg = store.getConfig();
    if (!cfg.telegram.chatId) {
      cfg.telegram.chatId = chatId;
      await store.saveConfig(cfg);
    }
  }
  return { user, isNew };
}

function welcomeName(u) {
  if (u.username) return '@' + u.username;
  if (u.firstName) return u.firstName;
  return 'friend';
}

async function pollOnce(bot) {
  const offset = offsets[bot.id] || 0;
  const data = await apiCall(bot.token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
  if (!data.result) return;

  for (const upd of data.result) {
    offsets[bot.id] = Math.max(offsets[bot.id] || 0, upd.update_id + 1);
    const msg = upd.message;
    if (!msg || !msg.chat) continue;

    const { user, isNew } = await upsertUser(msg.chat, bot.id);
    if (isNew) {
      const name = welcomeName(user);
      try {
        await apiCall(bot.token, 'sendMessage', {
          chat_id: msg.chat.id,
          text: 'You\u2019re enrolled, ' + name + '! \uD83D\uDC31 You\u2019ll get reminders right here, on time. \u2014 meow \u00b7 you heard me.'
        });
      } catch (e) {
        // welcome failed (e.g. user blocked the bot) — not fatal
      }
      await store.addActivity({
        time: new Date().toISOString(),
        title: 'Enrolled ' + name + (bot.username ? ' via @' + bot.username : ''),
        via: ['telegram'],
        ok: true
      });
    }
  }
}

// Continuously long-poll every bot. Safe to call once; call stop() to end.
async function start() {
  stopped = false;
  while (!stopped) {
    const list = bots();
    if (!list.length) {
      await sleep(15000); // no bots yet — idle, check again later
      continue;
    }
    for (const bot of list) {
      if (stopped) break;
      try {
        await pollOnce(bot);
      } catch (e) {
        await sleep(3000); // bad token / network — back off, try again
      }
    }
    await sleep(1000);
  }
}

function stop() {
  stopped = true;
}

module.exports = { start, stop, getMe };
