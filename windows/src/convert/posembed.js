'use strict';
// Depth Anything's position table is a fixed 37x37 grid that the model stretches
// to the input size with a bicubic Resize. DirectML can't run cubic Resize, so ORT
// ran it on the CPU every frame (66 of 85 ms). We cut that node out of the model
// (tools/strip_posembed.py) and do the same maths here once per input size.
// Matches ONNX Resize: mode=cubic, cubic_coeff_a=-0.75, half_pixel, clamp at edges.

const fs = require('fs');

function cubicWeights(t, a = -0.75) {
  const w = (x) => {
    x = Math.abs(x);
    if (x <= 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return ((a * x - 5 * a) * x + 8 * a) * x - 4 * a;
    return 0;
  };
  return [w(t + 1), w(t), w(1 - t), w(2 - t)];
}

// For each output index: the 4 clamped source indices and their weights.
function axisTaps(inN, outN) {
  const scale = outN / inN;
  const idx = new Int32Array(outN * 4), wt = new Float32Array(outN * 4);
  for (let o = 0; o < outN; o++) {
    const x = (o + 0.5) / scale - 0.5;
    const x0 = Math.floor(x), t = x - x0;
    const ws = cubicWeights(t);
    for (let k = 0; k < 4; k++) {
      idx[o * 4 + k] = Math.min(inN - 1, Math.max(0, x0 - 1 + k));
      wt[o * 4 + k] = ws[k];
    }
  }
  return { idx, wt };
}

function loadTable(file) {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

// table: Float32Array [C, 37, 37]; returns Float32Array [C, outH, outW]
function resizePosEmbed(table, C, inH, inW, outH, outW) {
  const ty = axisTaps(inH, outH), tx = axisTaps(inW, outW);
  const tmp = new Float32Array(C * inH * outW);           // horizontal pass
  for (let c = 0; c < C; c++) for (let y = 0; y < inH; y++) {
    const src = (c * inH + y) * inW, dst = (c * inH + y) * outW;
    for (let o = 0; o < outW; o++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += table[src + tx.idx[o * 4 + k]] * tx.wt[o * 4 + k];
      tmp[dst + o] = s;
    }
  }
  const out = new Float32Array(C * outH * outW);           // vertical pass
  for (let c = 0; c < C; c++) for (let o = 0; o < outH; o++) {
    const dst = (c * outH + o) * outW;
    for (let x = 0; x < outW; x++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += tmp[(c * inH + ty.idx[o * 4 + k]) * outW + x] * ty.wt[o * 4 + k];
      out[dst + x] = s;
    }
  }
  return out;
}

module.exports = { loadTable, resizePosEmbed };
