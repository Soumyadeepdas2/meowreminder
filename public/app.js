// app.js — frontend logic for the dashboard.
//
// Identity model: every browser has its OWN "me". Pressing 🐾 GET THE MEOW
// starts a one-time Telegram handoff (code in the browser + deep link to the
// bot); once the person taps Start, THIS browser is linked to their Telegram
// and only their own reminders are visible/creatable. There is no public
// roster and no "send to someone else" — those live in 🔐 ADMIN only.
let TZ = 'Asia/Kolkata';
let tasks = [];
let me = null;         // this browser's linked person (or null)
let telegramInfo = {};

const $ = (id) => document.getElementById(id);

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'HTTP ' + res.status);
  }
  return res.json();
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtTime(iso) {
  return new Intl.DateTimeFormat(undefined, { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  const opts = { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}
function fmtDateShort(iso) {
  return new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', day: 'numeric' }).format(new Date(iso));
}
function fmtDayShort(iso) {
  return new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: 'short', day: 'numeric' }).format(new Date(iso));
}
function fmtLongDate(now) {
  return new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now);
}
function fmtMastDate(now) {
  return new Intl.DateTimeFormat(undefined, { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(now);
}

function dateKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
function isToday(iso) { return dateKey(iso) === dateKey(Date.now()); }

function relative(iso) {
  const diff = new Date(iso) - new Date();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  if (mins < 1) return diff < 0 ? 'just now' : 'now';
  if (mins < 60) return (diff < 0 ? mins + ' min ago' : 'in ' + mins + ' min');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return (diff < 0 ? hrs + ' hr ago' : 'in ' + hrs + ' hr' + (hrs > 1 ? 's' : ''));
  const days = Math.round(hrs / 24);
  return (diff < 0 ? days + ' day' + (days > 1 ? 's' : '') + ' ago' : 'in ' + days + ' day' + (days > 1 ? 's' : ''));
}

const RECURRING_LABEL = { daily: 'Every day', weekdays: 'Every weekday', weekends: 'Every weekend', weekly: 'Weekly' };
function recurringLabel(t) {
  if (!t.recurring) return null;
  let label = RECURRING_LABEL[t.recurring.type] || 'Repeats';
  if (t.recurring.type === 'weekly') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    label = 'Every ' + names[t.recurring.day];
  }
  if (t.time) label += ' at ' + (t.time.h % 12 || 12) + ':' + String(t.time.m).padStart(2, '0') + (t.time.h >= 12 ? ' PM' : ' AM');
  return label;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- rendering ----------
function renderTasks() {
  const upcoming = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const list = $('taskList');

  const html = [];

  if (!upcoming.length && !done.length) {
    list.innerHTML = '<div class="empty">Your agenda is clear. Write a reminder above.</div>';
    return;
  }

  upcoming.forEach((t) => html.push(taskCard(t, false)));
  if (done.length) {
    html.push('<div class="divider"><span>done</span></div>');
    done.forEach((t) => html.push(taskCard(t, true)));
  }
  list.innerHTML = html.join('');

  list.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const { act, id } = btn.dataset;
      try {
        if (act === 'done') {
          const t = await api('/api/tasks/' + id + '/done', { method: 'POST' });
          // A completed repeat comes straight back to the schedule.
          if (t.recurring) toast('Done — next one: ' + fmtDateTime(t.dueAt));
        }
        else if (act === 'snooze') await api('/api/tasks/' + id + '/snooze', { method: 'POST', body: { minutes: 15 } });
        else if (act === 'snooze60') await api('/api/tasks/' + id + '/snooze', { method: 'POST', body: { minutes: 60 } });
        else if (act === 'delete') await api('/api/tasks/' + id, { method: 'DELETE' });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function taskCard(t, isDone) {
  const rec = recurringLabel(t);
  const soon = !isDone && !t.recurring && new Date(t.dueAt) - new Date() < 60 * 60 * 1000;
  const timeStr = isDone ? 'done' : fmtTime(t.dueAt);
  const dayStr = !isDone && !isToday(t.dueAt) ? fmtDayShort(t.dueAt) : '';

  const meta = isDone
    ? `<span class="t-rel">completed ${t.completedAt ? relative(t.completedAt) : ''}</span>`
    : `<span class="t-rel">${fmtDateTime(t.dueAt)} &middot; ${relative(t.dueAt)}</span>`;

  return `
    <div class="task ${isDone ? 'done' : ''}">
      <div class="task-time">
        <span class="t-time">${escapeHtml(timeStr)}</span>
        ${dayStr ? `<span class="t-day">${escapeHtml(dayStr)}</span>` : ''}
      </div>
      <div class="task-body">
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-meta">
          ${rec ? `<span class="badge rec">${escapeHtml(rec)}</span>` : ''}
          ${soon ? `<span class="badge stamp">due soon</span>` : ''}
          ${meta}
        </div>
      </div>
      <div class="task-actions">
        ${isDone
          ? `<button class="btn ghost" data-act="delete" data-id="${t.id}">remove</button>`
          : `
            <button class="btn ghost" data-act="snooze" data-id="${t.id}">snooze 15m</button>
            <button class="btn ghost" data-act="snooze60" data-id="${t.id}">1h</button>
            <button class="btn" data-act="done" data-id="${t.id}">✓ done</button>
          `}
      </div>
    </div>`;
}

// The ledger is an admin-curated notice board: anyone can read it, only the
// admin can add/edit/remove entries (see /api/admin/ledger).
function renderLedger(list) {
  const el = $('ledgerList');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Nothing posted yet.</div>';
    return;
  }
  el.innerHTML = list.map((e) => {
    const timeStr = fmtTime(e.time) + ' &middot; ' + fmtDateShort(e.time);
    return `
      <div class="activity-item">
        <div class="a-time">${timeStr}</div>
        <div class="a-title">${escapeHtml(e.text)}</div>
        <div class="a-via">posted by admin</div>
      </div>`;
  }).join('');
}

function renderHero() {
  const label = $('heroLabel');
  const title = $('heroTitle');
  const when = $('heroWhen');

  if (!me) {
    // Anonymous: landing state, no personal data.
    label.textContent = 'GET YOUR MEOW';
    title.textContent = 'One browser. One meow.';
    when.textContent = 'Press the paw, tap Start in Telegram, and this browser becomes yours — your reminders, your agenda. Nobody else can see them.';
    setCountdown(0);
    return;
  }

  const next = tasks.find((t) => !t.done);
  if (!next) {
    title.textContent = 'Nothing scheduled yet';
    label.textContent = 'NEXT REMINDER';
    when.textContent = 'Write a reminder above to start the countdown.';
    setCountdown(0);
    return;
  }
  label.textContent = next.recurring ? 'NEXT REMINDER · RECURRING' : 'NEXT REMINDER';
  title.textContent = next.title;
  when.textContent = fmtDateTime(next.dueAt) + ' — ' + relative(next.dueAt);
  setCountdown(new Date(next.dueAt) - new Date());
}

function setCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  $('cdD').textContent = total >= 86400 ? String(Math.floor(total / 86400)) : '0';
  $('cdH').textContent = String(Math.floor((total % 86400) / 3600)).padStart(2, '0');
  $('cdM').textContent = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  $('cdS').textContent = String(total % 60).padStart(2, '0');
}

function renderDates() {
  const now = new Date();
  $('clock').textContent = new Intl.DateTimeFormat(undefined, { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(now);
  $('mastDate').textContent = fmtMastDate(now);
  $('todayDate').textContent = fmtLongDate(now);
  $('tzLabel').textContent = TZ;
}

// "THIS BROWSER" panel: only ever shows the linked person of THIS browser.
function renderIdentityPanel() {
  const el = $('enrolledList');
  if (me) {
    el.innerHTML =
      `<div class="user-row"><span class="u-name">${escapeHtml(me.name)}</span><span class="tag on">linked</span></div>` +
      '<div class="muted small">your reminders are private to this browser.</div>';
  } else {
    el.innerHTML = '<div class="muted">no browser linked here yet.</div>';
  }
}

function renderMeChip() {
  const chip = $('meChip');
  if (me) {
    $('meName').textContent = me.name;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}

// Show/hide the personal sections based on identity.
function renderMode() {
  const personal = !!me;
  $('addSection').hidden = !personal;
  document.querySelector('.columns').hidden = !personal;
  $('meChip').hidden = !personal;
  $('getMeowBtn').classList.toggle('pulse', !personal);
}

// ---------- enrollment handoff ----------
let enrollPoll = null;

function startEnroll() {
  // Ask the server for a one-time code (stored as a cookie on THIS browser),
  // then show the code and open the bot's deep link.
  api('/api/enroll', { method: 'POST' }).then((r) => {
    $('enrollCode').textContent = r.code;
    $('enrollOpen').href = r.botLink;
    $('enrollStatus').textContent = 'Waiting for Telegram…';
    $('enrollBox').hidden = false;
    window.open(r.botLink, '_blank', 'noopener');

    clearInterval(enrollPoll);
    let tries = 0;
    enrollPoll = setInterval(async () => {
      tries++;
      if (tries === 5) { // ~12 s without a match → point at the manual path
        $('enrollStatus').textContent = 'Still waiting — if Telegram shows no Start button, type the code above into the chat and press send.';
      }
      if (tries > 120) { // ~5 minutes
        clearInterval(enrollPoll);
        $('enrollStatus').textContent = 'Still waiting — open Telegram, press Start (or send the code), then come back here.';
        return;
      }
      try {
        const s = await api('/api/enroll/status');
        if (s.state === 'linked') {
          clearInterval(enrollPoll);
          toast('Linked — welcome, ' + (s.you ? s.you.name : 'friend') + '. This browser is yours now.');
          setTimeout(() => location.reload(), 900);
        } else if (s.state === 'expired') {
          clearInterval(enrollPoll);
          $('enrollBox').hidden = true;
          toast('That code expired — press 🐾 GET THE MEOW again.', true);
        }
      } catch (e) { /* transient */ }
    }, 2500);
  }).catch((e) => {
    toast(e.message, true);
  });
}

// 🐾 GET THE MEOW — if no bot is set up yet, explain instead of opening a dead link
function renderBotLink() {
  const bots = telegramInfo.bots || [];
  const def = bots.find((b) => b.id === telegramInfo.defaultBotId) || bots[0];
  $('getMeowBtn').href = (def && def.link) ? def.link : '#';
}

function hasBot() {
  const bots = telegramInfo.bots || [];
  const def = bots.find((b) => b.id === telegramInfo.defaultBotId) || bots[0];
  return !!(def && def.link);
}

// ---------- data ----------
async function refresh() {
  try {
    const [taskData, ledger] = await Promise.all([api('/api/tasks'), api('/api/ledger')]);
    tasks = taskData;
    renderTasks();
    renderHero();
    renderLedger(ledger);
  } catch (e) {
    console.error(e);
  }
}

async function bootstrapStatus() {
  try {
    const s = await api('/api/status');
    TZ = s.timezone;
    telegramInfo = s.telegram || {};
    me = s.you || null;
    renderDates();
    renderMode();
    renderMeChip();
    renderIdentityPanel();
    renderHero();
    renderBotLink();
  } catch (e) {
    console.error(e);
  }
}

// ---------- add form (always for "me") ----------
async function addTask(text) {
  text = (text || '').trim();
  if (!text) return;
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { text } });
    toast('Noted — I\u2019ll remind you to \u201c' + t.title + '\u201d ' + (t.recurring ? recurringLabel(t) : fmtDateTime(t.dueAt)));
    $('addInput').value = '';
    clearCustomTime();
    await refresh();
  } catch (e) {
    if (/could not find a time/i.test(e.message)) {
      toast('Got the title — now pick a time: tap \u201cIN 15 MIN\u201d or \u201cCUSTOM TIME\u201d, or add one to your text like \u201ctomorrow 9am\u201d.', true);
    } else {
      toast(e.message, true);
    }
  }
}

async function addExact(title, dueAt) {
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { title, dueAt } });
    toast('Noted — I\u2019ll remind you to \u201c' + t.title + '\u201d ' + fmtDateTime(t.dueAt));
    $('addInput').value = '';
    clearCustomTime();
    clearRepeat();
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function clearCustomTime() {
  $('customTime').value = '';
  $('customRow').hidden = true;
}

// ---------- 🔁 EVERY DAY — recurring reminders (chip-driven, no typing needed) ----------
let repMode = 'daily'; // 'daily' | 'weekdays' | 'weekends' | 'weekly'
let repDay = null;     // 0 (Sun) – 6 (Sat), only when repMode === 'weekly'

function paintRepeatSel() {
  document.querySelectorAll('#repeatPresets .chip').forEach((b) => {
    b.classList.toggle('active', repMode === b.dataset.rec);
  });
  document.querySelectorAll('#repeatDows .chip').forEach((b) => {
    b.classList.toggle('active', repMode === 'weekly' && Number(b.dataset.day) === repDay);
  });
}

function readRepeat() {
  if ($('repeatRow').hidden) return null;
  const [h, m] = ($('repeatTime').value || '09:00').split(':').map(Number);
  const recurring = repMode === 'weekly' ? { type: 'weekly', day: repDay } : { type: repMode };
  return { recurring, time: { h: h || 0, m: m || 0 } };
}

function clearRepeat() {
  $('repeatRow').hidden = true;
  $('repeatTime').value = '09:00';
  repMode = 'daily';
  repDay = null;
  paintRepeatSel();
}

async function addRepeat(title, rep) {
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { title, recurring: rep.recurring, time: rep.time } });
    toast('Noted — I\u2019ll remind you to \u201c' + t.title + '\u201d ' + (recurringLabel(t) || 'again and again') + ' — next: ' + fmtDateTime(t.dueAt));
    $('addInput').value = '';
    clearRepeat();
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function submitAdd() {
  const text = ($('addInput').value || '').trim();
  const rep = readRepeat();

  if (rep) {
    addRepeat(text || 'Reminder', rep);
    return;
  }

  const custom = $('customTime').value;

  if (custom) {
    const title = text || 'Reminder';
    const dueAt = new Date(custom).toISOString();
    if (isNaN(new Date(dueAt).getTime())) { toast('That time looks off — pick it again.', true); return; }
    addExact(title, dueAt);
    return;
  }

  if (text) {
    addTask(text);
    return;
  }

  toast('Type what to remember, then pick a time — tap \u201cIN 15 MIN\u201d or \u201cCUSTOM TIME\u201d.', true);
}

// ---------- events ----------
$('addForm').addEventListener('submit', (e) => { e.preventDefault(); submitAdd(); });
$('chip15').addEventListener('click', () => {
  const title = ($('addInput').value || '').trim() || 'Quick reminder';
  const dueAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  addExact(title, dueAt);
});
$('chipCustom').addEventListener('click', () => {
  const row = $('customRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('customTime').focus();
});
$('clearCustom').addEventListener('click', clearCustomTime);
$('chipRepeat').addEventListener('click', () => {
  const row = $('repeatRow');
  row.hidden = !row.hidden;
  if (!row.hidden) { paintRepeatSel(); $('repeatTime').focus(); }
});
document.querySelectorAll('#repeatPresets .chip').forEach((b) => {
  b.addEventListener('click', () => { repMode = b.dataset.rec; repDay = null; paintRepeatSel(); });
});
document.querySelectorAll('#repeatDows .chip').forEach((b) => {
  b.addEventListener('click', () => { repMode = 'weekly'; repDay = Number(b.dataset.day); paintRepeatSel(); });
});
$('clearRepeat').addEventListener('click', clearRepeat);

// 🐾 GET THE MEOW — starts the handoff (or re-links to a different account).
$('getMeowBtn').addEventListener('click', (e) => {
  e.preventDefault();
  if (!hasBot()) {
    toast('No bot set up yet — open 🔐 ADMIN and add a bot first.', true);
    return;
  }
  if (me) {
    if (!confirm('Link this browser to a (different) Telegram account? Your current link will be replaced.')) return;
  }
  startEnroll();
});

// ↺ unlink this browser.
$('meSwitch').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    location.reload();
  } catch (e) {
    toast(e.message, true);
  }
});

// live clock + countdown
setInterval(() => {
  renderDates();
  renderHero();
}, 1000);

// start
(async () => {
  await bootstrapStatus();
  await refresh();
  setInterval(refresh, 15000);
  setInterval(bootstrapStatus, 30000);
})();
