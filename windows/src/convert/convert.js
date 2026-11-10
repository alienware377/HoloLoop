'use strict';
// 2D video -> RGBD video (colour left, depth right), in resumable chunks so a
// three-hour film survives reboots, sleep windows and pauses.
//
//   ffmpeg A  decodes small RGB frames  --> depth model --> 8-bit depth
//   ffmpeg B  decodes the same frames at full size, takes depth on stdin,
//             stacks colour|depth side by side and encodes the chunk.
// Both decoders use the same seek + fps filter, so their frames line up 1:1.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { FFMPEG, run, probe, pickEncoder, spawn } = require('./media');
const { DepthEngine, modelSize } = require('./depth');

const { VERSION } = require('./version');

function even(v) { return Math.max(2, Math.round(v / 2) * 2); }

function outGeometry(info, maxLong) {
  const k = Math.min(1, maxLong / Math.max(info.width, info.height));
  return { CW: even(info.width * k), CH: even(info.height * k) };
}

function lowPriority(child) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }

// frames of piece i on the whole video's frame grid (frame k sits at k / fps), so the pieces add up exactly
function pieceFrames(info, chunkSec, i) {
  const at = (t) => Math.ceil(Math.min(info.duration, t) * info.fps - 1e-6);
  return Math.max(1, at((i + 1) * chunkSec) - at(i * chunkSec));
}

async function convertChunk(ctx, i) {
  const { src, info, geo, msz, engine, enc, workDir, chunkSec, signal, onFrame } = ctx;
  const start = i * chunkSec;
  const want = pieceFrames(info, chunkSec, i);
  const len = Math.min(chunkSec, info.duration - start) + 2 / info.fps;   // a little extra; -frames:v trims it
  const out = path.join(workDir, `chunk_${String(i).padStart(5, '0')}.mp4`);
  const tmp = out + '.part.mp4';
  // Every piece gets exactly its share of the whole video's frames, numbered from 0. Cutting by
  // time alone gave a frame or two too many per piece, so the picture slowly fell behind the sound.
  // start_time=0 keeps the frame grid on the piece's start (a picture that starts after the sound
  // is padded with its first frame, as before).
  const fpsF = `fps=${info.rate}:start_time=0,setpts=N/FRAME_RATE/TB`;

  const dec = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-ss', String(start), '-t', String(len), '-i', src, '-an', '-sn',
    '-vf', `${fpsF},scale=${msz.W}:${msz.H}:flags=area,format=rgb24`, '-frames:v', String(want), '-fps_mode', 'passthrough',
    '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
  const encP = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-y',
    '-ss', String(start), '-t', String(len), '-i', src,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${msz.W}x${msz.H}`, '-r', info.rate, '-i', 'pipe:0',
    '-filter_complex', `[0:v]${fpsF},scale=${geo.CW}:${geo.CH}:flags=lanczos,setsar=1,format=yuv420p[c];` +
      `[1:v]setpts=N/FRAME_RATE/TB,scale=${geo.CW}:${geo.CH}:flags=bicubic,setsar=1,format=yuv420p[d];[c][d]hstack=inputs=2:shortest=1[v]`,
    '-map', '[v]', '-an', '-pix_fmt', 'yuv420p', ...enc.args, '-g', String(Math.round(info.fps * 2)),
    '-frames:v', String(want), '-r', info.rate, '-f', 'mp4', tmp], { windowsHide: true });
  lowPriority(dec); lowPriority(encP);

  let errText = '', decErr = '', decCode = null;
  dec.stderr.on('data', (b) => { errText += b; decErr += b; });
  encP.stderr.on('data', (b) => { errText += b; });
  const kill = () => { try { dec.kill(); } catch {} try { encP.kill(); } catch {} };
  signal?.addEventListener('abort', kill, { once: true });

  const frameBytes = msz.W * msz.H * 3;
  let buf = Buffer.alloc(0), frames = 0, chain = Promise.resolve(), failed = null;
  let encGone = false;
  const encDone = new Promise((res) => encP.on('close', (code) => { encGone = true; res(code); }));
  encP.stdin.on('error', () => {});

  // Backpressure: stop reading frames while the model works through what we have. Frames go
  // to the model `engine.batch` at a time; the last few of the piece go as a smaller group.
  const B = engine.batch || 1;
  let busy = false;
  const work = async (final) => {
    while (!failed && !signal?.aborted && (buf.length >= frameBytes * B || (final && buf.length >= frameBytes))) {
      const k = Math.min(B, Math.floor(buf.length / frameBytes)), group = [];
      for (let g = 0; g < k; g++) group.push(buf.subarray(g * frameBytes, (g + 1) * frameBytes));
      try {
        const res = await engine.inferMany(group);
        buf = buf.subarray(k * frameBytes);
        for (const { depth } of res) {
          frames++;
          onFrame?.(start + frames / info.fps);
          if (encGone) throw new Error(`chunk ${i}: the encoder stopped: ${errText.slice(-400)}`);
          if (!encP.stdin.write(Buffer.from(depth.buffer, depth.byteOffset, depth.byteLength))) {
            await Promise.race([new Promise((r) => encP.stdin.once('drain', r)), encDone]);
          }
        }
      } catch (e) { failed = e; kill(); }
    }
  };
  await new Promise((resolve) => {
    dec.stdout.on('data', (b) => {
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      if (busy || buf.length < frameBytes * B) return;
      busy = true; dec.stdout.pause();
      chain = chain.then(() => work(false)).then(() => { busy = false; dec.stdout.resume(); });
    });
    dec.on('close', (c) => { decCode = c; chain = chain.then(() => work(true)); resolve(); });
  });
  await chain;
  try { encP.stdin.end(); } catch {}
  const code = await encDone;
  signal?.removeEventListener?.('abort', kill);
  if (signal?.aborted) { try { fs.unlinkSync(tmp); } catch {} throw Object.assign(new Error('cancelled'), { cancelled: true }); }
  if (failed) throw failed;
  if (code === 0 && frames === 0 && decCode === 0 && !decErr.trim() && i > 0 && (ctx.last || ctx.prevShort || ctx.maybeEnd)) { try { fs.unlinkSync(tmp); } catch {} return { out: null, frames: 0 }; }   // the picture ended a little early
  if (code !== 0 || frames === 0) { try { fs.unlinkSync(tmp); } catch {} throw new Error(`chunk ${i} failed (code ${code}, ${frames} frames): ${errText.slice(-400)}`); }
  fs.renameSync(tmp, out);
  return { out, frames, want };
}

/**
 * job: { src, outFile, workDir, settings: { maxLong, depthLong, model, chunkSec, backend } }
 * hooks: { onProgress({done,total,fps,eta,stage}), signal }
 */
async function convert(job, hooks = {}) {
  const s = Object.assign({ maxLong: 1280, depthLong: 518, model: 'standard', chunkSec: 60, backend: 'auto' }, job.settings || {});
  // MPEG-TS/PS files seek by guesswork, so 60 s pieces overlapped or skipped and the picture
  // drifted from the sound; a straight copy into mkv (no re-encode) seeks exactly
  let src = job.src, info = await probe(src);
  if (/(^|,)(mpegts|mpeg)(,|$)/.test(info.container || '')) {
    let st = null; try { st = fs.statSync(job.src); } catch {}
    const mkv = path.join(job.workDir, `source_${st ? st.size : 0}.mkv`);
    try {
      fs.mkdirSync(job.workDir, { recursive: true });
      if (!fs.existsSync(mkv)) {
        await run(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', job.src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'matroska', mkv + '.part']);
        fs.renameSync(mkv + '.part', mkv);
      }
      info = await probe(mkv); src = mkv;
    } catch { try { fs.unlinkSync(mkv + '.part'); } catch {} src = job.src; info = await probe(src); }
  }
  if (!info.duration) throw new Error('could not read the video length');
  const geo = outGeometry(info, s.maxLong);
  const msz = modelSize(geo.CW, geo.CH, s.depthLong);
  fs.mkdirSync(job.workDir, { recursive: true });

  const stateFile = path.join(job.workDir, 'job.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  // identify the source by name + size, not by folder, so moving it keeps finished pieces
  let size = 0; try { size = fs.statSync(job.src).size; } catch {}
  const sig = { v: VERSION, pieces: 3, file: path.basename(job.src).toLowerCase(), size, geo, msz, model: s.model, chunkSec: s.chunkSec, rate: info.rate };
  if (JSON.stringify(state.sig) !== JSON.stringify(sig)) state = { sig, done: [] };   // settings changed: start over
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();

  // Several pieces at once, each with its own depth model: one alone leaves the GPU waiting
  // while JavaScript and ffmpeg work between frames. Pieces are independent (the depth's
  // flicker control restarts per piece), so the order they finish in doesn't matter.
  const lanes = Math.max(1, Math.min(4, s.lanes || 1));
  const engines = [];
  let backend = null;
  for (let k = 0; k < lanes; k++) {
    const e = new DepthEngine();
    try { const b = await e.open(msz.W, msz.H, s.backend, s.batch || 4, s.model); if (!backend) backend = b; engines.push(e); }
    catch (err) { if (!engines.length) throw err; break; }     // no room for another: run with what opened
    if (!backend.startsWith('dml')) break;                       // CPU fallback: one is plenty
  }
  const enc = await pickEncoder();
  let nChunks = Math.ceil(info.duration / s.chunkSec);
  const t0 = Date.now(); let doneSec = state.done.length * s.chunkSec, sessionSec = 0;
  const report = (stage, posSec) => {
    const el = (Date.now() - t0) / 1000;
    const speed = sessionSec > 0 && el > 0 ? sessionSec / el : 0;       // video seconds per second
    const total = info.duration, done = Math.min(total, posSec ?? doneSec);
    hooks.onProgress?.({ stage, done, total, speed, eta: speed > 0 ? (total - done) / speed : null, backend, encoder: enc.name });
  };

  const have = (i) => state.done.includes(i) && fs.existsSync(path.join(job.workDir, `chunk_${String(i).padStart(5, '0')}.mp4`));
  const frames = new Map();          // piece -> frames made this run
  let empty = Infinity;              // first piece with no picture: the video ended before it
  let next = 0, failure = null;
  const partial = new Map();         // piece -> seconds done so far, for progress
  const progress = () => (state.done.length - [...partial.keys()].filter((i) => state.done.includes(i)).length) * s.chunkSec
    + [...partial.values()].reduce((a, b) => a + b, 0);
  const lane = async (engine) => {
    while (!failure && !hooks.signal?.aborted) {
      const i = next++;
      if (i >= nChunks || i > empty) return;
      if (have(i)) continue;
      engine.resetTemporal();
      let lastPos = i * s.chunkSec;
      partial.set(i, 0);
      try {
        const r = await convertChunk({ src, info, geo, msz, engine, enc, workDir: job.workDir, chunkSec: s.chunkSec, signal: hooks.signal,
          last: i === nChunks - 1, prevShort: frames.has(i - 1) && frames.get(i - 1) < pieceFrames(info, s.chunkSec, i - 1) - 1, maybeEnd: true,
          onFrame: (pos) => { sessionSec += pos - lastPos; lastPos = pos; partial.set(i, pos - i * s.chunkSec); report('depth', progress()); } }, i);
        if (!r.out) { empty = Math.min(empty, i); continue; }
        frames.set(i, r.frames);
        state.done.push(i); save();
      } catch (e) { failure = failure || e; } finally { partial.delete(i); }
    }
  };
  try { await Promise.all(engines.map(lane)); } finally { for (const e of engines) await e.close(); }
  if (failure) throw failure;
  if (empty < Infinity) {
    // a piece with no picture is only fine at the end: everything after it must be empty too
    for (let i = empty + 1; i < nChunks; i++) if (have(i)) throw new Error(`chunk ${empty} had no picture but chunk ${i} did`);
    nChunks = empty;
  }
  doneSec = nChunks * s.chunkSec;

  report('joining', info.duration);
  const list = path.join(job.workDir, 'list.txt');
  fs.writeFileSync(list, Array.from({ length: nChunks }, (_, i) => `file 'chunk_${String(i).padStart(5, '0')}.mp4'`).join('\n'));
  const tmpOut = job.outFile + '.part.mp4';
  const args = ['-hide_banner', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (info.hasAudio) args.push('-i', src, '-map', '0:v', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '160k', '-shortest');
  else args.push('-map', '0:v');
  args.push('-c:v', 'copy', '-movflags', '+faststart', tmpOut);
  await run(FFMPEG, args);
  fs.renameSync(tmpOut, job.outFile);
  const meta = { kind: 'rgbd', depthLoc: 2, version: VERSION, width: geo.CW * 2, height: geo.CH, colorW: geo.CW, colorH: geo.CH,
    depthW: msz.W, depthH: msz.H, model: s.model, fps: info.fps, duration: Math.min(info.duration, nChunks * s.chunkSec), src: job.src, backend, encoder: enc.name, made: new Date().toISOString() };
  fs.writeFileSync(job.outFile + '.json', JSON.stringify(meta, null, 2));
  fs.rmSync(job.workDir, { recursive: true, force: true });
  report('done', info.duration);
  return meta;
}

// A single 2D picture -> RGBD PNG (colour left, depth right).
async function convertImage(job, hooks = {}) {
  const s = Object.assign({ maxLong: 1600, depthLong: 518, model: 'standard', backend: 'auto' }, job.settings || {});
  const info = await probe(job.src);
  const geo = outGeometry(info, Math.max(s.maxLong, 1600));
  const msz = modelSize(geo.CW, geo.CH, s.depthLong);
  const { stdout } = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-i', job.src, '-frames:v', '1', '-vf', `scale=${msz.W}:${msz.H}:flags=area,format=rgb24`, '-f', 'rawvideo', 'pipe:1'], { windowsHide: true });
    const chunks = []; p.stdout.on('data', (b) => chunks.push(b)); p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve({ stdout: Buffer.concat(chunks) }) : reject(new Error('could not read the picture')));
  });
  const engine = new DepthEngine();
  const backend = await engine.open(msz.W, msz.H, s.backend, 1, s.model);
  const { depth } = await engine.infer(stdout, { smooth: 0 });
  await engine.close();
  const tmpOut = job.outFile + '.part.png';
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-i', job.src, '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${msz.W}x${msz.H}`, '-i', 'pipe:0',
      '-filter_complex', `[0:v]scale=${geo.CW}:${geo.CH}:flags=lanczos,format=rgb24[c];[1:v]scale=${geo.CW}:${geo.CH}:flags=bicubic,format=rgb24[d];[c][d]hstack=inputs=2[v]`,
      '-map', '[v]', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', tmpOut], { windowsHide: true });
    let err = ''; p.stderr.on('data', (b) => { err += b; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('could not save the 3D picture: ' + err.slice(-300))));
    p.stdin.end(Buffer.from(depth.buffer, depth.byteOffset, depth.byteLength));
  });
  fs.renameSync(tmpOut, job.outFile);
  const meta = { kind: 'rgbd', still: true, depthLoc: 2, version: VERSION, width: geo.CW * 2, height: geo.CH, model: s.model, src: job.src, backend, made: new Date().toISOString() };
  fs.writeFileSync(job.outFile + '.json', JSON.stringify(meta, null, 2));
  hooks.onProgress?.({ stage: 'done', done: 1, total: 1, speed: 0, eta: 0, backend });
  return meta;
}

module.exports = { convert, convertImage, VERSION };
