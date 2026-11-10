'use strict';
// The playlist. Each entry is a file the user added (or found in a watched
// folder). 2D videos need a 3D (RGBD) copy in the cache before they can play;
// quilts and RGBD files play straight away.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { P, writeJson, readJson } = require('./paths');
const { VERSION } = require('../convert/version');

const VIDEO = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.wmv', '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.flv', '.3gp']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const QS = /_qs(\d+)x(\d+)(?:a([0-9]*\.?[0-9]+))?/i;

function classify(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file, ext);
  const isVid = VIDEO.has(ext), isImg = IMAGE.has(ext);
  if (!isVid && !isImg) return null;
  const q = base.match(QS);
  if (q) return { kind: 'quilt', still: isImg, cols: +q[1], rows: +q[2], aspect: q[3] ? +q[3] : null };
  if (/_rgbd\b/i.test(base) || /_rgbd$/i.test(base)) return { kind: 'rgbd', still: isImg };
  if (isImg) return { kind: 'image2d', still: true };
  return { kind: 'video2d', still: false };
}

let lib = null;
const listeners = new Set();
function emit() { for (const l of listeners) { try { l(lib); } catch {} } }

function load() {
  lib = readJson(P.library, { items: [], folders: [] }, (m) => require('./log').warn(m));
  lib.items ||= []; lib.folders ||= [];
  for (const it of lib.items) {                   // crashed mid-way
    if (it.status === 'converting') it.status = 'queued';
    if (it.redo === 'working') it.redo = true;
  }
  return lib;
}
function get() { return lib || load(); }
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doit = () => { writeJson(P.library, lib); emit(); };
  if (now) doit(); else saveTimer = setTimeout(doit, 250);
}
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Name + size + time (not the folder), so a cache copied from another PC still matches.
function fileKey(file, st) {
  return crypto.createHash('sha1').update(`${path.basename(file).toLowerCase()}|${st.size}|${Math.round(st.mtimeMs / 1000)}|v${VERSION}`).digest('hex').slice(0, 12);
}

function safeName(s) { return s.replace(/[^\w.\- ]+/g, '_').slice(0, 80); }

// Per-video depth detail (model input size); none = the app-wide setting.
const QUALITY = { quick: 392, balanced: 518, fine: 700 };

// A video with its own depth detail gets its own name, e.g. "clip.0123456789ab.fine_rgbd.mp4".
function cachePathFor(item, cacheDir) {
  return path.join(cacheDir, `${safeName(path.basename(item.path, path.extname(item.path)))}.${item.key}${item.quality ? '.' + item.quality : ''}_rgbd.mp4`);
}

function addFile(file, { fromFolder = null } = {}) {
  const L = get();
  const abs = path.resolve(file);
  if (L.items.some((i) => i.path.toLowerCase() === abs.toLowerCase())) return null;
  if (isOurs(abs)) return null;
  const c = classify(abs);
  if (!c) return null;
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size < 1024) return null;
  // a 3D copy HoloLoop made for a video that is already in the list
  const km = path.basename(abs).match(/\.([0-9a-f]{12})(?:\.[a-z]+)?_rgbd\.(mp4|png)$/i);
  if (km && L.items.some((i) => i.key === km[1].toLowerCase())) return null;
  const item = {
    id: crypto.randomBytes(6).toString('hex'), path: abs, name: path.basename(abs, path.extname(abs)),
    ...c, size: st.size, mtimeMs: st.mtimeMs, key: fileKey(abs, st), added: Date.now(), fromFolder,
    enabled: true, status: c.kind === 'video2d' || c.kind === 'image2d' ? 'queued' : 'ready',
    cachePath: null, progress: 0, error: null, look: null, resumeAt: 0,
  };
  if (item.status === 'queued') adoptCache(item);
  L.items.push(item);
  save();
  return item;
}

// If the 3D copy for this exact file is already in the 3D folder, use it, at any detail level.
function adoptCache(item) {
  try {
    const dir = require('./config').get().convert.cacheDir;
    for (const quality of new Set([item.quality || null, null, ...Object.keys(QUALITY)])) {
      const f = cachePathFor({ ...item, quality }, dir).replace(/\.mp4$/, item.still ? '.png' : '.mp4');
      if (!fs.existsSync(f) || !fs.existsSync(f + '.json')) continue;
      let meta = null; try { meta = JSON.parse(fs.readFileSync(f + '.json', 'utf8')); } catch {}
      Object.assign(item, { status: 'ready', cachePath: f, progress: 1, meta, quality });
      return true;
    }
  } catch {}
  return false;
}

function addPaths(paths) {
  const added = [];
  for (const p of paths) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      for (const f of walk(p)) { const it = addFile(f, { fromFolder: p }); if (it) added.push(it); }
    } else { const it = addFile(p); if (it) added.push(it); }
  }
  return added;
}

// HoloLoop's own 3D folder must never be read as videos: its 3D copies, thumbnails
// and half-finished pieces would all turn into playlist entries when the 3D folder
// sits inside a watched folder.
function cacheRoot() {
  try { return path.resolve(require('./config').get().convert.cacheDir).toLowerCase() + path.sep; } catch { return null; }
}
function isOurs(p) {
  const low = path.resolve(p).toLowerCase() + (fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.sep : '');
  const root = cacheRoot();
  if (root && low.startsWith(root)) return true;
  if (/\.work([\\/]|$)/i.test(low)) return true;              // a conversion in progress
  if (/\.part(\.[a-z0-9]+)?$/i.test(low)) return true;          // half-written file
  if (/[\\/]thumbs[\\/][0-9a-f]{12}\.jpg$/i.test(low)) return true;  // our thumbnails, wherever they ended up
  return false;
}

function* walk(dir, depth = 0) {
  if (depth > 6 || isOurs(dir)) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^\.|^\$|^System Volume Information$/i.test(e.name) && !isOurs(f)) yield* walk(f, depth + 1); }
    else if (e.isFile() && !isOurs(f)) yield f;
  }
}

function addFolder(dir) {
  const L = get();
  const abs = path.resolve(dir);
  if (!L.folders.some((f) => f.toLowerCase() === abs.toLowerCase())) L.folders.push(abs);
  const added = addPaths([abs]);
  save();
  return added;
}

function removeFolder(dir) {
  const L = get();
  L.folders = L.folders.filter((f) => f.toLowerCase() !== dir.toLowerCase());
  save();
}

// New files appear in watched folders; files that vanish get marked missing.
// A file that moved shows up as a new entry while its old one goes missing. Keep the
// new entry, carry over the user's choices, and drop the old one.
function mergeMoved() {
  const L = get();
  const live = new Map();
  for (const it of L.items) if (it.status !== 'missing') live.set(it.key, it);
  const keepers = [];
  for (const it of L.items) {
    if (it.status === 'missing') {
      const twin = live.get(it.key);
      if (twin && twin !== it) {
        if (!it.enabled) twin.enabled = false;
        if (it.frame && it.frame !== 'rotatebig' && (!twin.frame || twin.frame === 'rotatebig')) twin.frame = it.frame;
        if (it.look && !twin.look) twin.look = it.look;
        if (it.quality && !twin.quality) twin.quality = it.quality;
        if (it.resumeAt && !twin.resumeAt) twin.resumeAt = it.resumeAt;
        continue;                                   // drop the stale entry
      }
    }
    keepers.push(it);
  }
  const dropped = L.items.length - keepers.length;
  L.items = keepers;
  return dropped;
}

function rescan() {
  const L = get();
  const added = [];
  for (const d of L.folders) for (const f of walk(d)) { const it = addFile(f, { fromFolder: d }); if (it) added.push(it); }
  // entries for HoloLoop's own files (from before the 3D folder was skipped) go away,
  // including vanished 3D copies of videos that are in the list
  const keys = new Set(L.items.map((i) => i.key));
  L.items = L.items.filter((it) => {
    if (isOurs(it.path)) return false;
    const km = path.basename(it.path).match(/\.([0-9a-f]{12})(?:\.[a-z]+)?_rgbd\.(mp4|png)$/i);
    return !(km && it.status === 'missing' && (keys.has(km[1].toLowerCase()) || !fs.existsSync(it.path)));
  });
  for (const it of L.items) {
    let st = null; try { st = fs.statSync(it.path); } catch {}
    if (!st) { if (it.status !== 'missing') { it.prevStatus = it.status; it.status = 'missing'; } continue; }
    if (it.status === 'missing') it.status = it.prevStatus || 'queued';
    if (st.size !== it.size || st.mtimeMs !== it.mtimeMs) {   // file was replaced: redo
      it.size = st.size; it.mtimeMs = st.mtimeMs; it.key = fileKey(it.path, st);
      if (it.kind === 'video2d' || it.kind === 'image2d') { it.status = 'queued'; it.cachePath = null; it.progress = 0; }
    }
    if (it.cachePath && it.status === 'ready' && !fs.existsSync(it.cachePath)) {
      it.status = 'queued'; it.cachePath = null;
      adoptCache(it);                              // the 3D folder may simply have moved
    }
  }
  for (const it of L.items) if (it.status === 'queued') adoptCache(it);   // 3D copy already there?
  mergeMoved();
  save();
  return added;
}

function find(id) { return get().items.find((i) => i.id === id); }
function patchItem(id, patch) { const it = find(id); if (it) { Object.assign(it, patch); save(); } return it; }
function removeItem(id, { deleteCache = false } = {}) {
  const L = get();
  const it = find(id);
  if (!it) return;
  if (deleteCache && it.cachePath) { for (const f of [it.cachePath, it.cachePath + '.json']) { try { fs.unlinkSync(f); } catch {} } }
  L.items = L.items.filter((i) => i.id !== id);
  save();
}
function move(id, delta) {
  const L = get();
  const i = L.items.findIndex((x) => x.id === id);
  const j = Math.max(0, Math.min(L.items.length - 1, i + delta));
  if (i < 0 || i === j) return;
  const [it] = L.items.splice(i, 1);
  L.items.splice(j, 0, it);
  save();
}
function reorder(ids) {
  const L = get();
  const map = new Map(L.items.map((i) => [i.id, i]));
  const out = ids.map((id) => map.get(id)).filter(Boolean);
  for (const i of L.items) if (!ids.includes(i.id)) out.push(i);
  L.items = out; save();
}

function playable(it) { return it.enabled && it.status === 'ready'; }

// What the players get: 'rotatebig' is 'rotate' with the turn track that also turns
// for close-ups, so the PC player and the phone need nothing new for it.
function view(it, framing) {
  const frame = it.frame || 'rotatebig';
  if (frame !== 'rotatebig') return { frame, framing };
  return { frame: 'rotate', framing: framing && framing.rotBig ? Object.assign({}, framing, { rot: framing.rotBig }) : framing };
}

module.exports = { view, load, get, save, onChange, addPaths, addFolder, removeFolder, rescan, find, patchItem, removeItem, move, reorder, playable, classify, cachePathFor, QUALITY };
