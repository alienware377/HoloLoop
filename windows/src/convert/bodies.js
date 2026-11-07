'use strict';
// MediaPipe person detector (OpenCV zoo ONNX, Apache-2.0). Besides a box it gives
// four body points: hip centre, a full-body point, shoulder centre and an
// upper-body point. Hip -> shoulder is the way the body points, even when the
// person is lying down or the camera is turned, which is what rotation needs.
const path = require('path');
const fs = require('fs');
const ort = require('onnxruntime-node');

const MODELS = path.join(__dirname, '..', '..', 'models').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const IN = 224;

class Bodies {
  async open() {
    this.anchors = JSON.parse(fs.readFileSync(path.join(MODELS, 'person_det_mp_anchors.json'), 'utf8'));
    for (const ep of ['dml', 'cpu']) {
      try {
        this.s = await ort.InferenceSession.create(path.join(MODELS, 'person_det_mp_2023mar.onnx'), { executionProviders: [ep], logSeverityLevel: 3 });
        this.input = new Float32Array(3 * IN * IN);
        this.tensor = new ort.Tensor('float32', this.input, [1, 3, IN, IN]);
        await this.s.run({ 'input_1:0': this.tensor });
        return ep;
      } catch { this.s = null; }
    }
    return null;
  }

  /**
   * rgb: w*h*3 buffer -> [{ score, hip:[x,y], shoulder:[x,y], full:[x,y], angle, size }]
   * angle: direction hip -> shoulder in degrees, image coords (0 = right, -90 = up).
   */
  async detect(rgb, w, h, minScore = 0.55) {
    if (!this.s) return [];
    const ratio = Math.min(IN / w, IN / h);
    const rw = Math.round(w * ratio), rh = Math.round(h * ratio);
    const padL = ((IN - rw) / 2) | 0, padT = ((IN - rh) / 2) | 0;
    const x = this.input, n = IN * IN;
    x.fill(0);
    for (let yy = 0; yy < rh; yy++) {
      const sy = Math.min(h - 1, (yy / ratio) | 0);
      for (let xx = 0; xx < rw; xx++) {
        const sx = Math.min(w - 1, (xx / ratio) | 0), j = (sy * w + sx) * 3, o = (yy + padT) * IN + (xx + padL);
        x[o] = rgb[j] / 127.5 - 1; x[n + o] = rgb[j + 1] / 127.5 - 1; x[2 * n + o] = rgb[j + 2] / 127.5 - 1;
      }
    }
    const out = await this.s.run({ 'input_1:0': this.tensor });
    const sc = out['Identity_1:0'].data, rg = out['Identity:0'].data;
    const scale = Math.max(w, h);
    const padX = padL / ratio, padY = padT / ratio;
    const cand = [];
    for (let i = 0; i < this.anchors.length; i++) {
      const s = 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, sc[i]))));
      if (s < minScore) continue;
      const [ax, ay] = this.anchors[i], b = i * 12;
      const pt = (k) => [((rg[b + 4 + k * 2] / IN) + ax) * scale - padX, ((rg[b + 5 + k * 2] / IN) + ay) * scale - padY];
      const cx = (rg[b] / IN + ax) * scale - padX, cy = (rg[b + 1] / IN + ay) * scale - padY;
      const bw = (rg[b + 2] / IN) * scale, bh = (rg[b + 3] / IN) * scale;
      const hip = pt(0), full = pt(1), shoulder = pt(2);
      const angle = Math.atan2(shoulder[1] - hip[1], shoulder[0] - hip[0]) * 180 / Math.PI;
      const size = Math.hypot(full[0] - hip[0], full[1] - hip[1]);      // body radius
      cand.push({ score: s, box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], hip, full, shoulder, angle, size });
    }
    // NMS on the body circles (boxes are only face-sized)
    cand.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const c of cand) {
      if (keep.every((k) => Math.hypot(k.hip[0] - c.hip[0], k.hip[1] - c.hip[1]) > 0.5 * Math.max(k.size, c.size))) keep.push(c);
      if (keep.length >= 6) break;
    }
    return keep;
  }

  async close() { try { await this.s?.release(); } catch {} }
}

// RTMO-s (OpenMMLab, Apache-2.0): one-stage full-body pose, 17 COCO points, finds
// people from behind too (the MediaPipe detector above needs a face).
const RTMO = 640;
class Poses {
  async open() {
    for (const ep of ['dml', 'cpu']) {
      try {
        this.s = await ort.InferenceSession.create(path.join(MODELS, 'rtmo_s_body7_640.onnx'), { executionProviders: [ep], logSeverityLevel: 3 });
        this.input = new Float32Array(3 * RTMO * RTMO);
        this.tensor = new ort.Tensor('float32', this.input, [1, 3, RTMO, RTMO]);
        await this.s.run({ input: this.tensor });
        return ep;
      } catch { this.s = null; }
    }
    return null;
  }

  // -> [{ score, box, kp: [[x,y,s] x17], angle, size, conf }] ; angle = hips -> shoulders, image degrees (-90 = up)
  async detect(rgb, w, h, minScore = 0.35) {
    if (!this.s) return [];
    const r = Math.min(RTMO / w, RTMO / h), rw = Math.round(w * r), rh = Math.round(h * r);
    const x = this.input, n = RTMO * RTMO;
    x.fill(114);
    for (let yy = 0; yy < rh; yy++) {
      const sy = Math.min(h - 1, (yy / r) | 0);
      for (let xx = 0; xx < rw; xx++) {
        const sx = Math.min(w - 1, (xx / r) | 0), j = (sy * w + sx) * 3, o = yy * RTMO + xx;
        x[o] = rgb[j + 2]; x[n + o] = rgb[j + 1]; x[2 * n + o] = rgb[j];          // BGR, 0..255
      }
    }
    const out = await this.s.run({ input: this.tensor });
    const D = out.dets, K = out.keypoints, N = D.dims[1], nk = K.dims[2];
    const res = [];
    for (let i = 0; i < N; i++) {
      const sc = D.data[i * 5 + 4];
      if (sc < minScore) continue;
      const kp = [];
      for (let k = 0; k < nk; k++) { const b = (i * nk + k) * 3; kp.push([K.data[b] / r, K.data[b + 1] / r, K.data[b + 2]]); }
      const mid = (a, b) => [(kp[a][0] + kp[b][0]) / 2, (kp[a][1] + kp[b][1]) / 2];
      const sh = mid(5, 6), hp = mid(11, 12);
      const conf = Math.min(kp[5][2], kp[6][2], kp[11][2], kp[12][2]);
      const angle = Math.atan2(sh[1] - hp[1], sh[0] - hp[0]) * 180 / Math.PI;
      const box = [D.data[i * 5] / r, D.data[i * 5 + 1] / r, D.data[i * 5 + 2] / r, D.data[i * 5 + 3] / r];
      res.push({ score: sc, box, kp, angle, conf, size: Math.hypot(sh[0] - hp[0], sh[1] - hp[1]) });
    }
    return res.sort((a, b) => b.score - a.score);
  }

  async close() { try { await this.s?.release(); } catch {} }
}

module.exports = { Bodies, Poses };
