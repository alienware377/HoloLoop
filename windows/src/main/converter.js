'use strict';
// Keeps the 3D cache filled: picks the next 2D item, hands it to the worker
// process, tracks progress. Chunks already finished survive pauses and reboots.
const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');
const config = require('./config');
const library = require('./library');
const log = require('./log');

let worker = null, workerReady = false, current = null, idleTimer = null;
const FRAMING_V = 5;           // bump when framing rules change, so videos get re-checked
let allowed = () => true;            // set by main: sleep/when policy
const listeners = new Set();
let lastStatus = { state: 'idle' };
function emit(s) { lastStatus = s; for (const l of listeners) { try { l(s); } catch {} } }

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
    if (current) {
      library.patchItem(current.id, { status: 'queued' });
      current = null;
    }
    setTimeout(tick, 3000);
  });
}

function stopWorker() { try { worker?.kill(); } catch {} worker = null; workerReady = false; }

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
    library.patchItem(current.id, { status: 'ready', cachePath: current.outFile, progress: 1, error: null, meta: m.meta, eta: null });
    current = null; emit({ state: 'idle' });
    setTimeout(tick, 200);
  } else if (m.type === 'failed') {
    if (m.cancelled) library.patchItem(current.id, { status: 'queued' });
    else { log.warn(`convert failed ${current.name}: ${m.error}`); library.patchItem(current.id, { status: 'failed', error: m.error }); }
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

function tickFrame() {
  clearTimeout(fidle);
  if (fcurrent) return;
  const fr = needsFraming();
  if (!fr) { if (fworker) fidle = setTimeout(() => { if (!fcurrent) { try { fworker?.kill(); } catch {} fworker = null; fready = false; } }, 60000); return; }
  ensureFrameWorker();
  if (!fready) return;
  fcurrent = { id: fr.id, name: fr.name };
  fworker.postMessage({ type: 'framing', id: fr.id, file: fr.cachePath || fr.path, rgbd: true });
}

function nextItem() {
  return library.get().items.find((i) => i.enabled && i.status === 'queued');
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
  clearTimeout(idleTimer);
  const c = config.get().convert;
  const may = c.enabled && !c.paused && allowed();
  if (current && !may) { cancel(); return; }
  if (may) tickFrame();                    // framing runs in its own lane, also while a video converts
  if (current || !may) { scheduleIdleStop(); return; }
  const it = nextItem();
  if (!it) { emit(fcurrent ? { state: 'working', id: fcurrent.id, name: fcurrent.name, stage: 'framing', done: 0, total: 0 } : { state: 'idle' }); scheduleIdleStop(); return; }

  // Already converted (same file seen before, or a cache copied from another PC)?
  const outFile = library.cachePathFor(it, cacheDir()).replace(/\.mp4$/, it.still ? '.png' : '.mp4');
  if (fs.existsSync(outFile) && fs.existsSync(outFile + '.json')) {
    let meta = null; try { meta = JSON.parse(fs.readFileSync(outFile + '.json', 'utf8')); } catch {}
    library.patchItem(it.id, { status: 'ready', cachePath: outFile, progress: 1, meta });
    setTimeout(tick, 50);
    return;
  }
  ensureWorker();
  if (!workerReady) return;
  current = { id: it.id, name: it.name, outFile };
  library.patchItem(it.id, { status: 'converting', progress: it.progress || 0, error: null });
  emit({ state: 'working', id: it.id, name: it.name, stage: 'starting', done: 0, total: 0 });
  worker.postMessage({ type: 'job', job: {
    id: it.id, src: it.path, still: !!it.still, outFile, workDir: outFile + '.work',
    settings: { maxLong: c.maxLong, depthLong: c.depthLong, backend: c.backend, chunkSec: 60 },
  } });
}

function scheduleIdleStop() {
  clearTimeout(idleTimer);
  if (worker && !current) idleTimer = setTimeout(() => { if (!current) stopWorker(); }, 60000);  // free the GPU
}

function cancel() { if (current && worker) worker.postMessage({ type: 'cancel' }); }

function retry(id) { library.patchItem(id, { status: 'queued', error: null }); tick(); }

function start(allowFn) {
  allowed = allowFn || allowed;
  library.onChange(() => setTimeout(current ? tickFrame : tick, 100));
  config.onChange(() => tick());
  setInterval(tick, 15000);
  tick();
}

module.exports = { start, tick, cancel, retry, status: () => lastStatus, onStatus: (f) => { listeners.add(f); return () => listeners.delete(f); } };
