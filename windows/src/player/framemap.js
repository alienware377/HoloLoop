'use strict';
// Framing -> a mapping from the shown picture (q in 0..1, x right, y up) to the
// video's colour picture (u right, v up). Handles crop, pan, zoom and turning the
// picture a quarter turn (smoothly, when it happens inside a shot). 'turnfit' needs no
// framing: it shows everything and turns wide pictures to stand tall.
// Same maths as Framing.kt on the phone.

const TURN_SEC = 0.6;

function keyAt(K, t) {
  let lo = 0, hi = K.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (K[m][0] <= t) lo = m; else hi = m - 1; }
  return lo;
}

// crop centre / width (content-width units) for an upright moment
function flatCW(F, mode, t) {
  if (mode === 'fill') return [0.5, F.minW];
  if (mode === 'fit' || !F.keys || !F.keys.length) return [0.5, 1];
  const K = F.keys, i = keyAt(K, t), a = K[i], b = K[i + 1];
  if (!b || b[3] || t <= a[0]) return [a[1], a[2]];
  const f = Math.min(1, (t - a[0]) / Math.max(1e-6, b[0] - a[0]));
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// a view state in content pixels: rotation phi (deg), window centre offset, window size
function flatState(F, mode, t, Cw, Ch) {
  const [c, w] = flatCW(F, mode, t);
  return { phi: 0, cx: (c - 0.5) * Cw, cy: 0, W: w * Cw, H: Ch };
}
function turnedState(F, r, c, Cw, Ch) {
  const w = Math.min(1, F.rotMinW || 1);
  c = Math.min(1 - w / 2, Math.max(w / 2, c));
  return { phi: r, cx: 0, cy: (r === 90 ? 1 : -1) * (c - 0.5) * Ch, W: w * Ch, H: Cw };
}

function frameMap(F, mode, t, colorW, colorH) {
  if (!F && mode !== 'turnfit') return { u: [1, 0, 0], v: [0, 1, 0], aspect: colorW / colorH, rect: [0, 0, 1, 1] };
  const [x0, y0, x1, y1] = F ? F.content : [0, 0, 1, 1];
  const U0 = x0, U1 = x1, V0 = 1 - y1, V1 = 1 - y0;     // image rows count from the top, GL v from the bottom
  const Cw = (U1 - U0) * colorW, Ch = (V1 - V0) * colorH;
  let S;
  // turnfit: the whole picture, a wide one turned a quarter turn clockwise to stand tall (no looking at people)
  if (mode === 'turnfit') S = Cw > Ch ? { phi: 90, cx: 0, cy: 0, W: Ch, H: Cw } : { phi: 0, cx: 0, cy: 0, W: Cw, H: Ch };
  else if (mode !== 'rotate' || !F.rot || !F.rot.length) S = flatState(F, mode, t, Cw, Ch);
  else {
    const R = F.rot, k = keyAt(R, t), r = R[k][1];
    const nx = R[k + 1];
    let c = R[k][2];
    if (r !== 0 && nx && nx[1] === r && !nx[3]) c += (nx[2] - c) * Math.min(1, (t - R[k][0]) / Math.max(1e-6, nx[0] - R[k][0]));
    const cur = r === 0 ? flatState(F, 'auto', t, Cw, Ch) : turnedState(F, r, c, Cw, Ch);
    S = cur;
    if (k > 0 && R[k - 1][1] !== r && !R[k][3] && t - R[k][0] < TURN_SEC) {      // turning inside a shot: animate
      const p = R[k - 1];
      const prev = p[1] === 0 ? flatState(F, 'auto', t, Cw, Ch) : turnedState(F, p[1], p[2], Cw, Ch);
      let f = Math.max(0, (t - R[k][0]) / TURN_SEC); f = f * f * (3 - 2 * f);
      S = {}; for (const key of ['phi', 'cx', 'cy', 'W', 'H']) S[key] = prev[key] + (cur[key] - prev[key]) * f;
    }
  }
  const a = S.phi * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  const L00 = cs * S.W, L01 = -sn * S.H, L10 = sn * S.W, L11 = cs * S.H;
  const Uc = (U0 + U1) / 2, Vc = (V0 + V1) / 2;
  return {
    u: [L00 / colorW, L01 / colorW, Uc + (S.cx - 0.5 * L00 - 0.5 * L01) / colorW],
    v: [L10 / colorH, L11 / colorH, Vc + (S.cy - 0.5 * L10 - 0.5 * L11) / colorH],
    aspect: S.W / S.H, rect: [U0, V0, U1, V1],
  };
}

if (typeof module !== 'undefined') module.exports = { frameMap };
else window.HOLO_FRAMEMAP = { frameMap };
