// parser.js — turns plain English into a structured reminder.
//   "remind me to call dad tomorrow 9am"  ->  { title: "call dad", dueAt: <Date> }
//   "every monday 9am standup"            ->  { title: "standup", recurring: weekly }
const chrono = require('chrono-node');

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6
};

// Strip helper words so "remind me to call dad" becomes "call dad".
function cleanTitle(s) {
  let t = (s || '').trim();
  t = t.replace(/^(please|kindly)\s+/i, '');
  t = t.replace(/^(remind me to|remind me about|remind me|remember me to|remember to|remember|remind|notify me to|notify me)\s+/i, '');
  t = t.replace(/^to\s+/i, '');
  t = t.replace(/^[\s\-–—:,.!?;]+/, '');
  t = t.replace(/\s+/g, ' ');
  return t.trim();
}

// Parse a time-of-day like "9", "9:30", "8:00 pm" from a string.
// Returns { h, m } or null.
function parseTimeOfDay(s) {
  const m = s.match(/(?:(at)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  const hasAt = !!m[1];
  const hasColon = !!m[3];
  const hasAmpm = !!m[4];
  // A bare number with no "at"/colon/am-pm is probably not a time
  // (e.g. "buy 2 eggs"). Only treat it as a time when it's clearly one.
  if (!hasAt && !hasColon && !hasAmpm) return null;

  let h = parseInt(m[2], 10);
  const min = m[3] ? parseInt(m[3], 10) : 0;
  const ap = (m[4] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

// Compute the next fire time for a recurring rule.
function nextOccurrence(rec, time, from) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(time.h, time.m, 0, 0);

  if (rec.type === 'daily') {
    if (d <= from) d.setDate(d.getDate() + 1);
  } else if (rec.type === 'weekdays') {
    while (d.getDay() === 0 || d.getDay() === 6 || d <= from) d.setDate(d.getDate() + 1);
  } else if (rec.type === 'weekends') {
    while ((d.getDay() !== 0 && d.getDay() !== 6) || d <= from) d.setDate(d.getDate() + 1);
  } else if (rec.type === 'weekly') {
    while (d.getDay() !== rec.day || d <= from) d.setDate(d.getDate() + 1);
  }
  return d;
}

// Main entry: parse a natural-language reminder string.
function parseTask(input, now = new Date()) {
  const text = (input || '').trim();
  if (!text) {
    return { error: 'Empty reminder. Try: "remind me to call dad tomorrow 9am".' };
  }

  // ---- Recurring rules: "every day / every monday / every weekday ..." ----
  const every = text.match(/^every\s+(day|weekday|weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i);
  if (every) {
    const kind = every[1].toLowerCase();
    const rest = text.slice(every[0].length);

    const time = parseTimeOfDay(rest) || { h: 9, m: 0 };

    let recurring;
    if (kind === 'day') recurring = { type: 'daily' };
    else if (kind === 'weekday') recurring = { type: 'weekdays' };
    else if (kind === 'weekend') recurring = { type: 'weekends' };
    else recurring = { type: 'weekly', day: WEEKDAYS[kind] };

    // Remove the "at 9am" part from the title.
    let title = rest.replace(/(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i, '');
    title = cleanTitle(title);
    if (!title) {
      const nice = { daily: 'Daily', weekdays: 'Weekday', weekends: 'Weekend', weekly: 'Weekly' }[recurring.type];
      title = nice + ' reminder';
    }

    return { title, recurring, time, dueAt: nextOccurrence(recurring, time, now) };
  }

  // ---- One-time reminders: use chrono to understand the date/time ----
  const results = chrono.parse(text, now, { forwardDate: true });
  if (!results.length) {
    return { error: 'I could not find a time in that. Try "tomorrow 9am", "in 2 hours" or "every monday 9am".' };
  }

  const r = results[0];
  const dueAt = r.start.date();
  if (!dueAt || isNaN(dueAt.getTime())) {
    return { error: 'Could not understand that time. Try "tomorrow 9am" or "in 2 hours".' };
  }

  // The title is everything except the matched date/time phrase.
  let title = text.slice(0, r.index) + text.slice(r.index + r.text.length);
  title = cleanTitle(title);
  if (!title) title = 'Reminder';

  return { title, dueAt };
}

module.exports = { parseTask, nextOccurrence, WEEKDAYS };
