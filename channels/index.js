// channels — pluggable notification backends.
// Each channel exposes: id, name, hint(), isConfigured(), send(task).
// This is where WhatsApp / Instagram / Facebook can be added later.
const store = require('../store');

const telegram = require('./telegram');
const email = require('./email');
const demo = require('./demo');

const ALL = [telegram, email, demo];

// Send a reminder through every configured channel.
// Returns [{ channel, ok, error? }] for the activity log.
async function send(task) {
  const results = [];
  for (const ch of ALL) {
    if (!ch.isConfigured()) continue;
    try {
      const ok = await ch.send(task);
      results.push({ channel: ch.id, ok });
    } catch (e) {
      results.push({ channel: ch.id, ok: false, error: String(e.message || e) });
    }
  }
  return results;
}

// Send a single test message through one specific channel.
async function test(channelId, taskTitle) {
  const ch = ALL.find((c) => c.id === channelId);
  if (!ch) throw new Error('Unknown channel: ' + channelId);
  if (!ch.isConfigured()) throw new Error(ch.name + ' is not configured yet.');
  const ok = await ch.send({
    title: taskTitle || 'Test notification',
    dueAt: new Date()
  });
  if (!ok) throw new Error(ch.name + ' returned an error.');
  return ch.name;
}

function status() {
  return ALL.map((ch) => ({
    id: ch.id,
    name: ch.name,
    configured: ch.isConfigured(),
    hint: ch.isConfigured() ? ch.connectedHint() : ch.hint()
  }));
}

module.exports = { send, test, status, ALL };
