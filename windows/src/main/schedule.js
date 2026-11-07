'use strict';
// Sleep windows like "every day 23:00 -> 08:00". A manual "sleep now" / "wake
// now" holds until the next scheduled change, then the schedule takes over again.
const config = require('./config');

function minutes(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); return (h || 0) * 60 + (m || 0); }

// Is the moment `d` inside any window? Windows may cross midnight; a window that
// starts on Monday 23:00 still covers Tuesday 07:00.
function inWindow(d, w) {
  const now = d.getHours() * 60 + d.getMinutes();
  const a = minutes(w.from), b = minutes(w.to);
  const day = d.getDay(), prev = (day + 6) % 7;
  const days = new Set(w.days && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6]);
  if (a === b) return false;
  if (a < b) return days.has(day) && now >= a && now < b;
  return (days.has(day) && now >= a) || (days.has(prev) && now < b);
}

function scheduledAsleep(d = new Date()) {
  const s = config.get().sleep;
  return !!s.enabled && (s.windows || []).some((w) => inWindow(d, w));
}

// Next time (ms) the scheduled state flips, looking up to 8 days ahead.
function nextChange(from = new Date()) {
  const cur = scheduledAsleep(from);
  const t = new Date(from); t.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (scheduledAsleep(t) !== cur) return t.getTime();
  }
  return null;
}

let override = null;     // { asleep: bool, until: ms|null }

function asleep(now = Date.now()) {
  if (override) {
    if (override.until && now >= override.until) override = null;
    else return override.asleep;
  }
  return scheduledAsleep(new Date(now));
}

function sleepNow() { override = { asleep: true, until: scheduledAsleep() ? null : nextChange() }; if (scheduledAsleep()) override = null; }
function wakeNow() {
  override = { asleep: false, until: scheduledAsleep() ? nextChange() : null };
  if (!scheduledAsleep()) override = null;
  // a manual wake inside a sleep window lasts until that window ends
}
function clearOverride() { override = null; }

function describe() {
  const now = Date.now();
  return { asleep: asleep(now), scheduled: scheduledAsleep(), override, nextChange: nextChange() };
}

module.exports = { asleep, sleepNow, wakeNow, clearOverride, describe, inWindow, nextChange };
