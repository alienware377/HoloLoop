'use strict';
// Runs in an Electron utilityProcess so a crash in ffmpeg or the GPU driver can
// never take the player down. One job at a time.
const { convert, convertImage } = require('./convert');
const { analyze } = require('./framing');

const port = process.parentPort;
let ctrl = null;

port.on('message', async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { ctrl?.abort(); return; }
  if (m.type === 'framing') {
    ctrl = new AbortController();
    try {
      const framing = await analyze(m.file, { rgbd: m.rgbd !== false, signal: ctrl.signal, onProgress: (p) => port.postMessage({ type: 'progress', id: m.id, p }) });
      port.postMessage({ type: 'framed', id: m.id, framing });
    } catch (err) {
      port.postMessage({ type: 'framefail', id: m.id, cancelled: !!err.cancelled, error: String(err && err.message || err).slice(0, 1000) });
    } finally { ctrl = null; }
    return;
  }
  if (m.type !== 'job') return;
  ctrl = new AbortController();
  const fn = m.job.still ? convertImage : convert;
  try {
    const meta = await fn(m.job, { signal: ctrl.signal, onProgress: (p) => port.postMessage({ type: 'progress', id: m.job.id, p }) });
    port.postMessage({ type: 'done', id: m.job.id, meta });
  } catch (err) {
    port.postMessage({ type: 'failed', id: m.job.id, cancelled: !!err.cancelled, error: String(err && err.message || err).slice(0, 2000) });
  } finally { ctrl = null; }
});

port.postMessage({ type: 'ready' });
