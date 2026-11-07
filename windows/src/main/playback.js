'use strict';
// The endless loop: walks the playlist forever, skipping anything not ready,
// remembering where long videos were so a restart picks up mid-film.
const { pathToFileURL } = require('url');
const config = require('./config');
const library = require('./library');
const log = require('./log');

let send = () => {};              // (channel, data) -> player window
const st = { currentId: null, playing: false, asleep: false, active: true, t: 0, d: 0, startedAt: 0, paused: false, errors: {}, history: [] };
const listeners = new Set();
let imageTimer = null, idleRetry = null, lastResumeSave = 0;
function emit() { for (const l of listeners) { try { l(state()); } catch {} } }

function state() {
  const it = st.currentId && library.find(st.currentId);
  return { currentId: st.currentId, name: it?.name || null, kind: it?.kind || null, playing: st.playing, paused: st.paused, asleep: st.asleep, t: st.t, d: st.d };
}

function playerItem(it) {
  const c = config.get();
  const src = it.cachePath || it.path;
  const meta = it.meta || {};
  const still = !!(it.still || meta.still);
  const kind = it.kind === 'quilt' ? 'quilt' : 'rgbd';   // 2D items play from their RGBD cache
  const longVid = (it.meta?.duration || 0) >= c.playlist.resumeMinMinutes * 60;
  const v = library.view(it, kind === 'rgbd' && meta.framing && !meta.framing.failed ? meta.framing : null);
  return {
    id: it.id, url: pathToFileURL(src).href, kind, still,
    cols: it.cols, rows: it.rows, aspect: it.aspect, depthLoc: meta.depthLoc ?? 2,
    look: Object.assign({}, c.look, it.look || {}),
    volume: c.audio.volume, muted: c.audio.muted,
    startAt: c.playlist.resumeLongVideos && longVid ? (it.resumeAt || 0) : 0,
    framing: v.framing,
    frame: v.frame,
  };
}

function order() {
  const items = library.get().items.filter(library.playable);
  return items;
}

function pickNext(afterId) {
  const items = order();
  if (!items.length) return null;
  if (config.get().playlist.order === 'shuffle' && items.length > 1) {
    const pool = items.filter((i) => i.id !== afterId && !st.history.slice(-Math.floor(items.length / 2)).includes(i.id));
    const from = pool.length ? pool : items.filter((i) => i.id !== afterId);
    return from[Math.floor(Math.random() * from.length)];
  }
  const idx = items.findIndex((i) => i.id === afterId);
  return items[(idx + 1) % items.length] || items[0];
}

function play(it) {
  clearTimeout(imageTimer); clearTimeout(idleRetry);
  if (!it) {
    st.currentId = null; st.playing = false;
    send('player:black');
    idleRetry = setTimeout(() => { if (!st.asleep && !st.currentId) next(); }, 10000);
    emit(); return;
  }
  st.currentId = it.id; st.playing = true; st.paused = false; st.t = 0; st.d = it.meta?.duration || 0; st.startedAt = Date.now();
  st.history.push(it.id); if (st.history.length > 200) st.history.shift();
  const pi = playerItem(it);
  log.info(`play ${it.name} (${pi.kind}${pi.startAt ? ' from ' + Math.round(pi.startAt) + 's' : ''})`);
  send('player:load', pi);
  if (pi.still) {
    imageTimer = setTimeout(() => { if (st.currentId === it.id) next(); }, (config.get().playlist.imageSeconds || 20) * 1000);
  }
  emit();
}

function next() { if (st.asleep || !st.active) return; play(pickNext(st.currentId)); }

// No Go plugged into this PC: don't decode videos nobody can see (the phone is the
// player then). Picks up again where it left off when the Go appears.
function setActive(active) {
  if (active === st.active) return;
  st.active = active;
  if (!active) { clearTimeout(imageTimer); clearTimeout(idleRetry); st.playing = false; send('player:black'); }
  else if (!st.asleep) { const cur = st.currentId && library.find(st.currentId); play(cur && library.playable(cur) ? cur : pickNext(null)); }
  emit();
}
function prev() {
  if (st.asleep) return;
  const items = order();
  if (config.get().playlist.order === 'shuffle') {
    // shuffled: Back goes to what played before, not to the neighbour in the list
    if (st.history[st.history.length - 1] === st.currentId) st.history.pop();
    while (st.history.length) {
      const it = library.find(st.history.pop());
      if (it && library.playable(it) && it.id !== st.currentId) { play(it); return; }
    }
  }
  const idx = items.findIndex((i) => i.id === st.currentId);
  play(items[(idx - 1 + items.length) % items.length] || items[0]);
}
function playId(id) { const it = library.find(id); if (it && library.playable(it)) { st.asleep = false; play(it); } }

function setAsleep(asleep) {
  if (asleep === st.asleep) return;
  st.asleep = asleep;
  if (asleep) { clearTimeout(imageTimer); clearTimeout(idleRetry); st.playing = false; send('player:black'); }
  else if (st.active) {
    const cur = st.currentId && library.find(st.currentId);
    play(cur && library.playable(cur) ? cur : pickNext(null));
  }
  emit();
}

function pause() { st.paused = true; send('player:pause'); emit(); }
function resume() { st.paused = false; send('player:resume'); emit(); }

// --- events from the player window
function onStarted(d) { if (d?.d) st.d = d.d; st.errors[st.currentId] = 0; emit(); }
function onEnded() {
  const it = st.currentId && library.find(st.currentId);
  if (it && it.resumeAt) library.patchItem(it.id, { resumeAt: 0 });
  next();
}
function onProgress(p) {
  st.t = p.t; st.d = p.d || st.d;
  const now = Date.now();
  if (now - lastResumeSave > 10000 && st.currentId) {
    lastResumeSave = now;
    const it = library.find(st.currentId);
    if (it && st.d >= config.get().playlist.resumeMinMinutes * 60) library.patchItem(it.id, { resumeAt: Math.max(0, p.t - 5) });
  }
  emit();
}
function onError(e) {
  const id = st.currentId;
  if (!id) return;
  const n = (st.errors[id] = (st.errors[id] || 0) + 1);
  log.warn(`player error on ${library.find(id)?.name}: ${e?.msg || e?.code} (try ${n})`);
  if (n >= 3) library.patchItem(id, { status: 'failed', error: 'could not play: ' + (e?.msg || 'video error') });
  setTimeout(next, 1500);
}
function onStalled(d) {
  log.warn(`playback stalled at ${d?.t}s, reloading`);
  const it = st.currentId && library.find(st.currentId);
  if (!it) return next();
  const pi = playerItem(it); pi.startAt = Math.max(0, (d?.t || 0) - 1);
  send('player:load', pi);
}

// Library changed: if nothing is playing, or the current item went away, move on.
function onLibrary() {
  if (st.asleep || !st.active) return;
  const cur = st.currentId && library.find(st.currentId);
  if (!st.currentId || !cur || !library.playable(cur)) {
    if (!st.currentId) { const n = pickNext(null); if (n) play(n); }
    else next();
  }
}

function attach(sendFn) { send = sendFn; }
function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { attach, state, next, prev, playId, play, pickNext, setAsleep, setActive, pause, resume, onStarted, onEnded, onProgress, onError, onStalled, onLibrary, onState, playerItem };
