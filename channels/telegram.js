// telegram.js — sends reminders to the right person via the right bot.
// A reminder is addressed to a chat id; we look up which bot that person
// enrolled through and use that bot's token. Falls back to the default bot.
const store = require('../store');

function cfg() {
  return store.getConfig().telegram;
}

function formatMessage(task) {
  const when = new Date(task.dueAt).toLocaleString('en-IN', { timeZone: store.getConfig().timezone });
  return '⏰ Reminder\n\n' + task.title + '\n\nScheduled for ' + when + '\n\n— meow · you heard me.';
}

// Which bot should deliver to this chat id?
function botForChat(chatId) {
  const c = cfg();
  const bots = c.bots || [];
  if (!bots.length) return null;

  const user = store.getUsers().find((u) => String(u.chatId) === String(chatId));
  if (user && user.botId) {
    const b = bots.find((x) => x.id === user.botId);
    if (b) return b;
  }
  return bots.find((x) => x.id === c.defaultBotId) || bots[0];
}

module.exports = {
  id: 'telegram',
  name: 'Telegram',
  hint: () => 'Add a bot in the Admin page, share its link, people press Start to enroll.',
  connectedHint: () => 'Connected — reminders go to each person\u2019s phone.',
  isConfigured() {
    return (cfg().bots || []).length > 0;
  },
  async send(task) {
    const c = cfg();
    const bots = c.bots || [];
    if (!bots.length) throw new Error('No bot yet — add one in the Admin page.');

    const chatId = task.chatId || c.chatId;
    if (!chatId) throw new Error('No recipient — nobody has enrolled yet.');

    const bot = botForChat(chatId);
    if (!bot) throw new Error('No bot available.');

    const url = 'https://api.telegram.org/bot' + bot.token + '/sendMessage';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatMessage(task) })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.description || 'HTTP ' + res.status);
    }
    return true;
  }
};
