'use strict';
// Smaller copies of the 3D videos for the phone. The PC keeps its full-size 3D copy; this
// re-encodes it at a lower bitrate (same size, frame rate and timing, so the framing worked
// out for the original fits the copy as is) into "<3D folder>/Phone copies". The phone is
// sent the small copy once it exists.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { shell } = require('electron');
const config = require('./config');
const library = require('./library');
const log = require('./log');
const { FFMPEG, run } = require('../convert/media');

let allowed = () => true;
let current = null;                  // { id, name, out, proc, done, total }
const listeners = new Set();
let lastStatus = { state: 'idle' };
function emit(s) { lastStatus = s; for (const l of listeners) { try { l(s); } catch {} } }

function settings() { return config.get().phone || {}; }
function dir() { return path.join(config.get().convert.cacheDir, 'Phone copies'); }
const tag = (mbps) => `phone${Math.round(mbps * 10)}`;      // 6 Mbit/s -> "phone60"

function source(it) { return it.cachePath || it.path; }
function copyName(it, mbps) { return `${path.basename(source(it), path.extname(source(it)))}.${tag(mbps)}.mp4`; }

function stat(f) { try { return fs.statSync(f); } catch { return null; } }

/** Every finished phone copy of this item, any quality, newest first. */
function copiesOf(it) {
  const base = path.basename(source(it), path.extname(source(it))) + '.phone';
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.startsWith(base) && /\.phone\d+\.mp4$/.test(n)); } catch {}
  return names.map((n) => ({ file: path.join(dir(), n), st: stat(path.join(dir(), n)) })).filter((c) => c.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
}

// Only long, heavy videos are worth it: stills and quilts stay as they are, and a video
// already near the chosen bitrate gains nothing.
function wants(it) {
  const s = settings();
  if (!s.compress || !it.enabled || it.status !== 'ready' || it.still || it.meta?.still || it.kind === 'quilt') return false;
  const st = stat(source(it)), dur = it.meta?.duration;
  if (!st || !dur) return false;
  return st.size * 8 / dur > s.mbps * 1e6 * 1.25;
}

/**
 * What the phone should get for this item: the copy at the chosen quality, else an older
 * copy while the new one is made, else the original. `waiting` = a copy is on its way.
 */
function forPhone(it) {
  const orig = { file: source(it), st: stat(source(it)) };
  if (!wants(it)) return { ...orig, waiting: false };
  const want = path.join(dir(), copyName(it, settings().mbps));
  const st = stat(want);
  if (st) return { file: want, st, waiting: false };
  const older = copiesOf(it)[0];
  return older ? { ...older, waiting: true } : { ...orig, waiting: true };
}

/** For the app's video list: how this item's phone copy is doing. */
function describe(it) {
  if (current && current.id === it.id) return { state: 'making', progress: current.total ? current.done / current.total : 0 };
  if (!wants(it)) return null;
  const st = stat(path.join(dir(), copyName(it, settings().mbps)));
  return st ? { state: 'ready', size: st.size } : { state: 'waiting' };
}

/** The file to send for /files/<id>; `name` picks an exact one the phone asked for. */
function fileFor(it, name) {
  if (name) {
    if (name === path.basename(source(it))) return source(it);
    const c = copiesOf(it).find((x) => path.basename(x.file) === name);
    if (c) return c.file;
  }
  return forPhone(it).file;
}

// ------------------------------------------------------------------ encoding
let encoder = null;
async function pickEncoder() {
  if (encoder) return encoder;
  const kbps = (m) => `${Math.round(m * 1000)}k`;
  const cands = [
    { name: 'hevc_nvenc', args: (m) => ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6), '-bufsize', kbps(m * 2), '-spatial-aq', '1'] },
    { name: 'hevc_qsv', args: (m) => ['-c:v', 'hevc_qsv', '-preset', 'slow', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6)] },
    { name: 'hevc_amf', args: (m) => ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6)] },
    { name: 'libx265', args: (m) => ['-c:v', 'libx265', '-preset', 'fast', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6), '-bufsize', kbps(m * 2)] },
  ];
  for (const c of cands) {
    try {
      await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=2560x720:d=0.2', '-pix_fmt', 'yuv420p', ...c.args(4), '-f', 'null', '-'], { timeout: 20000 });
      encoder = c; break;
    } catch {}
  }
  encoder = encoder || cands[cands.length - 1];
  log.info(`phone copies use ${encoder.name}`);
  return encoder;
}

function next() {
  // in loop order, like the phone fetches them, so the videos it already has get swapped first
  return library.get().items.find((it) => wants(it) && !failed.has(it.id) && !stat(path.join(dir(), copyName(it, settings().mbps))));
}

async function make(it) {
  const mbps = settings().mbps;
  const out = path.join(dir(), copyName(it, mbps));
  const part = out + '.part';
  fs.mkdirSync(dir(), { recursive: true });
  const enc = await pickEncoder();
  const total = it.meta?.duration || 0;
  current = { id: it.id, name: it.name, out, done: 0, total, mbps };
  emit({ state: 'working', id: it.id, name: it.name, done: 0, total });
  const args = ['-hide_banner', '-v', 'error', '-y', '-hwaccel', 'auto', '-i', source(it),
    '-map', '0:v:0', '-map', '0:a?', ...enc.args(mbps), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-fps_mode', 'passthrough',
    '-c:a', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', part];
  const t0 = Date.now();
  const ok = await new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    current.proc = p;
    let err = '';
    p.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
    p.stdout.on('data', (b) => {
      const m = /out_time_us=(\d+)/.exec(String(b).split('\n').reverse().join('\n'));
      if (m && current) {
        current.done = Number(m[1]) / 1e6;
        const speed = current.done / Math.max(1, (Date.now() - t0) / 1000);
        emit({ state: 'working', id: it.id, name: it.name, done: current.done, total, speed, eta: speed > 0 ? (total - current.done) / speed : null });
      }
    });
    p.on('close', (code) => { if (code !== 0 && !current?.cancelled) log.warn(`phone copy of ${it.name} failed: ${err.trim().split('\n').pop()}`); resolve(code === 0); });
  });
  const cancelled = current?.cancelled;
  current = null;
  if (!ok) { try { fs.unlinkSync(part); } catch {} if (!cancelled) failed.add(it.id); return; }
  fs.renameSync(part, out);
  const st = stat(out), orig = stat(source(it));
  log.info(`phone copy of ${it.name}: ${(st.size / 1e9).toFixed(2)} GB (was ${(orig.size / 1e9).toFixed(2)} GB) in ${Math.round((Date.now() - t0) / 1000)} s`);
  // copies at other qualities aren't needed any more: to the Recycle Bin
  for (const c of copiesOf(it)) if (c.file !== out) shell.trashItem(c.file).catch(() => {});
  library.patchItem(it.id, {});        // tell the app and the phone
}

const failed = new Set();             // tried this session and ffmpeg refused: don't loop on it
let busy = false;
async function tick() {
  if (busy && !current) return;        // still picking the encoder for the next one
  if (current) {
    // stop when paused, or when the chosen quality changed under us
    const s = settings();
    if (!s.compress || s.mbps !== current.mbps || !allowed() || config.get().convert.paused) { current.cancelled = true; try { current.proc?.kill(); } catch {} }
    return;
  }
  if (!settings().compress || config.get().convert.paused || !allowed()) { emit({ state: 'idle' }); return; }
  const it = next();
  if (!it) { emit({ state: 'idle' }); return; }
  busy = true;
  try { await make(it); } catch (e) { log.warn('phone copy: ' + e.message); current = null; failed.add(it.id); }
  busy = false;
  setTimeout(tick, 500);
}

/** Everything the slider's size estimate needs, per item: original size and length. */
function sizes() {
  return library.get().items.filter((it) => it.enabled && it.status === 'ready' && !it.still && it.kind !== 'quilt')
    .map((it) => ({ id: it.id, size: stat(source(it))?.size || 0, duration: it.meta?.duration || 0 }));
}

function start(allowFn) {
  allowed = allowFn || allowed;
  process.on('exit', () => { try { current?.proc?.kill(); } catch {} });     // don't leave ffmpeg running after quit
  config.onChange(() => setTimeout(tick, 200));
  setInterval(tick, 20000);
  setTimeout(tick, 5000);
}

module.exports = { start, tick, forPhone, fileFor, describe, sizes, status: () => lastStatus, onStatus: (f) => { listeners.add(f); return () => listeners.delete(f); } };
