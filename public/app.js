// app.js — frontend logic for the dashboard.
// NOTE: all settings (email, bot link, test messages, user management) now
// live on the password-protected ADMIN page. This file only powers the public
// dashboard: reminders + the 🐾 GET THE MEOW enroll button + enrolled panel.
let TZ = 'Asia/Kolkata';
let tasks = [];
let users = [];
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
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function displayName(u) {
  if (u.username) return '@' + u.username;
  if (u.firstName) return u.firstName;
  return 'chat ' + u.chatId;
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
        if (act === 'done') await api('/api/tasks/' + id + '/done', { method: 'POST' });
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

  const recipient = users.find((u) => String(u.chatId) === String(t.chatId));
  let toLabel = '';
  if (users.length > 1 && !isDone) {
    if (recipient) toLabel = '→ ' + displayName(recipient);
    else if (!t.chatId) toLabel = '→ me';
  }

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
          ${toLabel ? `<span class="t-to">${escapeHtml(toLabel)}</span>` : ''}
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

function renderActivity(list) {
  const el = $('activityList');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Nothing fired yet. Reminders will be recorded here as they go out.</div>';
    return;
  }
  el.innerHTML = list.map((a) => {
    const fail = a.ok === false;
    const timeStr = fmtTime(a.time) + ' &middot; ' + fmtDateShort(a.time);
    return `
      <div class="activity-item ${fail ? 'fail' : ''}">
        <div class="a-time">${timeStr}</div>
        <div class="a-title">${escapeHtml(a.title)}</div>
        <div class="a-via">via ${escapeHtml((a.via || []).join(' · '))}</div>
      </div>`;
  }).join('');
}

function renderHero() {
  const next = tasks.find((t) => !t.done);
  const label = $('heroLabel');
  const title = $('heroTitle');
  const when = $('heroWhen');

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
  $('cdD').textContent = total >= 86400 ? Math.floor(total / 86400) : '0';
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

// ---------- enrolled users UI (public read-only panel) ----------
function renderUsers() {
  const owner = telegramInfo.ownerChatId;

  // sidebar list
  const el = $('enrolledList');
  if (!users.length) {
    el.innerHTML = '<div class="muted">no one enrolled yet</div>';
  } else {
    el.innerHTML = users.map((u) => {
      const isOwner = String(u.chatId) === String(owner);
      return `<div class="user-row"><span class="u-name">${escapeHtml(displayName(u))}</span>${isOwner ? '<span class="tag on">you</span>' : ''}</div>`;
    }).join('');
  }

  // send-to selector
  const sel = $('sendTo');
  if (users.length > 1) {
    sel.innerHTML = users.map((u) => {
      const isOwner = String(u.chatId) === String(owner);
      return `<option value="${escapeHtml(String(u.chatId))}" ${isOwner ? 'selected' : ''}>${escapeHtml(displayName(u))}${isOwner ? ' (me)' : ''}</option>`;
    }).join('');
    $('sendtoRow').hidden = false;
  } else {
    $('sendtoRow').hidden = true;
  }
}

// 🐾 GET THE MEOW — public enroll button
function renderBotLink() {
  const bots = telegramInfo.bots || [];
  const def = bots.find((b) => b.id === telegramInfo.defaultBotId) || bots[0];
  const meow = $('getMeowBtn');
  meow.href = (def && def.link) ? def.link : '#';
}

function defaultBotLink() {
  const bots = telegramInfo.bots || [];
  const def = bots.find((b) => b.id === telegramInfo.defaultBotId) || bots[0];
  return def ? def.link : null;
}

// ---------- data ----------
async function refresh() {
  try {
    const [taskData, activity] = await Promise.all([api('/api/tasks'), api('/api/activity')]);
    tasks = taskData;
    renderTasks();
    renderHero();
    renderActivity(activity);
  } catch (e) {
    console.error(e);
  }
}

async function bootstrapStatus() {
  try {
    const s = await api('/api/status');
    TZ = s.timezone;
    telegramInfo = s.telegram || {};
    users = s.users || [];
    renderDates();
    renderUsers();
    renderBotLink();
  } catch (e) {
    console.error(e);
  }
}

// ---------- add form ----------
function selectedRecipient() {
  if ($('sendtoRow').hidden) return null;
  const v = $('sendTo').value;
  return v || null;
}

async function addTask(text, to) {
  text = (text || '').trim();
  if (!text) return;
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { text, to } });
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

async function addExact(title, dueAt, to) {
  try {
    const t = await api('/api/tasks', { method: 'POST', body: { title, dueAt, to } });
    toast('Noted — I\u2019ll remind you to \u201c' + t.title + '\u201d ' + fmtDateTime(t.dueAt));
    $('addInput').value = '';
    clearCustomTime();
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function clearCustomTime() {
  $('customTime').value = '';
  $('customRow').hidden = true;
}

function submitAdd() {
  const text = ($('addInput').value || '').trim();
  const custom = $('customTime').value;
  const to = selectedRecipient();

  if (custom) {
    const title = text || 'Reminder';
    const dueAt = new Date(custom).toISOString();
    if (isNaN(new Date(dueAt).getTime())) { toast('That time looks off — pick it again.', true); return; }
    addExact(title, dueAt, to);
    return;
  }

  if (text) {
    addTask(text, to);
    return;
  }

  toast('Type what to remember, then pick a time — tap \u201cIN 15 MIN\u201d or \u201cCUSTOM TIME\u201d.', true);
}

// ---------- events ----------
$('addForm').addEventListener('submit', (e) => { e.preventDefault(); submitAdd(); });
$('chip15').addEventListener('click', () => {
  const title = ($('addInput').value || '').trim() || 'Quick reminder';
  const dueAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  addExact(title, dueAt, selectedRecipient());
});
$('chipCustom').addEventListener('click', () => {
  const row = $('customRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('customTime').focus();
});
$('clearCustom').addEventListener('click', clearCustomTime);

// 🐾 GET THE MEOW — if no bot is set up yet, explain instead of opening a dead link
$('getMeowBtn').addEventListener('click', (e) => {
  const link = defaultBotLink();
  if (!link) {
    e.preventDefault();
    toast('No bot set up yet — open 🔐 ADMIN and add a bot first.', true);
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
  // keep the enrolled list fresh too
  setInterval(bootstrapStatus, 20000);
})();
