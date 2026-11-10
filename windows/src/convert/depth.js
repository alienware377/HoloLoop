'use strict';
// Depth Anything V2 style models (see models.js) on onnxruntime-node. DirectML
// (any GPU, incl. Intel iGPUs on mini PCs) first, CPU as the fallback. Turns RGB
// frames into 8-bit depth (255 = near) with flicker control across frames.
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const { loadTable, resizePosEmbed } = require('./posembed');
const { DEPTH_MODELS } = require('./models');

const MODELS = path.join(__dirname, '..', '..', 'models').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

class DepthEngine {
  constructor() { this.session = null; this.ep = null; this.W = 0; this.H = 0; this.state = null; }

  // W, H must be multiples of 14. batch: frames per model call on the GPU (4 runs about twice
  // as many frames a second as 1 on DirectML; the CPU fallback always uses 1).
  // model: a key of DEPTH_MODELS. The extra models ship as fp16 only, so they need a GPU.
  async open(W, H, prefer = 'auto', batch = 1, model = 'standard') {
    this.W = W; this.H = H;
    const m = DEPTH_MODELS[model] || DEPTH_MODELS.standard;
    const pe = resizePosEmbed(loadTable(path.join(MODELS, `${m.file}_posembed_1x${m.dim}x37x37.f32`)), m.dim, 37, 37, H / 14, W / 14);
    this.peTensor = new ort.Tensor('float32', pe, [1, m.dim, H / 14, W / 14]);
    const dims = (B) => ({ batch_size: B, height: H, width: W, ph: H / 14, pw: W / 14 });
    const f16 = `${m.file}_fp16_pe.onnx`, f32 = `${m.file}_fp32_pe.onnx`;
    const tries = (prefer === 'cpu' ? [['cpu', f32]] : [['dml', f16], ['dml', f32], ['cpu', f32]])
      .filter(([, file]) => fs.existsSync(path.join(MODELS, file)));
    if (!tries.length) throw new Error(`the ${m.label} depth model needs a graphics card; pick Standard for this video`);
    let lastErr;
    for (const [ep, file] of tries) {
      try {
        const B = ep === 'cpu' ? 1 : Math.max(1, batch | 0);
        const so = { executionProviders: [ep], graphOptimizationLevel: 'all', freeDimensionOverrides: dims(B), logSeverityLevel: 3 };
        if (ep === 'cpu') so.intraOpNumThreads = Math.max(1, Math.min(8, require('os').cpus().length - 1));
        this.session = await ort.InferenceSession.create(path.join(MODELS, file), so);
        this.ep = ep + ':' + file;
        this.batch = B;
        this.input = new Float32Array(B * 3 * W * H);
        this.inputTensor = new ort.Tensor('float32', this.input, [B, 3, H, W]);
        await this.session.run({ pixel_values: this.inputTensor, pos_embed_resized: this.peTensor });  // warm-up
        this.resetTemporal();
        return this.ep;
      } catch (e) { lastErr = e; this.session = null; this.errors = (this.errors || []).concat(ep + ':' + file + ': ' + e.message); }
    }
    throw lastErr || new Error('no depth backend');
  }

  resetTemporal() { this.state = { lo: null, hi: null, prev: null, prevSig: null }; }

  // rgb: Buffer W*H*3 (rgb24). Returns Uint8Array W*H depth, 255 = nearest.
  async infer(rgb, opts = {}) { return (await this.inferMany([rgb], opts))[0]; }

  // Up to `batch` frames in one model call; returned in order (flicker control runs frame by frame).
  async inferMany(frames, opts = {}) {
    const { W, H } = this, n = W * H, B = this.batch, out = [];
    for (let s = 0; s < frames.length; s += B) {
      const group = frames.slice(s, s + B);
      for (let k = 0; k < B; k++) {
        const rgb = group[Math.min(k, group.length - 1)], x = this.input.subarray(k * 3 * n, (k + 1) * 3 * n);   // short group: repeat the last frame
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          x[i] = (rgb[j] / 255 - MEAN[0]) / STD[0];
          x[n + i] = (rgb[j + 1] / 255 - MEAN[1]) / STD[1];
          x[2 * n + i] = (rgb[j + 2] / 255 - MEAN[2]) / STD[2];
        }
      }
      const d = (await this.session.run({ pixel_values: this.inputTensor, pos_embed_resized: this.peTensor })).predicted_depth.data;
      for (let k = 0; k < group.length; k++) out.push(this.normalize(d.subarray(k * n, (k + 1) * n), group[k], opts));
    }
    return out;
  }

  // Robust range (2nd..98th percentile) smoothed over time, reset on scene cuts.
  normalize(d, rgb, { smooth = 0.35 } = {}) {
    const n = d.length, st = this.state;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const bins = 512, hist = new Uint32Array(bins), span = (mx - mn) || 1;
    for (let i = 0; i < n; i++) hist[Math.min(bins - 1, ((d[i] - mn) / span * bins) | 0)]++;
    const pct = (p) => { let acc = 0, target = p * n; for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= target) return mn + (b / bins) * span; } return mx; };
    let lo = pct(0.02), hi = pct(0.98);

    // scene cut: tiny signature of the picture (16x9 grey grid)
    const sig = signature(rgb, this.W, this.H);
    let cut = !st.prevSig;
    if (st.prevSig) { let diff = 0; for (let i = 0; i < sig.length; i++) diff += Math.abs(sig[i] - st.prevSig[i]); cut = diff / sig.length > 28; }
    st.prevSig = sig;

    if (cut || st.lo == null) { st.lo = lo; st.hi = hi; }
    else { const a = 0.08; st.lo += (lo - st.lo) * a; st.hi += (hi - st.hi) * a; }
    const L = st.lo, R = Math.max(st.hi - st.lo, 1e-6);

    const outU8 = new Uint8Array(n);
    const prev = (!cut && st.prev) ? st.prev : null;
    for (let i = 0; i < n; i++) {
      let v = (d[i] - L) / R;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      let q = v * 255;
      if (prev) {                         // calm the flicker, but let real motion through
        const p = prev[i], dv = q - p;
        if (dv > -26 && dv < 26) q = p + dv * (1 - smooth);
      }
      outU8[i] = q + 0.5;
    }
    st.prev = outU8;
    return { depth: outU8, cut };
  }

  async close() { try { await this.session?.release(); } catch {} this.session = null; }
}

function signature(rgb, W, H) {
  const gw = 16, gh = 9, s = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x = Math.min(W - 1, ((gx + 0.5) * W / gw) | 0), y = Math.min(H - 1, ((gy + 0.5) * H / gh) | 0);
    const j = (y * W + x) * 3;
    s[gy * gw + gx] = (rgb[j] + rgb[j + 1] + rgb[j + 2]) / 3;
  }
  return s;
}

// Model input size for a picture: long side ~= target, both multiples of 14.
function modelSize(w, h, target = 518) {
  const k = target / Math.max(w, h);
  const r14 = (v) => Math.max(14, Math.round(v / 14) * 14);
  return { W: r14(w * k), H: r14(h * k) };
}

module.exports = { DepthEngine, modelSize };
