// scheduler.js — the "brain" that checks every few seconds whether a
// reminder is due, fires it through all configured channels, then moves
// one-time tasks to Done and rolls recurring tasks to their next occurrence.
const store = require('./store');
const channels = require('./channels');
const { nextOccurrence } = require('./parser');

const TICK_MS = 15 * 1000; // check every 15 seconds

function start() {
  let running = false;

  async function tick() {
    if (running) return; // avoid overlapping ticks
    running = true;
    try {
      const now = new Date();
      const tasks = store.getTasks();
      let changed = false;

      for (const t of tasks) {
        // Recurring tasks store their next fire time lazily.
        if (t.recurring && (!t.dueAt || isNaN(new Date(t.dueAt).getTime()))) {
          t.dueAt = nextOccurrence(t.recurring, t.time, now).toISOString();
          changed = true;
          continue;
        }
        if (t.done) continue;

        const due = new Date(t.dueAt);
        if (due.getTime() <= now.getTime()) {
          const results = await channels.send(t);
          await store.addActivity({
            time: now.toISOString(),
            title: t.title,
            via: results.map((r) => (r.ok ? r.channel : r.channel + ' ✗')),
            ok: results.every((r) => r.ok)
          });

          t.lastSentAt = now.toISOString();
          if (t.recurring) {
            // Roll to the next occurrence, skipping any we've already passed.
            t.dueAt = nextOccurrence(t.recurring, t.time, now).toISOString();
          } else {
            t.done = true;
            t.completedAt = now.toISOString();
          }
          changed = true;
        }
      }

      if (changed) await store.saveTasks(tasks);
    } catch (e) {
      console.error('scheduler tick error:', e);
    } finally {
      running = false;
    }
  }

  tick(); // run once immediately (also fixes any missing recurring dueAt)
  const timer = setInterval(tick, TICK_MS);

  return { stop: () => clearInterval(timer) };
}

module.exports = { start };
