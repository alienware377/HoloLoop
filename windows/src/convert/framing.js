'use strict';
// Picks the best way to fit each video onto the tall Go screen, shot by shot.
//
// For every sampled frame we build a "where is the interesting stuff" profile
// across the width from three things: faces (YuNet), things close to the camera
// (the depth map we already made) and motion. Then, per shot (cut to cut):
//   - follow : a portrait-width slice holds most of the interest -> crop to it
//              and pan smoothly along with the subject
//   - half   : the action is wider -> zoom in part way (thin bars)
//   - fit    : interest is spread over the whole frame -> show it all
// Black bars burned into the video are trimmed first. The player applies the
// result while playing, so nothing has to be re-encoded.
// Ideas borrowed from the VOD clipper: per-shot handling so crops jump at cuts
// instead of sliding across them, heavy Gaussian smoothing, Douglas-Peucker
// knots, and falling back to "show it all" when unsure.
const path = require('path');
const ort = require('onnxruntime-node');
const { FFMPEG, probe, spawn } = require('./media');
const { Poses } = require('./bodies');

const MODELS = path.join(__dirname, '..', '..', 'models').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const GO_ASPECT = 1440 / 2560;
const HALF_W = 480;              // analysis width of the colour picture
const FACE = 640;                // YuNet's fixed input size

// ------------------------------------------------------------------ faces (YuNet)
class Faces {
  async open() {
    for (const ep of ['dml', 'cpu']) {
      try {
        this.s = await ort.InferenceSession.create(path.join(MODELS, 'yunet_2023mar.onnx'), { executionProviders: [ep], logSeverityLevel: 3 });
        this.input = new Float32Array(3 * FACE * FACE);
        this.tensor = new ort.Tensor('float32', this.input, [1, 3, FACE, FACE]);
        await this.s.run({ input: this.tensor });
        return ep;
      } catch { this.s = null; }
    }
    return null;
  }

  // rgb: w*h*3 buffer -> [{cx, cy, w, h, score}] in that picture's pixels
  async detect(rgb, w, h, minScore = 0.6) {
    if (!this.s) return [];
    const k = FACE / Math.max(w, h), x = this.input, n = FACE * FACE;
    x.fill(0);
    const sw = Math.round(w * k), sh = Math.round(h * k);
    for (let yy = 0; yy < sh; yy++) {
      const sy = Math.min(h - 1, (yy / k) | 0);
      for (let xx = 0; xx < sw; xx++) {
        const sx = Math.min(w - 1, (xx / k) | 0), j = (sy * w + sx) * 3, o = yy * FACE + xx;
        x[o] = rgb[j + 2]; x[n + o] = rgb[j + 1]; x[2 * n + o] = rgb[j];       // BGR, 0..255
      }
    }
    const out = await this.s.run({ input: this.tensor });
    const found = [];
    for (const st of [8, 16, 32]) {
      const cols = FACE / st, cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data;
      for (let i = 0; i < cls.length; i++) {
        const c = Math.min(1, Math.max(0, cls[i])), o = Math.min(1, Math.max(0, obj[i]));
        const score = Math.sqrt(c * o);
        if (score < minScore) continue;
        const r = (i / cols) | 0, cc = i % cols;
        const cx = (cc + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
        const fw = Math.exp(bb[i * 4 + 2]) * st, fh = Math.exp(bb[i * 4 + 3]) * st;
        found.push({ cx: cx / k, cy: cy / k, w: fw / k, h: fh / k, score });
      }
    }
    // non-max suppression
    found.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const f of found) {
      if (keep.every((g) => iou(f, g) < 0.3)) keep.push(f);
      if (keep.length >= 12) break;
    }
    return keep;
  }
  async close() { try { await this.s?.release(); } catch {} }
}

function iou(a, b) {
  const x0 = Math.max(a.cx - a.w / 2, b.cx - b.w / 2), x1 = Math.min(a.cx + a.w / 2, b.cx + b.w / 2);
  const y0 = Math.max(a.cy - a.h / 2, b.cy - b.h / 2), y1 = Math.min(a.cy + a.h / 2, b.cy + b.h / 2);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i + 1e-6);
}

// ------------------------------------------------------------------ helpers
function gauss1d(v, sigma) {
  if (sigma <= 0 || v.length < 3) return v.slice();
  const r = Math.max(1, Math.round(3 * sigma)), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const s = k.reduce((a, b) => a + b, 0);
  return v.map((_, i) => { let a = 0; for (let j = -r; j <= r; j++) a += v[Math.min(v.length - 1, Math.max(0, i + j))] * k[j + r]; return a / s; });
}

function dpKeep(v, tol) {          // Douglas-Peucker on a 1-D curve -> indices to keep
  const keep = new Set([0, v.length - 1]); const stack = [[0, v.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const sl = (v[b] - v[a]) / (b - a);
    let best = tol, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(v[i] - (v[a] + sl * (i - a))); if (d > best) { best = d; bi = i; } }
    if (bi >= 0) { keep.add(bi); stack.push([a, bi], [bi, b]); }
  }
  return [...keep].sort((a, b) => a - b);
}

function signature(rgb, W, H) {
  const gw = 16, gh = 9, s = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let a = 0, n = 0;
    for (let yy = (gy * H / gh) | 0; yy < ((gy + 1) * H / gh) | 0; yy += 3) for (let xx = (gx * W / gw) | 0; xx < ((gx + 1) * W / gw) | 0; xx += 3) {
      const j = (yy * W + xx) * 3; a += rgb[j] + rgb[j + 1] + rgb[j + 2]; n += 3;
    }
    s[gy * gw + gx] = n ? a / n : 0;
  }
  return s;
}

// ------------------------------------------------------------------ analysis
/**
 * file: an RGBD video or picture (colour left, depth right) or a plain 2D one.
 * Returns { v, content:[x0,y0,x1,y1], aspect, minW, keys:[[t,cx,w,cut]], summary }.
 */
async function analyze(file, { rgbd = true, onProgress, signal } = {}) {
  const info = await probe(file);
  const colorW = rgbd ? info.width / 2 : info.width, colorH = info.height;
  const HH = Math.max(32, Math.round((HALF_W * colorH / colorW) / 2) * 2);
  const FW = rgbd ? HALF_W * 2 : HALF_W;
  const dur = info.duration || 0;
  const still = !dur || dur < 0.5;
  const rate = still ? 1 : dur > 1800 ? 1 : dur > 300 ? 2 : 4;

  const faces = new Faces();
  const faceEp = await faces.open();
  const poses = new Poses();
  const poseEp = await poses.open();

  const args = ['-hide_banner', '-v', 'error', '-i', file, '-an', '-sn',
    '-vf', `${still ? '' : `fps=${rate},`}scale=${FW}:${HH}:flags=area,format=rgb24`, ...(still ? ['-frames:v', '1'] : []), '-f', 'rawvideo', 'pipe:1'];
  const dec = spawn(FFMPEG, args, { windowsHide: true });
  const kill = () => { try { dec.kill(); } catch {} };
  signal?.addEventListener('abort', kill, { once: true });

  const frameBytes = FW * HH * 3;
  const frames = [];                       // { t, prof: Float32Array(HALF_W), cut, faces }
  const colMax = new Float32Array(HALF_W), rowMax = new Float32Array(HH);
  let prevLuma = null, prevSig = null, buf = Buffer.alloc(0), busy = false, chain = Promise.resolve(), n = 0;
  const diffs = [];
  const color = Buffer.alloc(HALF_W * HH * 3);
  const luma = new Float32Array(HALF_W * HH);

  const processFrame = async (f) => {
    // split colour / depth
    for (let y = 0; y < HH; y++) f.copy(color, y * HALF_W * 3, y * FW * 3, y * FW * 3 + HALF_W * 3);
    for (let i = 0, j = 0; i < HALF_W * HH; i++, j += 3) {
      const L = 0.299 * color[j] + 0.587 * color[j + 1] + 0.114 * color[j + 2];
      luma[i] = L;
      const x = i % HALF_W, y = (i / HALF_W) | 0;
      if (L > colMax[x]) colMax[x] = L;
      if (L > rowMax[y]) rowMax[y] = L;
    }
    const sig = signature(color, HALF_W, HH);
    // a cut is a sudden jump that stands out from the recent change level (a moving
    // camera changes a lot every frame too, and must not count as a new shot)
    let cut = !prevSig;
    if (prevSig) {
      let d = 0; for (let i = 0; i < sig.length; i++) d += Math.abs(sig[i] - prevSig[i]); d /= sig.length;
      const recent = diffs.slice(-8).sort((x, y) => x - y), med = recent.length ? recent[recent.length >> 1] : 0;
      cut = d > 34 && d > 2.5 * med + 6;
      diffs.push(d);
    }
    prevSig = sig;

    // depth nearness above the frame's median
    const depthProf = new Float32Array(HALF_W);
    if (rgbd) {
      const hist = new Uint32Array(256);
      for (let y = 0; y < HH; y += 2) for (let x = 0; x < HALF_W; x += 2) hist[f[(y * FW + HALF_W + x) * 3]]++;
      let acc = 0, med = 0; const tot = (HH / 2) * (HALF_W / 2);
      for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= tot / 2) { med = b; break; } }
      for (let y = 0; y < HH; y++) for (let x = 0; x < HALF_W; x++) {
        const d = f[(y * FW + HALF_W + x) * 3] - med;
        if (d > 0) depthProf[x] += (d / 255) ** 1.5;
      }
    }
    // how wide the close-up part of the picture is: columns that are mostly near
    // (nearer than halfway between the far and near ends of this frame's depth)
    let near = null;
    if (rgbd) {
      const hist = new Uint32Array(256);
      for (let y = 0; y < HH; y += 2) for (let x = 0; x < HALF_W; x += 2) hist[f[(y * FW + HALF_W + x) * 3]]++;
      const tot = (HH / 2) * (HALF_W / 2);
      let acc = 0, p10 = 0, p90 = 255;
      for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc < tot * 0.1) p10 = b; if (acc < tot * 0.9) p90 = b; }
      const thr = (p10 + p90) / 2;
      near = new Uint8Array(HALF_W);
      if (p90 - p10 >= 24) for (let x = 0; x < HALF_W; x++) {
        let k = 0; for (let y = 0; y < HH; y += 2) if (f[(y * FW + HALF_W + x) * 3] > thr) k++;
        near[x] = k >= (HH / 2) * 0.5 ? 1 : 0;
      }
    }
    // motion within the shot
    const motionProf = new Float32Array(HALF_W);
    if (prevLuma && !cut) for (let i = 0; i < luma.length; i++) motionProf[i % HALF_W] += Math.abs(luma[i] - prevLuma[i]);
    prevLuma = Float32Array.from(luma);
    // faces, weighted by size
    const fs = faceEp ? (await faces.detect(color, HALF_W, HH, 0.86)).filter((fc) => fc.w >= 9) : [];
    const faceProf = new Float32Array(HALF_W);
    for (const fc of fs) {
      const sg = Math.max(2, fc.w * 0.6), amp = fc.score * fc.w * fc.h;
      for (let x = 0; x < HALF_W; x++) faceProf[x] += amp * Math.exp(-0.5 * ((x - fc.cx) / sg) ** 2);
    }
    const norm = (p) => { let s = 0; for (const v of p) s += v; if (s <= 1e-9) return null; return p.map((v) => v / s); };
    const parts = [[norm(faceProf), 0.45], [norm(depthProf), 0.35], [norm(motionProf), 0.20]].filter((p) => p[0]);
    const wsum = parts.reduce((a, p) => a + p[1], 0) || 1;
    const prof = new Float32Array(HALF_W);
    for (const [p, w] of parts) for (let x = 0; x < HALF_W; x++) prof[x] += p[x] * w / wsum;
    for (let x = 0; x < HALF_W; x++) prof[x] = (prof[x] || 1 / HALF_W) * (0.85 + 0.15 * Math.exp(-0.5 * ((x / HALF_W - 0.5) / 0.35) ** 2));
    let mSum = 0; for (const v of motionProf) mSum += v;
    const turn = poseEp ? await bestTurn(poses, color, HALF_W, HH) : null;
    const faceW = fs.reduce((a, fc) => Math.max(a, fc.w), 0);
    frames.push({ t: still ? 0 : n / rate, prof, cut, faces: fs.length, faceW, near, turn, motion: mSum / (HALF_W * HH), motionProf: norm(motionProf), depthProf: norm(depthProf) });
    n++;
    if (!still && dur) onProgress?.({ stage: 'framing', done: Math.min(dur, n / rate), total: dur });
  };

  await new Promise((resolve, reject) => {
    dec.stdout.on('data', (b) => {
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      if (busy || buf.length < frameBytes) return;
      busy = true; dec.stdout.pause();
      chain = chain.then(async () => {
        while (buf.length >= frameBytes && !signal?.aborted) {
          const f = buf.subarray(0, frameBytes); buf = buf.subarray(frameBytes);
          await processFrame(f);
        }
        busy = false; dec.stdout.resume();
      }).catch(reject);
    });
    dec.on('error', reject);
    dec.on('close', () => chain.then(resolve, reject));
  });
  await faces.close();
  await poses.close();
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
  if (!frames.length) throw new Error('could not read the video for framing');

  // ---- black bars burned into the picture
  const dark = 26;
  let x0 = 0, x1 = HALF_W - 1, y0 = 0, y1 = HH - 1;
  while (x0 < HALF_W / 3 && colMax[x0] < dark) x0++;
  while (x1 > HALF_W * 2 / 3 && colMax[x1] < dark) x1--;
  while (y0 < HH / 3 && rowMax[y0] < dark) y0++;
  while (y1 > HH * 2 / 3 && rowMax[y1] < dark) y1--;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const content = [x0 / HALF_W, y0 / HH, (x1 + 1) / HALF_W, (y1 + 1) / HH];
  const contentAspect = (cw * colorW / HALF_W) / (ch * colorH / HH);
  const minW = Math.min(1, GO_ASPECT / contentAspect);       // portrait slice as a share of the content width

  // ---- per shot
  const shots = [];
  for (let i = 0; i < frames.length; i++) if (i === 0 || frames[i].cut) shots.push([i, i]); else shots[shots.length - 1][1] = i;
  const keys = [], summary = { follow: 0, half: 0, fit: 0 };
  const sigma = Math.max(1, 1.2 * rate);       // ~1.2 s of smoothing

  const bestCentre = (prof, w) => {           // window of width w (share of content) with the most interest
    const ww = Math.max(1, Math.round(w * cw));
    let s = 0; for (let x = x0; x < x0 + ww; x++) s += prof[x];
    let best = s, bx = x0, tot = 0;
    for (let x = x0; x <= x1; x++) tot += prof[x];
    for (let x = x0 + 1; x + ww - 1 <= x1; x++) { s += prof[x + ww - 1] - prof[x - 1]; if (s > best) { best = s; bx = x; } }
    return { c: (bx - x0 + ww / 2) / cw, cover: tot > 0 ? best / tot : 0 };
  };
  const coverAt = (prof, c, w) => {
    const ww = Math.max(1, Math.round(w * cw)); const a = Math.round(x0 + c * cw - ww / 2);
    let s = 0, tot = 0;
    for (let x = x0; x <= x1; x++) { tot += prof[x]; if (x >= a && x < a + ww) s += prof[x]; }
    return tot > 0 ? s / tot : 0;
  };
  const clampC = (c, w) => Math.min(1 - w / 2, Math.max(w / 2, c));

  for (const [a, b] of shots) {
    const fr = frames.slice(a, b + 1);
    const N = fr.length;
    if (minW >= 0.92) {                                    // already tall: just trim bars
      summary.fit += N;
      keys.push([+fr[0].t.toFixed(2), 0.5, 1, 1]);
      continue;
    }
    // Is there a subject in each frame? A face, real local motion, or one clear close-up object.
    const subj = fr.map((f) => {
      if (f.faces > 0) return true;
      if (f.motion > 2.0 && f.motionProf && bestCentre(f.motionProf, minW).cover > 0.55) return true;
      return !!(f.depthProf && bestCentre(f.depthProf, minW).cover > 0.78);
    });
    // close short gaps (< 3 s) and drop blips (< 1 s), so the crop doesn't pump
    const gap = Math.round(3 * rate), blip = Math.max(1, Math.round(1 * rate));
    for (let i = 0; i < N;) {
      let j = i; while (j < N && subj[j] === subj[i]) j++;
      const len = j - i;
      if (!subj[i] && i > 0 && j < N && len < gap) for (let k = i; k < j; k++) subj[k] = true;
      else if (subj[i] && len < blip && N > blip * 2) for (let k = i; k < j; k++) subj[k] = false;
      i = j;
    }
    // Filling the tall screen beats showing the wide view: always crop to the portrait slice; only widen a little when the subject (say two
    // people far apart) clearly doesn't fit. Never fall back to the whole picture.
    const idxS = subj.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    let wSub = minW;
    if (idxS.length) {
      const cover = (w) => idxS.reduce((acc, i) => acc + bestCentre(fr[i].prof, w).cover, 0) / idxS.length;
      const wWide = Math.min(1, minW * 1.35);
      if (cover(minW) < 0.40 && cover(wWide) >= 0.40) wSub = wWide;
    }
    // follow the subject when there is one; otherwise drift slowly to whatever is most
    // interesting (close-up things, a little motion), staying cropped
    const rawC = fr.map((f, i) => bestCentre(f.prof, wSub).c);
    const subjC = gauss1d(rawC, sigma), driftC = gauss1d(rawC, Math.max(1, 3 * rate));
    const mix = gauss1d(subj.map((v) => (v ? 1 : 0)), Math.max(1, 1.5 * rate));
    const ws = fr.map(() => wSub);
    const cs = fr.map((_, i) => clampC(subjC[i] * mix[i] + driftC[i] * (1 - mix[i]), wSub));
    const tight = ws.filter((w) => w < 0.75).length, wide = ws.filter((w) => w > 0.97).length;
    summary.follow += tight; summary.fit += wide; summary.half += N - tight - wide;
    const keepC = dpKeep(cs, 0.008), keepW = dpKeep(ws, 0.01);
    const idx = [...new Set([...keepC, ...keepW])].sort((x, y) => x - y);
    idx.forEach((k, j) => keys.push([+fr[k].t.toFixed(2), +cs[k].toFixed(4), +ws[k].toFixed(4), j === 0 ? 1 : 0]));
  }

  const rot = rotationTrack(frames, rate, contentAspect);
  const close = closeUpTrack(frames, rate, minW, cw, x0, x1, rot);
  if (process.env.HL_DEBUG_BIG) require('fs').writeFileSync(process.env.HL_DEBUG_BIG, JSON.stringify({ minW, cw, x0, x1, HH, frames: frames.map((f) => {
    let nf = 0, a = -1, b = -1; if (f.near) for (let x = x0; x <= x1; x++) if (f.near[x]) { nf++; if (a < 0) a = x; b = x; }
    const bx = f.turn?.raw?.box;
    return { t: f.t, cut: f.cut ? 1 : 0, faceW: +(f.faceW / cw).toFixed(3), nearFill: +(nf / cw).toFixed(3), nearSpan: a < 0 ? 0 : +((b - a + 1) / cw).toFixed(3),
      box: bx ? [(bx[0] - x0) / cw, bx[1] / HH, (bx[2] - x0) / cw, bx[3] / HH].map((v) => +v.toFixed(3)) : null, bodyConf: f.turn?.raw ? +f.turn.raw.conf.toFixed(2) : 0, bodyAngle: f.turn?.raw ? Math.round(f.turn.raw.angle) : null };
  }) }));
  const total = summary.follow + summary.half + summary.fit;
  const decided = minW >= 0.92 ? 'portrait' : summary.fit / total > 0.85 ? 'fit' : summary.follow / total > 0.6 ? 'follow' : 'mixed';
  return { v: 6, width: info.width, height: info.height, content: content.map((v) => +v.toFixed(4)), aspect: +contentAspect.toFixed(4), minW: +minW.toFixed(4), keys,
    rot: rot.keys, rotBig: close.keys, closeUps: close.share, usual: rot.usual, rotMinW: +Math.min(1, GO_ASPECT * contentAspect).toFixed(4),
    summary: { ...summary, decided, faces: faceEp ? frames.reduce((a, f) => a + (f.faces ? 1 : 0), 0) : null, frames: frames.length, rate } };
}

// ------------------------------------------------------------------ rotation
// Turn the frame (as is, a quarter turn clockwise, a quarter turn anticlockwise)
// and see in which one the person looks most upright. Pose models are best at
// upright people, so the right turn wins clearly even for someone lying down.
function turnRgb(src, w, h, cw) {
  const out = Buffer.alloc(w * h * 3);           // result is h wide, w tall
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const o = cw ? (x * h + (h - 1 - y)) * 3 : ((w - 1 - x) * h + y) * 3;
    out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2];
  }
  return out;
}

async function bestTurn(poses, rgb, w, h) {
  const tries = [[0, rgb, w, h], [90, turnRgb(rgb, w, h, true), h, w], [-90, turnRgb(rgb, w, h, false), h, w]];
  const res = {};
  for (const [r, buf, bw, bh] of tries) {
    const ds = await poses.detect(buf, bw, bh, 0.3);
    let best = null, q = 0;
    for (const d of ds) {
      // the head (nose, eyes, ears) must sit ABOVE the shoulders, or the model was fooled
      // by an upside-down body (mixed-up shoulders and hips look "upright" too)
      const head = d.kp.slice(0, 5).filter((k) => k[2] > 0.25);
      const shY = (d.kp[5][1] + d.kp[6][1]) / 2;
      if (head.length >= 2 && head.reduce((a, k) => a + k[1], 0) / head.length > shY - 0.02 * bh) continue;
      const up = Math.cos((d.angle + 90) * Math.PI / 180);           // 1 = hips straight below shoulders
      const qq = d.score * Math.sqrt(Math.max(0, d.conf)) * Math.max(0, up) ** 2 * Math.min(1, d.size / (0.06 * bh));
      if (qq > q) { q = qq; best = d; }
    }
    // subject centre back in the ORIGINAL frame (0..1, y down)
    let cx = 0.5, cy = 0.5;
    if (best) {
      const bx = (best.box[0] + best.box[2]) / 2, by = (best.box[1] + best.box[3]) / 2;
      if (r === 0) { cx = bx / bw; cy = by / bh; }
      else if (r === 90) { cx = by / bh; cy = 1 - bx / bw; }      // undo the clockwise turn
      else { cx = 1 - by / bh; cy = bx / bw; }                     // undo the anticlockwise turn
    }
    res[r] = { q, cx, cy, angle: best ? best.angle : null, conf: best ? best.conf : 0 };
  }
  // as-is: the most confident body, whatever its direction (to tell sideways from leaning)
  const asIs = await poses.detect(rgb, w, h, 0.3);
  const top = asIs.sort((a, b) => b.score * b.conf - a.score * a.conf)[0];
  res.raw = top ? { angle: top.angle, conf: top.conf, score: top.score, box: top.box } : null;
  return res;
}

// Per shot: which way to turn the picture so people stay upright, with patience
// (a turn must win for ~1.5 s before we follow it) so it never flips back and forth.
// Turning is eager and sticky: streams (VTubers, VR) often spend long stretches
// sideways. So: turn after ~1 s of a sideways body, stay
// turned through unclear frames, and only turn back after ~4 s clearly upright.
function rotationTrack(frames, rate, contentAspect) {
  const keys = [];
  let usual = null, lastSt = [], lastSm = [];
  const holdOn = Math.max(2, Math.round(1 * rate));        // sideways this long -> turn
  const holdOff = Math.max(3, Math.round(4 * rate));       // upright this long -> turn back
  const minTurn = Math.max(2, Math.round(2 * rate));       // ignore turned blips shorter than ~2 s
  const win = Math.max(1, Math.round(0.5 * rate));         // small vote window

  // per frame: 0 (upright), 90, -90 or null (no clear person)
  const vote = (f) => {
    if (!f.turn) return null;
    let best = 0, bq = 0;
    for (const r of [0, 90, -90]) if (f.turn[r].q > bq) { bq = f.turn[r].q; best = r; }
    if (bq < 0.22) return null;
    if (best === 0) return 0;
    if (bq < 1.15 * f.turn[0].q) return null;                          // close call: keep whatever we're doing
    const raw = f.turn.raw;
    if (raw && raw.conf >= 0.4) {
      const want = Math.abs(raw.angle) < 90 ? -90 : 90;                 // head right -> turn anticlockwise
      if (want !== best && Math.abs(Math.abs(raw.angle) - 90) > 20) return null;   // disagrees on direction: unsure
    }
    return best;
  };

  {
    const fr = frames, N = fr.length;
    let raw = fr.map(vote);
    // the video's usual turn: if people are mostly sideways one way, unclear moments
    // and close-ups follow it, and the opposite turn needs a strong case
    const cnt = { 0: 0, 90: 0, '-90': 0 };
    for (const v of raw) if (v != null) cnt[v]++;
    const tot = cnt[0] + cnt[90] + cnt['-90'];
    const D = cnt[90] >= cnt['-90'] ? 90 : -90;
    const mostlyTurned = tot > 0 && cnt[D] >= 0.3 * tot && cnt[D] >= 2 * cnt[-D];
    usual = tot ? { turn: mostlyTurned ? D : 0, share: +(Math.max(cnt[90], cnt['-90']) / tot).toFixed(2) } : null;
    if (mostlyTurned) {
      raw = raw.map((v, i) => {
        if (v === -D) return fr[i].turn[-D].q >= 0.5 && fr[i].turn[-D].q >= 2 * fr[i].turn[D].q ? v : D;
        if (v == null) return D;                           // unclear: lean towards the usual turn
        return v;
      });
    }
    if (process.env.HL_DEBUG_ROT) fr.forEach((f, i) => console.log(f.t.toFixed(2), f.cut ? 'CUT' : '   ', 'vote', raw[i], f.turn ? [0, 90, -90].map((r) => r + ':' + f.turn[r].q.toFixed(2)).join(' ') + ' raw:' + (f.turn.raw ? f.turn.raw.angle.toFixed(0) + '/' + f.turn.raw.conf.toFixed(2) : '-') : ''));
    const pick = raw.map((_, i) => {
      const c = {}; let bestV = null, bestN = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(N - 1, i + win); j++) { const v = raw[j]; if (v == null) continue; c[v] = (c[v] || 0) + 1; if (c[v] > bestN) { bestN = c[v]; bestV = v; } }
      return bestV;
    });
    const st = new Array(N).fill(0);
    // a shot that opens sideways starts turned
    const first = pick.slice(0, holdOn * 2).filter((p) => p != null);
    let state = 0;
    for (const r of [90, -90]) if (first.filter((p) => p === r).length >= Math.max(1, first.length * 0.6)) state = r;
    let cand = state, run = 0, nobody = 0;
    const lonely = Math.round(20 * rate);           // nobody visible this long -> upright
    for (let i = 0; i < N; i++) {
      const p = pick[i];
      if (i > 0 && fr[i].cut) {                            // new shot: switch at once if it clearly differs
        const look = pick.slice(i, i + holdOn * 2), next = look.filter((x) => x != null);
        if (!next.length && look.length >= holdOn) { state = 0; cand = 0; run = 0; }      // nobody in the new shot: upright
        for (const r of [0, 90, -90]) if (r !== state && next.length >= holdOn && next.filter((x) => x === r).length >= next.length * 0.7) { state = r; cand = r; run = 0; }
      }
      // nobody visible for ~20 s: go back upright from where they vanished
      if (raw[i] == null) { nobody++; if (nobody === lonely && state !== 0) { for (let j = i - nobody + 1; j <= i; j++) st[j] = 0; state = 0; cand = 0; run = 0; } }
      else nobody = 0;
      if (p != null && p !== state) {
        if (p === cand) run++; else { cand = p; run = 1; }
        const need = p === 0 ? holdOff : holdOn;
        if (run >= need) { for (let j = i - run + 1; j <= i; j++) st[j] = p; state = p; run = 0; }
      } else if (p === state) { run = 0; cand = state; }
      st[i] = state;                                       // unclear frames (null) keep the current turn
    }
    for (let i = 0; i < N;) {
      let j = i; while (j < N && st[j] === st[i]) j++;
      if (st[i] !== 0 && j - i < minTurn) for (let k = i; k < j; k++) st[k] = i > 0 ? st[i - 1] : 0;
      i = j;
    }
    // stay turned through short upright moments (< ~8 s) between sideways stretches
    const gap = Math.round(8 * rate);
    for (let i = 0; i < N;) {
      let j = i; while (j < N && st[j] === st[i]) j++;
      if (st[i] === 0 && i > 0 && j < N && st[i - 1] !== 0 && st[j] === st[i - 1] && j - i < gap) for (let k = i; k < j; k++) st[k] = st[i - 1];
      i = j;
    }
    lastSt = st;
    const vx = fr.map((f, i) => { const r = st[i]; if (!f.turn || r === 0) return 0.5; const t = f.turn[r]; return r === 90 ? 1 - t.cy : t.cy; });
    const sm = vx.map((_, i) => { let s = 0, n = 0; for (let j = Math.max(0, i - holdOn); j <= Math.min(N - 1, i + holdOn); j++) { s += vx[j]; n++; } return s / n; });
    lastSm = sm;
    for (let i = 0; i < N; i++) {
      if (i === 0 || st[i] !== st[i - 1] || (st[i] !== 0 && i % Math.max(1, rate) === 0)) {
        keys.push([+fr[i].t.toFixed(2), st[i], +sm[i].toFixed(4), i === 0 || fr[i].cut ? 1 : 0]);
      }
    }
  }
  return { keys, usual, st: lastSt, sm: lastSm };
}

// Close-ups: when the subject is far wider than the portrait slice (a face,
// chest or hips filling the screen), show the whole picture turned a quarter turn instead.
// A frame counts as a close-up when the near part of the picture covers more than ~1.25
// portrait slices across, or a face alone is most of a slice wide; a whole body that is
// clearly seen and fits the slice never does. Sideways people keep the normal turn.
function closeUpTrack(frames, rate, minW, cw, x0, x1, rot) {
  if (minW >= 0.92) return { keys: rot.keys, share: 0 };      // already tall: nothing to turn for
  const N = frames.length;
  const big = frames.map((f) => {
    let nf = 0; if (f.near) for (let x = x0; x <= x1; x++) nf += f.near[x];
    const raw = f.turn && f.turn.raw;
    if (raw && raw.conf >= 0.75 && raw.box && (raw.box[2] - raw.box[0]) / cw < 1.5 * minW) return false;
    return nf / cw >= 1.25 * minW || f.faceW / cw >= 0.6 * minW;
  });
  // majority over ~2 s either side, so single frames don't count
  const w = Math.max(1, Math.round(2 * rate));
  const vote = big.map((_, i) => { let k = 0, n = 0; for (let j = Math.max(0, i - w); j <= Math.min(N - 1, i + w); j++) { k += big[j] ? 1 : 0; n++; } return k * 2 > n; });
  const holdOn = Math.max(2, Math.round(2 * rate)), holdOff = Math.max(3, Math.round(5 * rate));
  const on = new Array(N).fill(false);
  let state = vote[0], run = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && frames[i].cut) {                          // new shot: take its look at once
      const look = vote.slice(i, i + holdOn * 2);
      if (look.length) state = look.filter(Boolean).length * 2 > look.length;
      run = 0;
    } else if (vote[i] !== state) {
      run++;
      if (run >= (state ? holdOff : holdOn)) { for (let j = i - run + 1; j <= i; j++) on[j] = vote[i]; state = vote[i]; run = 0; }
    } else run = 0;
    on[i] = state;
  }
  // stay turned through short gaps (< ~10 s), drop turns shorter than ~3 s
  const gap = Math.round(10 * rate), minRun = Math.max(2, Math.round(3 * rate));
  for (let i = 0; i < N;) { let j = i; while (j < N && on[j] === on[i]) j++; if (!on[i] && i > 0 && j < N && j - i < gap && !frames.slice(i, j + 1).some((f) => f.cut)) for (let k = i; k < j; k++) on[k] = true; i = j; }
  for (let i = 0; i < N;) { let j = i; while (j < N && on[j] === on[i]) j++; if (on[i] && j - i < minRun) for (let k = i; k < j; k++) on[k] = false; i = j; }

  // close-ups all turn the same way through the video (flipping between the two looks
  // jumpy): its usual turn, else the way sideways people mostly turn it, else clockwise
  const st = rot.st, sm = rot.sm;
  const cw90 = st.filter((r) => r === 90).length, ccw90 = st.filter((r) => r === -90).length;
  const dir = (rot.usual && rot.usual.turn) || (ccw90 > cw90 ? -90 : 90);
  const out = st.map((r, i) => (r === 0 && on[i] ? dir : r));
  const cen = sm.map((c, i) => (st[i] === 0 && on[i] ? 0.5 : c));
  const keys = [];
  for (let i = 0; i < N; i++) {
    if (i === 0 || out[i] !== out[i - 1] || (out[i] !== 0 && i % Math.max(1, rate) === 0)) keys.push([+frames[i].t.toFixed(2), out[i], +cen[i].toFixed(4), i === 0 || frames[i].cut ? 1 : 0]);
  }
  return { keys, share: +(on.filter(Boolean).length / Math.max(1, N)).toFixed(2) };
}

module.exports = { analyze, Faces };
