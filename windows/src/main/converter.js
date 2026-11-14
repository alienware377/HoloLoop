'use strict';
// Keeps the 3D cache filled: picks the next 2D item, hands it to the worker
// process, tracks progress. Chunks already finished survive pauses and reboots.
const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');
const config = require('./config');
const library = require('./library');
const log = require('./log');
const hevc = require('./hevc');
const { pickSmallEncoder } = require('../convert/media');

let worker = null, workerReady = false, current = null, idleTimer = null;
const FRAMING_V = 5;           // bump when framing rules change, so videos get re-checked
let allowed = () => true;            // set by main: sleep/when policy
const listeners = new Set();
let lastStatus = { state: 'idle' };
function emit(s) { lastStatus = s; for (const l of listeners) { try { l(s); } catch {} } }

// With phone copies on, 3D copies are made at the phone's size in one go, but only when this
// PC can play HEVC and has a graphics card encoder for it. null = not checked yet.
let onePass = null;
async function checkOnePass() {
  const [plays, enc] = await Promise.all([hevc.ask(), pickSmallEncoder().catch(() => null)]);
  onePass = !!plays && !!enc && enc.name !== 'libx265';
  log.info(`3D copies at the phone's size in one go: ${onePass ? 'possible' : 'not on this PC'}`);
}

function ensureWorker() {
  if (worker) return;
  worker = utilityProcess.fork(path.join(__dirname, '..', 'convert', 'worker.js'), [], { serviceName: 'HoloLoop converter', stdio: 'pipe' });
  workerReady = false;
  worker.stdout?.on('data', (b) => log.info('[conv] ' + String(b).trim()));
  worker.stderr?.on('data', (b) => { const t = String(b).trim(); if (t && !/W:onnxruntime/.test(t)) log.warn('[conv] ' + t); });
  worker.on('message', onMessage);
  worker.on('exit', (code) => {
    log.warn('converter worker exited ' + code);
    worker = null; workerReady = false;
    if (current) { requeue(library.find(current.id)); current = null; }
    setTimeout(tick, 3000);
  });
}

// A deliberate stop: drop the exit handler first, it would log a crash and restart the lane.
function stopWorker() {
  const w = worker; worker = null; workerReady = false;
  if (w) { w.removeAllListeners('exit'); try { w.kill(); } catch {} }
}

function onMessage(m) {
  if (m.type === 'ready') { workerReady = true; tick(); return; }
  if (!current || m.id !== current.id) return;
  if (m.type === 'progress') {
    const p = m.p;
    current.p = p;
    library.patchItem(current.id, { progress: p.total ? p.done / p.total : 0, eta: p.eta, speed: p.speed });
    emit({ state: 'working', id: current.id, name: current.name, ...p });
  } else if (m.type === 'done') {
    log.info(`converted ${current.name} (${m.meta.backend}, ${m.meta.encoder || 'png'})`);
    finish(current.id, current.outFile, m.meta);
    current = null; emit({ state: 'idle' });
    setTimeout(tick, 200);
  } else if (m.type === 'failed') {
    const it = library.find(current.id);
    if (m.cancelled) requeue(it);
    else {
      log.warn(`convert failed ${current.name}: ${m.error}`);
      library.patchItem(current.id, current.redo ? { redo: 'failed', error: m.error } : { status: 'failed', error: m.error });
    }
    if (it && library.cachePathFor(it, cacheDir()) !== current.outFile) dropFiles(current.outFile + '.work');
    current = null; emit({ state: 'idle' });
    setTimeout(tick, 1000);
  }
}

// ------------------------------------------------------------------ framing lane
let fworker = null, fready = false, fcurrent = null, fidle = null;

function ensureFrameWorker() {
  if (fworker) return;
  fworker = utilityProcess.fork(path.join(__dirname, '..', 'convert', 'worker.js'), [], { serviceName: 'HoloLoop framing', stdio: 'pipe' });
  fready = false;
  fworker.stderr?.on('data', (b) => { const t = String(b).trim(); if (t && !/W:onnxruntime/.test(t)) log.warn('[frame] ' + t); });
  fworker.on('message', onFrameMessage);
  fworker.on('exit', (code) => { log.warn('framing worker exited ' + code); fworker = null; fready = false; fcurrent = null; setTimeout(tickFrame, 3000); });
}

function onFrameMessage(m) {
  if (m.type === 'ready') { fready = true; tickFrame(); return; }
  if (!fcurrent || m.id !== fcurrent.id) return;
  if (m.type === 'framed' || m.type === 'framefail') {
    const it = library.find(fcurrent.id);
    if (m.type === 'framed' && it) {
      const meta = Object.assign({}, it.meta || { kind: 'rgbd', depthLoc: 2 }, { framing: m.framing });
      if (!meta.width && m.framing.width) { meta.width = m.framing.width; meta.height = m.framing.height; }
      library.patchItem(it.id, { meta });
      if (it.cachePath) { try { fs.writeFileSync(it.cachePath + '.json', JSON.stringify(meta, null, 2)); } catch {} }
      const turns = (m.framing.rot || []).filter((k, i, a) => i > 0 && k[1] !== a[i - 1][1]).length;
      log.info(`framing for ${it.name}: ${m.framing.summary.decided} (${m.framing.keys.length} keys, ${turns} turns)`);
    } else if (it && !m.cancelled) {
      log.warn(`framing failed for ${fcurrent.name}: ${m.error}`);
      library.patchItem(it.id, { meta: Object.assign({}, it.meta, { framing: { failed: true, v: FRAMING_V } }) });
    }
    fcurrent = null;
    setTimeout(tickFrame, 200);
  }
}

function stopFrameWorker() {
  const w = fworker; fworker = null; fready = false;
  if (w) { w.removeAllListeners('exit'); try { w.kill(); } catch {} }
}

function tickFrame() {
  if (fcurrent) return;
  const fr = needsFraming();
  if (!fr) {
    // close an idle worker after a minute; the regular ticks must not keep pushing that back
    if (fworker && !fidle) fidle = setTimeout(() => { fidle = null; if (!fcurrent && !needsFraming()) stopFrameWorker(); }, 60000);
    return;
  }
  clearTimeout(fidle); fidle = null;
  ensureFrameWorker();
  if (!fready) return;
  fcurrent = { id: fr.id, name: fr.name };
  fworker.postMessage({ type: 'framing', id: fr.id, file: fr.cachePath || fr.path, rgbd: true });
}

function nextItem() {
  const items = library.get().items.filter((i) => i.enabled);
  return items.find((i) => i.status === 'queued') || items.find((i) => i.status === 'ready' && i.redo === true);
}

// A stopped job goes back in line, unless a detail change already moved it on.
function requeue(it) {
  if (!it) return;
  if (it.redo === 'working') library.patchItem(it.id, { redo: true });
  else if (it.status === 'converting') library.patchItem(it.id, { status: 'queued' });
}

function outFileFor(it) { return library.cachePathFor(it, cacheDir()).replace(/\.mp4$/, it.still ? '.png' : '.mp4'); }

function dropFiles(...files) { for (const f of files) { try { fs.rmSync(f, { recursive: true, force: true }); } catch {} } }

// A finished 3D copy. When it replaces an older copy at another detail level, that copy
// and its phone copies go, so each video keeps one.
function finish(id, outFile, meta) {
  const it = library.find(id);
  if (!it) return;
  const old = it.cachePath;
  library.patchItem(id, { status: 'ready', cachePath: outFile, progress: 1, error: null, meta, eta: null, redo: null });
  if (outFile !== outFileFor(it)) library.patchItem(id, { redo: true });   // detail or model changed while it ran
  if (old && old !== outFile) {
    const base = path.basename(old, path.extname(old)) + '.phone', pdir = path.join(path.dirname(old), 'Phone copies');
    let phones = []; try { phones = fs.readdirSync(pdir).filter((n) => n.startsWith(base)).map((n) => path.join(pdir, n)); } catch {}
    dropFiles(old, old + '.json', ...phones);
  }
}

/** Per-video depth detail. A finished video keeps playing its old copy until the new one is made. */
function setQuality(id, q) { setOwn(id, { quality: library.QUALITY[q] ? q : null }); }

/** Per-video depth model, the same way. */
function setModel(id, m) { setOwn(id, { model: library.DEPTH_MODELS[m] ? m : null }); }

function setOwn(id, patch) {
  const it = library.find(id);
  if (!it || (it.kind !== 'video2d' && it.kind !== 'image2d')) return;
  if (Object.keys(patch).every((k) => (it[k] || null) === patch[k])) return;
  if (it.status === 'ready' && it.cachePath) {
    const redo = path.basename(it.cachePath) !== path.basename(outFileFor(Object.assign({}, it, patch)));   // the 3D folder may have moved
    Object.assign(patch, { redo: redo || null, error: null, progress: redo ? 0 : 1 });
  } else if (it.status === 'failed') Object.assign(patch, { status: 'queued', error: null });
  else if (it.status === 'converting') patch.status = 'queued';
  library.patchItem(id, patch);
  if (current && current.id === id) cancel();
  tick();
}

// Ready 3D videos that still need their framing worked out (new ones, and ones
// converted before framing existed). Quilts keep their own framing.
function needsFraming() {
  const todo = library.get().items.filter((i) => i.enabled && i.status === 'ready' && i.kind !== 'quilt' &&
    !(i.meta && i.meta.framing && (i.meta.framing.failed || ((i.meta.framing.v || 1) >= FRAMING_V && ((i.frame || 'rotatebig') !== 'rotatebig' || i.meta.framing.rotBig))))
    && (i.cachePath || i.kind === 'rgbd'));
  // videos set to "turn" first, then the shortest, so quick ones are never stuck behind a long stream
  const turns = (i) => ((i.frame || 'rotatebig') === 'rotatebig' ? 2 : i.frame === 'rotate' ? 1 : 0);
  todo.sort((a, b) => (turns(b) - turns(a)) || ((a.meta?.duration || 1e9) - (b.meta?.duration || 1e9)));
  return todo[0];
}

function cacheDir() {
  const d = config.get().convert.cacheDir;
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function tick() {
  const c = config.get().convert;
  const may = c.enabled && !c.paused && allowed();
  if (current && !may) { cancel(); return; }
  if (may) tickFrame();                    // framing runs in its own lane, also while a video converts
  if (current || !may) { scheduleIdleStop(); return; }
  const it = nextItem();
  if (!it) { emit(fcurrent ? { state: 'working', id: fcurrent.id, name: fcurrent.name, stage: 'framing', done: 0, total: 0 } : { state: 'idle' }); scheduleIdleStop(); return; }

  // Already converted (same file seen before, or a cache copied from another PC)?
  const outFile = outFileFor(it);
  if (fs.existsSync(outFile) && fs.existsSync(outFile + '.json')) {
    let meta = null; try { meta = JSON.parse(fs.readFileSync(outFile + '.json', 'utf8')); } catch {}
    finish(it.id, outFile, meta);
    setTimeout(tick, 50);
    return;
  }
  const phone = config.get().phone || {};
  if (phone.compress && onePass === null) return;      // the check above runs once at start
  clearTimeout(idleTimer); idleTimer = null;
  ensureWorker();
  if (!workerReady) return;
  const redo = it.status === 'ready';
  current = { id: it.id, name: it.name, outFile, redo };
  library.patchItem(it.id, redo ? { redo: 'working', progress: 0, error: null } : { status: 'converting', progress: it.progress || 0, error: null });
  emit({ state: 'working', id: it.id, name: it.name, stage: 'starting', done: 0, total: 0 });
  worker.postMessage({ type: 'job', job: {
    id: it.id, src: it.path, still: !!it.still, outFile, workDir: outFile + '.work',
    settings: { maxLong: c.maxLong, depthLong: library.QUALITY[it.quality] || c.depthLong, model: library.DEPTH_MODELS[it.model] ? it.model : (library.DEPTH_MODELS[c.depthModel] ? c.depthModel : 'standard'),
      backend: c.backend, chunkSec: 60, mbps: phone.compress && onePass ? phone.mbps : 0 },
  } });
}

function scheduleIdleStop() {
  if (worker && !current && !idleTimer) idleTimer = setTimeout(() => { idleTimer = null; if (!current) stopWorker(); }, 60000);  // free the GPU
}

function cancel() { if (current && worker) worker.postMessage({ type: 'cancel' }); }

function retry(id) { const it = library.find(id); library.patchItem(id, it && it.redo ? { redo: true, error: null } : { status: 'queued', error: null }); tick(); }

function start(allowFn) {
  allowed = allowFn || allowed;
  library.onChange(() => setTimeout(current ? tickFrame : tick, 100));
  config.onChange(() => tick());
  setInterval(tick, 15000);
  checkOnePass().catch(() => { onePass = false; }).finally(() => tick());
  tick();
}

module.exports = { start, tick, cancel, retry, setQuality, setModel, onePass: () => !!onePass, status: () => lastStatus, onStatus: (f) => { listeners.add(f); return () => listeners.delete(f); } };
