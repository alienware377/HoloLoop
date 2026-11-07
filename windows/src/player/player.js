'use strict';
// Player window: draws the current item through the lenticular shader at the
// Go's native pixel grid. Main process owns the playlist; this file only plays
// what it is told and reports back (ended / error / stalled / progress).

const api = window.holo;             // from preload
const SH = window.HOLO_SHADERS;      // shaders.js already declares VERT/FRAG globally

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
if (!gl) api.send('player:error', { msg: 'WebGL2 not available' });

// ------------------------------------------------------------------ GL setup
function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, SH.VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SH.FRAG));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
const posLoc = gl.getAttribLocation(prog, 'position');
gl.enableVertexAttribArray(posLoc);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

const U = {};
for (let i = 0, n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i < n; i++) {
  const name = gl.getActiveUniform(prog, i).name;
  U[name] = gl.getUniformLocation(prog, name);
}

function makeTex(unit) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return t;
}
const contentTex = makeTex(0);
const uiTex = makeTex(1);
gl.uniform1i(U.tex, 0);
gl.uniform1i(U.uiTex, 1);

// ------------------------------------------------------------------ steady edges
// Each new RGBD video frame goes through SH.STEADY into one of two textures (ping-pong):
// depth that wobbles where the picture is still gets smoothed between frames.
const steadyProg = gl.createProgram();
gl.attachShader(steadyProg, compile(gl.VERTEX_SHADER, SH.VERT));
gl.attachShader(steadyProg, compile(gl.FRAGMENT_SHADER, SH.STEADY));
gl.bindAttribLocation(steadyProg, posLoc, 'position');
gl.linkProgram(steadyProg);
if (!gl.getProgramParameter(steadyProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(steadyProg));
const SU = {};
for (const n of ['cur', 'prev', 'depthLoc', 'still', 'texel']) SU[n] = gl.getUniformLocation(steadyProg, n);
const stab = [makeTex(2), makeTex(2)];
const stabFbo = gl.createFramebuffer();
let stabW = 0, stabH = 0, stabI = 0, stabFresh = true, stabT = 0;
let drawTex = contentTex;
const steadyOn = () => !!(look.steady ?? 1) && item?.kind === 'rgbd' && !item.still;

function steady(w, h) {
  const level = look.steady ?? 1;
  if (!item || item.kind !== 'rgbd' || item.still || !level) { drawTex = contentTex; stabFresh = true; return; }
  const t = video().currentTime || 0;
  if (t < stabT - 0.5) stabFresh = true;          // looped back to the start
  stabT = t;
  if (stabW !== w || stabH !== h) {
    for (const t of stab) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
    stabW = w; stabH = h; stabFresh = true;
  }
  const src = stab[stabI], dst = stab[1 - stabI];
  gl.bindFramebuffer(gl.FRAMEBUFFER, stabFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
  gl.viewport(0, 0, w, h);
  gl.useProgram(steadyProg);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, contentTex);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(SU.cur, 0); gl.uniform1i(SU.prev, 2);
  gl.uniform1i(SU.depthLoc, item.depthLoc ?? 2);
  gl.uniform1f(SU.still, stabFresh ? 1 : level >= 2 ? 0.1 : 0.25);
  gl.uniform2f(SU.texel, 1 / w, 1 / h);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.useProgram(prog);
  stabI = 1 - stabI; drawTex = dst; stabFresh = false;
}

// ------------------------------------------------------------------ state
let calib = null;          // derived uniforms from main
let item = null;           // { url, kind: 'quilt'|'rgbd'|'flat'|'image', cols, rows, aspect, depthLoc, ... }
let look = { depthiness: 0.32, focus: 0.5, depthInvert: false, fit: 'fit', zoom: 1, panX: 0, panY: 0, iterations: 14, filterEdge: true };
let fade = 0, fadeTarget = 0, fadeSpeed = 1 / 0.6;   // seconds for a full fade
let debug = { on: false, value: 0.5 };
let ui = { on: false, opacity: 1 };
let contentW = 1, contentH = 1, haveFrame = false;
let pendingEndAfterFade = null;
const FM = window.HOLO_FRAMEMAP;      // framemap.js already declares frameMap globally

const vids = [document.getElementById('va'), document.getElementById('vb')];
let cur = 0;                // index of the playing <video>
let image = null;           // HTMLImageElement for still items
let newFrame = false;

function video() { return vids[cur]; }

// --------------------------------------------------------------- resizing
function resize() {
  const dpr = window.devicePixelRatio || 1;
  let w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
  if (debug.size) [w, h] = debug.size;    // dev: render at the Go's real pixel size
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}
window.addEventListener('resize', resize);
resize();

// --------------------------------------------------------------- framing
// See framemap.js: crop / pan / zoom / quarter turns, worked out per shot on the PC.
let curMap = { u: [1, 0, 0], v: [0, 1, 0], aspect: 1, rect: [0, 0, 1, 1] };

// --------------------------------------------------------------- content fit
function contentAspect() {
  if (!item) return 1;
  if (item.kind === 'quilt') return item.aspect || (contentW / item.cols) / (contentH / item.rows);
  if (item.kind === 'rgbd') {
    const loc = item.depthLoc ?? 2;
    return curMap.aspect;
  }
  return contentW / contentH;
}

function fitScale() {
  const As = canvas.width / canvas.height, Ac = contentAspect();
  let sx = 1, sy = 1;
  const wider = Ac > As;
  const fill = look.fit === 'fill' && !(item?.kind === 'rgbd' && item.frame === 'turnfit');   // turnfit never crops
  if (fill ? !wider : wider) sy = Ac / As; else sx = As / Ac;
  const z = Math.max(0.1, look.zoom || 1);
  return [sx / z, sy / z];
}

// --------------------------------------------------------------- frames
function onVideoFrame(v) {
  if (v !== video()) return;
  newFrame = true;
  v.requestVideoFrameCallback(() => onVideoFrame(v));
}

function upload(src, w, h) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, contentTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);   // v=0 is the bottom row, like desktop GL
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  contentW = w; contentH = h; haveFrame = true;
}

// --------------------------------------------------------------- draw loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (fade < fadeTarget) fade = Math.min(fadeTarget, fade + dt * fadeSpeed);
  else if (fade > fadeTarget) fade = Math.max(fadeTarget, fade - dt * fadeSpeed);
  if (pendingEndAfterFade && fade === 0) { const f = pendingEndAfterFade; pendingEndAfterFade = null; f(); }

  const v = video();
  if (item && !item.still && newFrame && v.readyState >= 2) {
    newFrame = false;
    upload(v, v.videoWidth, v.videoHeight);
    steady(v.videoWidth, v.videoHeight);
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  if (calib) {
    gl.uniform1f(U.pitch, calib.pitch);
    gl.uniform1f(U.slope, calib.slope);
    gl.uniform1f(U.center, calib.center);
    gl.uniform1f(U.subpixelSize, calib.subpixelSize);
    // invView=1 on the Go means "do NOT reverse": reversing when it is set came out
    // backwards on the panel (checked with the view-number test).
    gl.uniform1i(U.invView, calib.invView ? 0 : 1);
  }
  gl.uniform1f(U.screenW, canvas.width);
  gl.uniform1f(U.screenH, canvas.height);

  let mode = 0;
  if (item && haveFrame) mode = item.kind === 'quilt' ? 1 : item.kind === 'rgbd' ? 2 : 3;
  if (!calib && mode !== 0) mode = 3;
  gl.uniform1i(U.mode, mode);
  gl.uniform1i(U.debugView, debug.on ? 1 : 0);
  gl.uniform1f(U.debugViewValue, debug.value);
  gl.uniform1i(U.filterEdge, look.filterEdge ? 1 : 0);
  gl.uniform2f(U.tile, item?.cols || 1, item?.rows || 1);
  gl.uniform2f(U.viewPortion, item?.viewPortionX || 1, item?.viewPortionY || 1);
  gl.uniform1i(U.depthLoc, item?.depthLoc ?? 2);
  gl.uniform1i(U.depthInvert, (look.depthInvert ? 1 : 0) ^ (item?.depthInvert ? 1 : 0));
  gl.uniform1f(U.depthiness, look.depthiness * (item?.depthScale ?? 1));
  gl.uniform1f(U.focus, item?.focus ?? look.focus);
  gl.uniform1i(U.iterations, look.iterations);
  gl.uniform1i(U.edgeFix, Math.max(0, Math.min(4, look.edgeFix | 0)));
  if (item && item.kind === 'rgbd') {
    const loc = item.depthLoc ?? 2;
    const cw = loc >= 2 ? contentW / 2 : contentW, ch = loc >= 2 ? contentH : contentH / 2;
    curMap = FM.frameMap(item.framing, item.frame || 'rotate', item.still ? 0 : (video().currentTime || 0), cw, ch);
    gl.uniform2f(U.colorTexel, 1 / Math.max(cw, 1), 1 / Math.max(ch, 1));   // one real colour pixel, for the edge fixes
  } else curMap = FM.frameMap(null, 'auto', 0, contentW, contentH);
  gl.uniform3f(U.mapU, curMap.u[0], curMap.u[1], curMap.u[2]);
  gl.uniform3f(U.mapV, curMap.v[0], curMap.v[1], curMap.v[2]);
  gl.uniform4f(U.contentRect, curMap.rect[0], curMap.rect[1], curMap.rect[2], curMap.rect[3]);
  const [sx, sy] = fitScale();
  gl.uniform2f(U.contentScale, sx, sy);
  gl.uniform2f(U.contentOffset, look.panX || 0, look.panY || 0);
  gl.uniform1f(U.fade, fade);
  gl.uniform1i(U.uiOn, ui.on ? 1 : 0);
  gl.uniform1f(U.uiOpacity, ui.opacity);

  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, steadyOn() ? drawTex : contentTex);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, uiTex);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (debug.grab && debug.grab <= performance.now()) {   // dev: hand the exact frame to main
    debug.grab = 0;
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    api.send('player:grab', { w: canvas.width, h: canvas.height, t: video().currentTime || 0, px });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --------------------------------------------------------------- playback
let stallT = 0, lastTime = -1, lastProgress = 0;
setInterval(() => {
  const v = video();
  if (!item || item.still || v.paused || !v.src) { stallT = 0; return; }
  if (v.currentTime === lastTime) { stallT += 1; if (stallT === 8) api.send('player:stalled', { url: item.url, t: v.currentTime }); }
  else stallT = 0;
  lastTime = v.currentTime;
}, 1000);

function wire(v) {
  v.addEventListener('ended', () => { if (v === video()) api.send('player:ended', { url: item?.url }); });
  v.addEventListener('error', () => {
    if (v !== video()) return;
    const e = v.error;
    api.send('player:error', { url: item?.url, code: e?.code, msg: e?.message || 'video error' });
  });
  v.addEventListener('timeupdate', () => {
    if (v !== video()) return;
    const now = Date.now();
    if (now - lastProgress > 1000) { lastProgress = now; api.send('player:progress', { url: item?.url, t: v.currentTime, d: v.duration }); }
  });
}
vids.forEach(wire);

function stopVideo(v) {
  try { v.pause(); } catch {}
  v.removeAttribute('src');
  v.load();                           // releases the hardware decoder
}

async function startItem(next) {
  item = next; haveFrame = false; newFrame = false; drawTex = contentTex; stabFresh = true;
  if (next.look) look = Object.assign({}, look, next.look);
  if (next.still) {
    stopVideo(video());
    image = new Image();
    image.onload = () => { upload(image, image.naturalWidth, image.naturalHeight); fadeTarget = 1; api.send('player:started', { url: next.url }); };
    image.onerror = () => api.send('player:error', { url: next.url, msg: 'image failed to load' });
    image.src = next.url;
    return;
  }
  const v = video();
  v.loop = !!next.loop;
  v.muted = !!next.muted;
  v.volume = Math.max(0, Math.min(1, next.volume ?? 1));
  v.src = next.url;
  v.requestVideoFrameCallback(() => onVideoFrame(v));
  try {
    if (next.startAt) v.currentTime = next.startAt;
    await v.play();
    fadeTarget = 1;
    api.send('player:started', { url: next.url, d: v.duration });
  } catch (e) {
    api.send('player:error', { url: next.url, msg: String(e && e.message || e) });
  }
}

api.on('player:calibration', (c) => { calib = c; });
api.on('player:look', (l) => { look = Object.assign({}, look, l); if (!look.steady) stabFresh = true; });
api.on('player:debug', (d) => {
  debug = Object.assign({}, debug, d); if (d.size) resize(); if (d.grab) debug.grab = performance.now();
  if (d.stepTo != null) { try { video().currentTime = d.stepTo; } catch {} }   // dev: next frame, keeps the steady-edges history
});
api.on('player:load', (next) => {
  // fade out the current picture, then swap
  if (item && fade > 0) { fadeTarget = 0; pendingEndAfterFade = () => startItem(next); }
  else startItem(next);
});
api.on('player:black', () => {
  fadeTarget = 0;
  pendingEndAfterFade = () => { stopVideo(video()); item = null; haveFrame = false; api.send('player:blacked', {}); };
});
api.on('player:pause', () => { video().pause(); });
api.on('player:resume', () => { video().play().catch(() => {}); });
api.on('player:seek', (t) => { stabFresh = true; try { video().currentTime = t; } catch {} });
api.on('player:volume', (v) => { video().volume = Math.max(0, Math.min(1, v.volume)); video().muted = !!v.muted; });
api.on('player:ui', (u) => {
  if (u.bitmap) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, uiTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, u.width, u.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(u.bitmap));
  }
  if ('on' in u) ui.on = u.on;
  if ('opacity' in u) ui.opacity = u.opacity;
});

// mouse/keys go to main, which forwards them to the offscreen menu
window.addEventListener('mousemove', (e) => api.send('player:input', { type: 'mouseMove', x: e.clientX / innerWidth, y: e.clientY / innerHeight }));
window.addEventListener('mousedown', (e) => api.send('player:input', { type: 'mouseDown', button: e.button, x: e.clientX / innerWidth, y: e.clientY / innerHeight }));
window.addEventListener('mouseup', (e) => api.send('player:input', { type: 'mouseUp', button: e.button, x: e.clientX / innerWidth, y: e.clientY / innerHeight }));
window.addEventListener('wheel', (e) => api.send('player:input', { type: 'mouseWheel', dy: e.deltaY, x: e.clientX / innerWidth, y: e.clientY / innerHeight }), { passive: true });
window.addEventListener('keydown', (e) => api.send('player:input', { type: 'keyDown', key: e.key, code: e.code }));

api.send('player:ready', { w: canvas.width, h: canvas.height, dpr: window.devicePixelRatio });
