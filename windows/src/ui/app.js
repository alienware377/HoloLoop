'use strict';
// HoloLoop web UI: the PC window and phones share this page. It renders from
// one state object that the app streams over /api/events.

const Q = new URLSearchParams(location.search);
const GO = Q.has('go');
if (GO) document.body.classList.add('go');

let S = null;                       // latest state from the app
let page = (() => { try { return localStorage.getItem('hl.page') || 'home'; } catch { return 'home'; } })();
let busyUntil = 0;                  // don't redraw while the user drags a slider
let lastHtml = '';
const cache = { qr: null };

// ------------------------------------------------------------------ icons
const I = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  magic: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  next: '<path d="M5 4.5v15l10-7.5zM17 4.5h2.5v15H17z" fill="currentColor" stroke="none"/>',
  prev: '<path d="M19 4.5v15L9 12zM4.5 4.5H7v15H4.5z" fill="currentColor" stroke="none"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  file: '<path d="M6 2h8l5 5v15H6z"/><path d="M14 2v5h5"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  cube: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
};
const ico = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[n] || ''}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGES = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Videos', icon: 'list' },
  { id: 'convert', label: 'Making 3D', icon: 'magic' },
  { id: 'look', label: '3D look', icon: 'cube' },
  { id: 'phone', label: 'Phone', icon: 'phone' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];
const TABS = ['home', 'library', 'convert', 'phone', 'settings'];

// ------------------------------------------------------------------ helpers
function fmtTime(s) {
  if (s == null || !isFinite(s)) return '--:--';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
function fmtEta(s) {
  if (s == null || !isFinite(s)) return '';
  if (s < 90) return 'under 2 minutes left';
  if (s < 3600) return `about ${Math.round(s / 60)} minutes left`;
  const h = s / 3600;
  return `about ${h < 10 ? h.toFixed(1) : Math.round(h)} hours left`;
}
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 401) { showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const cmd = (c, extra) => api('/api/cmd', { cmd: c, ...extra }).catch((e) => toast(e.message));
const lib = (action, extra) => api('/api/library', { action, ...extra }).catch((e) => toast(e.message));
function patchFromPath(p, v) { const keys = p.split('.'); const o = {}; let cur = o; keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = v; else cur = cur[k] = {}; }); return o; }
const setCfg = (p, v) => api('/api/config', { patch: patchFromPath(p, v) }).catch((e) => toast(e.message));
const cfg = (p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), S?.config);

function sw(path, title, sub = '') {
  return `<label class="sw"><input type="checkbox" data-cfg="${path}" ${cfg(path) ? 'checked' : ''}><span class="k"></span><span class="t"><b>${title}</b>${sub ? `<i>${sub}</i>` : ''}</span></label>`;
}
function seg(path, options) {
  const cur = cfg(path);
  return `<div class="seg">${options.map(([v, l]) => `<button data-seg="${path}" data-v='${JSON.stringify(v)}' class="${JSON.stringify(cur) === JSON.stringify(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}
function range(path, label, min, max, step, fmt = (v) => v) {
  const v = cfg(path);
  return `<label class="fld"><span>${label}<b data-out="${path}">${fmt(v)}</b></span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-range="${path}" data-fmt="${encodeURIComponent(fmt.toString())}"></label>`;
}

function statusChip(it) {
  switch (it.status) {
    case 'ready': return it.kind === 'quilt' ? '<span class="chip good"><span class="dot"></span>Quilt</span>'
      : it.kind === 'rgbd' ? '<span class="chip good"><span class="dot"></span>Already 3D</span>' : '<span class="chip good"><span class="dot"></span>3D ready</span>';
    case 'converting': return `<span class="chip warn"><span class="dot"></span>Making 3D ${Math.floor((it.progress || 0) * 100)}%</span>`;
    case 'queued': return '<span class="chip"><span class="dot"></span>Waiting its turn</span>';
    case 'failed': return '<span class="chip bad"><span class="dot"></span>Didn\'t work</span>';
    case 'missing': return '<span class="chip bad"><span class="dot"></span>File missing</span>';
    default: return `<span class="chip">${esc(it.status)}</span>`;
  }
}

function phoneBit(it) {
  const p = it.phone;
  if (!p) return '';
  if (p.state === 'ready') return `<span title="The phone gets this smaller copy">Phone copy ${gb(p.size)}</span>`;
  if (p.state === 'making') return `<span class="chip warn"><span class="dot"></span>Phone copy ${Math.floor((p.progress || 0) * 100)}%</span>`;
  return '<span>Phone copy waiting</span>';
}

const FRAMED = { follow: 'follows the subject', mixed: 'crops when there is a subject', fit: 'shows the whole picture', portrait: 'already tall', failed: 'framing failed' };
function frameBits(it) {
  if (it.kind === 'quilt' || it.status !== 'ready') return '';
  const auto = it.framed ? `Auto (${FRAMED[it.framed] || it.framed})` : 'Auto (checking...)';
  return `<select class="framesel" data-frame="${it.id}" title="How it fits the tall screen">
    <option value="auto" ${it.frame === 'auto' ? 'selected' : ''}>${esc(auto)}</option>
    <option value="fit" ${it.frame === 'fit' ? 'selected' : ''}>Show the whole picture</option>
    <option value="turnfit" ${it.frame === 'turnfit' ? 'selected' : ''}>Show the whole picture (auto rotate)</option>
    <option value="fill" ${it.frame === 'fill' ? 'selected' : ''}>Fill the screen (centre)</option>
    <option value="rotate" ${it.frame === 'rotate' ? 'selected' : ''}>Auto + turn to keep people upright</option>
    <option value="rotatebig" ${it.frame === 'rotatebig' ? 'selected' : ''}>Auto + turn for sideways people and close-ups</option></select>`;
}

// ------------------------------------------------------------------ pages
function pageHome() {
  const n = S.now || {};
  const items = S.items || [];
  const ready = items.filter((i) => i.status === 'ready').length;
  const waiting = items.filter((i) => i.status === 'queued' || i.status === 'converting').length;
  const cv = S.convert || {};
  const cur = items.find((i) => i.id === n.currentId);
  const goChip = S.go ? `<span class="chip good"><span class="dot"></span>Go connected as a screen</span>` : `<span class="chip"><span class="dot"></span>Go not connected as a screen</span>`;
  const calChip = S.calibration ? `<span class="chip info"><span class="dot"></span>Calibration ${esc(S.calibration.serial)}</span>` : `<span class="chip warn"><span class="dot"></span>No calibration yet</span>`;

  let working = '';
  if (cv.state === 'working') {
    const pct = cv.total ? Math.floor((cv.done / cv.total) * 100) : 0;
    working = `<div class="card"><div class="card-h"><h2>Making 3D now</h2><span class="chip warn">${pct}%</span></div>
      <div class="name">${esc(cv.name)}</div>
      <div class="pbar"><i style="width:${pct}%"></i></div>
      <p class="muted">${cv.stage === 'joining' ? 'Putting the pieces together...' : cv.stage === 'framing' ? 'Working out how it fits the tall screen...' : `${cv.speed ? cv.speed.toFixed(1) + 'x real time' : 'Starting up...'}${cv.eta ? ' · ' + fmtEta(cv.eta) : ''}`}</p></div>`;
  }
  const pc = S.phoneCopy || {};
  if (pc.state === 'working') {
    const pct = pc.total ? Math.floor((pc.done / pc.total) * 100) : 0;
    working += `<div class="card"><div class="card-h"><h2>Making a phone copy</h2><span class="chip warn">${pct}%</span></div>
      <div class="name">${esc(pc.name)}</div><div class="pbar"><i style="width:${pct}%"></i></div>
      <p class="muted">${pc.speed ? pc.speed.toFixed(1) + 'x real time' : 'Starting up...'}${pc.eta ? ' · ' + fmtEta(pc.eta) : ''}</p></div>`;
  }

  const playing = S.go ? `<div class="card"><div class="now">
      <div class="art${n.asleep ? ' sleep' : ''}" style="${cur ? `background-image:url('/thumb/${cur.id}')` : ''}">${n.asleep ? 'Sleeping' : ''}</div>
      <div>
        <div class="muted">${n.asleep ? 'Asleep' : n.playing ? 'Playing on the Go' : 'Nothing playing'}</div>
        <div class="title">${esc(n.name || (ready ? 'Getting ready...' : 'Add a video to start'))}</div>
        <div class="bar" data-act="seek"><i style="width:${n.d ? Math.min(100, (n.t / n.d) * 100) : 0}%"></i></div>
        <div class="times"><span>${fmtTime(n.t)}</span><span>${fmtTime(n.d)}</span></div>
        <div class="controls">
          <button class="round" data-act="prev" title="Previous">${ico('prev')}</button>
          <button class="round main" data-act="${n.paused ? 'resume' : 'pause'}" title="Play or pause">${ico(n.paused ? 'play' : 'pause')}</button>
          <button class="round" data-act="next" title="Next">${ico('next')}</button>
          <button class="round${S.config.playlist.order === 'shuffle' ? ' on' : ''}" data-act="shuffle" title="${S.config.playlist.order === 'shuffle' ? 'Shuffle is on (tap for in order)' : 'Shuffle'}">${ico('shuffle')}</button>
        </div>
      </div></div></div>` : '';

  return `<h1>HoloLoop</h1>
    <p class="lede">Your PC turns videos into 3D, and the phone on the Looking Glass Go plays them on a loop.</p>
    <div class="chips" style="margin:-8px 0 20px">${goChip}${calChip}<span class="chip">${ready} ready</span>${waiting ? `<span class="chip warn">${waiting} waiting for 3D</span>` : ''}</div>
    ${working}${playing}
    ${items.length ? '' : `<div class="empty"><p>No videos yet.</p><div class="btns" style="justify-content:center"><button class="primary big" data-act="addFiles">${ico('plus')}Add videos</button><button class="ghost big" data-act="addFolder">${ico('folder')}Add a folder</button></div></div>`}`;
}

function pageLibrary() {
  const items = S.items || [];
  const curId = S.now?.currentId;
  const rows = items.map((it, i) => `
    <div class="item${it.id === curId ? ' playing' : ''}${it.enabled ? '' : ' off'}">
      <div class="thumb" style="background-image:url('/thumb/${it.id}')"></div>
      <div style="min-width:0">
        <div class="name" title="${esc(it.path)}">${esc(it.name)}</div>
        <div class="sub">${statusChip(it)}${it.duration ? `<span>${fmtTime(it.duration)}</span>` : ''}${it.status === 'converting' && it.eta ? `<span>${fmtEta(it.eta)}</span>` : ''}${phoneBit(it)}${frameBits(it)}</div>
        ${it.status === 'converting' ? `<div class="pbar"><i style="width:${Math.floor((it.progress || 0) * 100)}%"></i></div>` : ''}
        ${it.status === 'failed' && it.error ? `<div class="err">${esc(it.error.split('\n')[0].slice(0, 180))}</div>` : ''}
      </div>
      <div class="acts">
        ${it.status === 'failed' ? `<button class="mini" title="Try again" data-act="retry" data-id="${it.id}">${ico('retry')}</button>` : ''}
        ${S.go && it.status === 'ready' ? `<button class="mini" title="Play now" data-act="playId" data-id="${it.id}">${ico('play')}</button>` : ''}
        <button class="mini" title="Move up" data-act="move" data-d="-1" data-id="${it.id}" ${i === 0 ? 'disabled' : ''}>${ico('up')}</button>
        <button class="mini" title="Move down" data-act="move" data-d="1" data-id="${it.id}" ${i === items.length - 1 ? 'disabled' : ''}>${ico('down')}</button>
        <button class="mini" title="${it.enabled ? 'Leave out of the loop' : 'Put back in the loop'}" data-act="enable" data-on="${it.enabled ? 0 : 1}" data-id="${it.id}">${ico(it.enabled ? 'eye' : 'eyeOff')}</button>
        <button class="mini danger" title="Remove" data-act="remove" data-id="${it.id}">${ico('trash')}</button>
      </div>
    </div>`).join('');
  const folders = (S.folders || []).map((f) => `<div class="prow"><div style="min-width:0"><div class="name">${esc(f)}</div><div class="sub">New videos here are added by themselves</div></div><button class="mini danger" title="Stop watching" data-act="removeFolder" data-path="${esc(f)}">${ico('x')}</button></div>`).join('');
  return `<h1>Videos</h1>
    <p class="lede">Everything here plays on a loop, ${S.config.playlist.order === 'shuffle' ? 'shuffled' : 'in this order'}. Plain videos get a 3D copy made first; quilts and RGBD files are ready right away.</p>
    <div class="btns" style="margin:-6px 0 18px">
      <button class="ghost${S.config.playlist.order === 'shuffle' ? ' on' : ''}" data-act="shuffle">${ico('shuffle')}${S.config.playlist.order === 'shuffle' ? 'Shuffle: on' : 'Shuffle: off'}</button>
      <button class="primary" data-act="addFiles">${ico('plus')}Add videos</button>
      <button class="ghost" data-act="addFolder">${ico('folder')}Watch a folder</button>
      <button class="ghost" data-act="rescan">${ico('refresh')}Check folders now</button>
    </div>
    ${folders ? `<div class="card"><h2 style="margin-bottom:10px">Watched folders</h2><div class="rows">${folders}</div></div>` : ''}
    ${items.length ? `<div class="rows">${rows}</div>` : '<div class="empty">No videos yet.</div>'}`;
}

function pageConvert() {
  const cv = S.convert || {};
  const c = S.config.convert;
  const pct = cv.total ? Math.floor((cv.done / cv.total) * 100) : 0;
  const now = cv.state === 'working'
    ? `<div class="name">${esc(cv.name)}</div><div class="pbar"><i style="width:${pct}%"></i></div>
       <p class="muted">${pct}% · ${cv.speed ? cv.speed.toFixed(1) + 'x real time' : 'starting'}${cv.eta ? ' · ' + fmtEta(cv.eta) : ''}${cv.backend ? ` · ${/dml/.test(cv.backend) ? 'on the graphics card' : 'on the processor (slow)'}` : ''}</p>`
    : `<p class="muted" style="margin:0">${c.paused ? 'Paused.' : 'Nothing waiting. Add videos and they start here by themselves.'}</p>`;
  return `<h1>Making 3D</h1>
    <p class="lede">Each plain video gets a depth map, frame by frame, saved as a 3D copy. Big films take a while; progress is kept if the PC restarts.</p>
    <div class="card"><div class="card-h"><h2>Right now</h2>
      <button class="ghost" data-act="togglePause">${c.paused ? ico('play') + 'Resume' : ico('pause') + 'Pause'}</button></div>${now}</div>
    <div class="card"><h2>Depth detail</h2>
      <p class="tip" style="margin:4px 0 10px">More detail looks a little sharper around edges but takes longer.</p>
      ${seg('convert.depthLong', [[392, 'Quick'], [518, 'Balanced'], [700, 'Fine']])}
      <h2 style="margin-top:18px">Picture size</h2>
      <p class="tip" style="margin:4px 0 10px">The Go shows about 1280 pixels at most, so bigger only costs space.</p>
      ${seg('convert.maxLong', [[960, '960'], [1280, '1280'], [1600, '1600']])}
    </div>
    <div class="card"><h2>Where 3D copies go</h2>
      <p class="muted" style="margin:6px 0 10px; overflow-wrap:anywhere">${esc(c.cacheDir)}</p>
      ${S.local ? `<button class="ghost" data-act="pickCache">${ico('folder')}Change folder</button>` : ''}
      <p class="tip">Copies are named <code>name.xxxx_rgbd.mp4</code>. You can copy them anywhere; they already contain the 3D.</p>
    </div>`;
}

// 3D edge fixing: the shader's edgeFix numbers, in order (the phone app has the same list)
const EDGE_MODES = [
  ['Off (original)', 'The plain 3D, as before. Rainbow edges and smears can show when you look from the side.'],
  ['Clean colours', 'Stops the rainbow edges. The gaps beside people still smear a little, but in plain colour. Very light.'],
  ['Clean + fill gaps', 'Recommended. Stops the rainbows and fills the gaps beside people with nearby background instead of smears. At the far sides the picture edge becomes a clean black frame, like a window.'],
  ['Fill gaps + calmer sides', 'Like the one above, and calmer when you look from far to the side. The sides look a bit flatter; the front view is the same.'],
  ['Best quality (slow)', 'The cleanest edges and gap fills. Much heavier: smooth on a PC, but the phone may drop frames.'],
];
function edgeSel() {
  const v = Number(cfg('look.edgeFix') || 0);
  return `<label class="fld"><span>3D edge fixing</span>
    <select data-cfgsel="look.edgeFix">${EDGE_MODES.map(([l], i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="tip" style="margin-top:6px">${EDGE_MODES[v]?.[1] || ''}</p>`;
}

function pageLook() {
  const pct = (v) => Math.round((v / 0.8) * 100) + '%';
  return `<h1>3D look</h1>
    <p class="lede">How deep things look on the Go${S.go ? '' : ' (applies when the Go is plugged into this PC; the phone has its own copy)'}.</p>
    <div class="card">
      ${range('look.depthiness', '3D strength', 0, 0.8, 0.01, pct)}
      ${range('look.focus', 'What sits on the glass', 0, 1, 0.01, (v) => v < 0.4 ? 'far things' : v > 0.6 ? 'near things' : 'middle')}
      <h2 style="margin-top:14px">Picture</h2><div style="margin-top:8px">${seg('look.fit', [['fit', 'Show it all'], ['fill', 'Fill the screen']])}</div>
      ${range('look.zoom', 'Zoom', 1, 2, 0.01, (v) => Number(v).toFixed(2) + 'x')}
      <div style="margin-top:14px">${edgeSel()}</div>
      <h2 style="margin-top:14px">Steady edges</h2>
      <p class="tip" style="margin:4px 0 8px">Smooths the depth between frames where the picture is still, so edges stop shaking. Moving things stay sharp.</p>
      <div>${seg('look.steady', [[0, 'Off'], [1, 'Normal'], [2, 'Strong']])}</div>
      <h2 style="margin-top:14px">Smoothness</h2><div style="margin-top:8px">${seg('look.iterations', [[8, 'Light'], [14, 'Balanced'], [24, 'Best']])}</div>
      <div style="margin-top:12px">${sw('look.depthInvert', 'Flip depth', 'If faces look pushed in instead of popping out')}</div>
      <div class="btns">${S.go ? `<button class="ghost" data-act="testPattern">${ico('eye')}Show test pattern</button><button class="ghost" data-act="next">${ico('next')}Back to the videos</button>` : ''}</div>
    </div>`;
}

// How much room the phone needs at a phone-copy bitrate (Mbit/s). Videos already lighter
// than that are sent as they are, like the app does.
function phoneEstimate(mbps) {
  let now = 0, after = 0, n = 0;
  for (const s of S.phoneCopy?.sizes || []) {
    n++; now += s.size;
    after += s.duration && s.size * 8 / s.duration > mbps * 1e6 * 1.25 ? (mbps * 1e6 + 160e3) / 8 * s.duration : s.size;
  }
  return { now, after, n };
}
const gb = (b) => (b / 1e9).toFixed(b < 10e9 ? 1 : 0) + ' GB';
function estText(mbps) {
  const e = phoneEstimate(mbps);
  return e.n ? `All ${e.n} videos: about <b>${gb(e.after)}</b> on the phone, instead of ${gb(e.now)}.` : '';
}

function phoneCopyCard() {
  const p = cfg('phone') || {};
  const pc = S.phoneCopy || {};
  const pct = pc.total ? Math.floor((pc.done / pc.total) * 100) : 0;
  const busy = pc.state === 'working'
    ? `<div class="name" style="margin-top:12px">Making a phone copy of ${esc(pc.name)}</div><div class="pbar"><i style="width:${pct}%"></i></div>
       <p class="muted">${pct}%${pc.speed ? ` · ${pc.speed.toFixed(1)}x real time` : ''}${pc.eta ? ' · ' + fmtEta(pc.eta) : ''}</p>` : '';
  const items = S.items || [];
  const ready = items.filter((i) => i.phone?.state === 'ready').length, todo = items.filter((i) => i.phone && i.phone.state !== 'ready').length;
  return `<div class="card"><h2>Smaller copies for the phone</h2>
      <p class="tip" style="margin:4px 0 10px">Makes a lighter copy of each 3D video for the phone, so more fit on it. The full-size 3D copies on this PC stay as they are, and the 3D and framing don't have to be made again.</p>
      ${sw('phone.compress', 'Send smaller copies to the phone', 'The phone swaps each big video for its small copy once it is made')}
      ${p.compress ? `<div style="margin-top:12px">${range('phone.mbps', 'Quality', 2, 16, 0.5, (v) => `${v} Mbit/s · about ${(v * 0.45).toFixed(1)} GB per hour · ${v < 4 ? 'small, softer picture' : v < 8 ? 'good' : v < 12 ? 'very good' : 'close to the original'}`)}</div>
      <p class="muted" data-est style="margin:4px 0 0">${estText(p.mbps)}</p>
      <p class="muted" style="margin:4px 0 0">${ready} made${todo ? `, ${todo} still to make` : ''}.</p>${busy}` : ''}
    </div>`;
}

function pagePhone() {
  const r = S.remote || {};
  const addr = r.addresses?.[0];
  return `<h1>Phone</h1>
    <p class="lede">The phone on the Go fetches finished 3D videos from this PC over Wi-Fi, and you can control HoloLoop from any phone browser.</p>
    <div class="card">${sw('remote.enabled', 'Let phones connect', 'Phones on the same Wi-Fi only')}</div>
    ${phoneCopyCard()}
    ${r.enabled && addr ? `<div class="card"><div class="row" style="align-items:flex-start;gap:24px">
      <div class="qr" id="qr">${cache.qr || ''}</div>
      <div class="grow">
        <h2>Address</h2><p class="pin" style="font-size:20px;letter-spacing:0">${esc(addr)}:${r.port}</p>
        ${r.pin ? `<h2 style="margin-top:12px">PIN</h2><p class="pin">${esc(r.pin)}</p>` : ''}
        <p class="tip">Scan the code with the phone camera, or type the address into its browser, then enter the PIN.</p>
      </div></div></div>` : r.enabled ? '<div class="card"><p class="muted">No Wi-Fi or network address found on this PC.</p></div>' : ''}`;
}

function pageSettings() {
  const st = S.startup;
  return `<h1>Settings</h1>
    <div class="card">
      ${st ? `<label class="sw"><input type="checkbox" data-startup ${st.enabled ? 'checked' : ''}><span class="k"></span><span class="t"><b>Open with Windows</b><i>Starts quietly in the tray so 3D copies keep getting made</i></span></label>` : ''}
      ${sw('startup.openControlWindow', 'Show this window at start', 'Off = stay in the tray')}
    </div>
    <div class="card"><h2>Looking Glass Go</h2>
      <p class="muted" style="margin:8px 0">${S.calibration ? `Calibration <b>${esc(S.calibration.serial)}</b> ${S.calibration.live ? 'read from the Go just now' : 'saved from earlier'}.` : 'No calibration yet. Plug the Go into this PC with USB once and press Read again.'}</p>
      <p class="muted" style="margin:8px 0">${S.go ? `Showing on the Go (${S.go.w}x${S.go.h}).` : 'The Go isn\'t connected to this PC as a screen. That\'s fine: the phone plays it.'}</p>
      <div class="btns"><button class="ghost" data-act="reloadCal">${ico('refresh')}Read calibration again</button></div>
    </div>
    <div class="card"><h2>About</h2>
      <p class="muted" style="margin:8px 0">HoloLoop ${esc(S.version)} · build ${esc(S.build?.stamp || 'dev')}</p>
      <button class="ghost" data-act="showLog">${ico('file')}Show recent log</button>
    </div>`;
}

const RENDER = { home: pageHome, library: pageLibrary, convert: pageConvert, look: pageLook, phone: pagePhone, settings: pageSettings };

// ------------------------------------------------------------------ render
function renderNav() {
  const waiting = (S?.items || []).filter((i) => i.status === 'queued' || i.status === 'converting').length;
  document.getElementById('navlist').innerHTML = PAGES.map((p) => `<button class="nav${p.id === page ? ' on' : ''}" data-page="${p.id}">${ico(p.icon)}<span>${p.label}</span>${p.id === 'convert' && waiting ? `<span class="chip warn badge">${waiting}</span>` : ''}</button>`).join('');
  document.getElementById('tabs').innerHTML = TABS.map((id) => { const p = PAGES.find((x) => x.id === id); return `<button class="${id === page ? 'on' : ''}" data-page="${id}">${ico(p.icon)}<span>${p.label}</span></button>`; }).join('');
  document.getElementById('stamp').textContent = S ? `v${S.version} · ${S.build?.stamp || 'dev'}` : '';
}

function render(force = false) {
  if (!S) return;
  if (!force && Date.now() < busyUntil) { clearTimeout(render.t); render.t = setTimeout(() => render(), busyUntil - Date.now() + 50); return; }
  renderNav();
  const html = (RENDER[page] || pageHome)();
  if (html !== lastHtml || force) {
    const main = document.getElementById('page');
    const y = main.scrollTop;
    main.innerHTML = html; lastHtml = html;
    main.scrollTop = y;
    if (page === 'phone') loadQr();
  }
}

async function loadQr() {
  if (cache.qr) return;
  try { const r = await api('/api/qr'); cache.qr = r.svg || ''; const el = document.getElementById('qr'); if (el) el.innerHTML = cache.qr; } catch {}
}

function go(p) { page = p; try { localStorage.setItem('hl.page', p); } catch {} lastHtml = ''; render(true); document.getElementById('page').scrollTop = 0; }

// ------------------------------------------------------------------ add-files modal (phones and the Go)
async function browse(p = '') {
  const m = document.getElementById('modal');
  let r;
  try { r = await api('/api/browse?path=' + encodeURIComponent(p)); } catch (e) { toast(e.message); return; }
  m.innerHTML = `<div class="card"><div class="card-h"><h2>Add from the PC</h2><button class="mini" data-act="closeModal">${ico('x')}</button></div>
    <p class="muted" style="margin:0 0 8px; overflow-wrap:anywhere">${esc(r.path || 'This PC')}</p>
    ${r.path ? `<div class="btns" style="margin:0 0 10px"><button class="primary" data-act="addThisFolder" data-path="${esc(r.path)}">${ico('folder')}Watch this whole folder</button></div>` : ''}
    <div>${r.parent !== null ? `<div class="fbrow" data-browse="${esc(r.parent)}">${ico('up')}<span class="grow">Back</span></div>` : ''}
    ${r.entries.map((e) => e.dir ? `<div class="fbrow" data-browse="${esc(e.path)}">${ico('folder')}<span class="grow">${esc(e.name)}</span></div>`
      : `<div class="fbrow" data-addfile="${esc(e.path)}">${ico('file')}<span class="grow">${esc(e.name)}</span>${ico('plus')}</div>`).join('') || '<p class="muted">Nothing playable here.</p>'}</div></div>`;
  m.hidden = false;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const pg = e.target.closest('[data-page]');
  if (pg) return go(pg.dataset.page);
  const br = e.target.closest('[data-browse]');
  if (br) return browse(br.dataset.browse);
  const af = e.target.closest('[data-addfile]');
  if (af) { await lib('add', { paths: [af.dataset.addfile] }); toast('Added'); af.remove(); return; }
  const sg = e.target.closest('[data-seg]');
  if (sg) { setCfg(sg.dataset.seg, JSON.parse(sg.dataset.v)); return; }
  const b = e.target.closest('[data-act]');
  if (!b) { if (e.target.id === 'modal') e.target.hidden = true; return; }
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'next': case 'prev': case 'pause': case 'resume': case 'testPattern': return cmd(a);
    case 'playId': return cmd('play', { id });
    case 'seek': { const r = b.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; if (S.now?.d) cmd('seek', { t: f * S.now.d }); return; }
    case 'addFiles': case 'addFolder':
      if (S.local && !GO) { try { const r = await api('/api/dialog', { type: a === 'addFolder' ? 'folder' : 'files' }); if (!r.canceled) toast('Added'); } catch (er) { toast(er.message); } }
      else browse('');
      return;
    case 'addThisFolder': await lib('addFolder', { path: b.dataset.path }); document.getElementById('modal').hidden = true; toast('Watching that folder'); return;
    case 'closeModal': document.getElementById('modal').hidden = true; return;
    case 'rescan': await lib('rescan'); toast('Checked'); return;
    case 'removeFolder': return lib('removeFolder', { path: b.dataset.path });
    case 'retry': return lib('retry', { id });
    case 'move': return lib('move', { id, delta: Number(b.dataset.d) });
    case 'enable': return lib('enable', { id, enabled: b.dataset.on === '1' });
    case 'remove': {
      const it = S.items.find((x) => x.id === id);
      const del = it && it.kind === 'video2d' ? confirm(`Remove "${it.name}"?\n\nOK also deletes its 3D copy. Cancel keeps everything.`) : confirm(`Remove "${it?.name}" from the list?`);
      if (!del && it?.kind !== 'video2d') return;
      return lib('remove', { id, deleteCache: del });
    }
    case 'togglePause': return setCfg('convert.paused', !S.config.convert.paused);
    case 'shuffle': return setCfg('playlist.order', S.config.playlist.order === 'shuffle' ? 'inOrder' : 'shuffle');
    case 'pickCache': return api('/api/pickCacheDir', {}).catch((er) => toast(er.message));
    case 'reloadCal': await api('/api/calibration', { action: 'reload' }); toast(S.calibration ? 'Calibration read' : 'Still no Go found'); return;
    case 'showLog': {
      const r = await api('/api/log');
      const m = document.getElementById('modal');
      m.innerHTML = `<div class="card"><div class="card-h"><h2>Recent log</h2><button class="mini" data-act="closeModal">${ico('x')}</button></div><pre style="white-space:pre-wrap;font-size:11.5px;color:var(--mut);margin:0">${esc(r.lines.slice(-120).join('\n'))}</pre></div>`;
      m.hidden = false; return;
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.cfg) setCfg(t.dataset.cfg, t.checked);
  if (t.dataset.range) { setCfg(t.dataset.range, Number(t.value)); busyUntil = Date.now() + 600; }
  if ('startup' in t.dataset) api('/api/config', { patch: { startup: { withWindows: t.checked } } }).catch((er) => toast(er.message));
  if (t.dataset.frame) lib('frame', { id: t.dataset.frame, frame: t.value });
  if (t.dataset.cfgsel) {
    setCfg(t.dataset.cfgsel, Number(t.value));
    const tip = t.closest('.fld')?.nextElementSibling;
    if (tip && t.dataset.cfgsel === 'look.edgeFix') tip.textContent = EDGE_MODES[Number(t.value)]?.[1] || '';
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset.range) return;
  busyUntil = Date.now() + 1500;
  const out = document.querySelector(`[data-out="${t.dataset.range}"]`);
  if (out) { try { out.textContent = (0, eval)(decodeURIComponent(t.dataset.fmt))(Number(t.value)); } catch { out.textContent = t.value; } }
  if (t.dataset.range === 'phone.mbps') { const est = document.querySelector('[data-est]'); if (est) est.innerHTML = estText(Number(t.value)); }
});
document.addEventListener('pointerdown', (e) => { if (e.target.matches('input[type=range]')) busyUntil = Date.now() + 60000; });
document.addEventListener('focusin', (e) => { if (e.target.matches('select')) busyUntil = Date.now() + 20000; });   // keep an open list open
document.addEventListener('focusout', (e) => { if (e.target.matches('select')) busyUntil = Date.now() + 300; });
document.addEventListener('pointerup', () => { if (busyUntil > Date.now() + 2000) busyUntil = Date.now() + 400; });

if (GO) {
  const c = document.getElementById('cursor'); c.hidden = false;
  document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; });
}

// ------------------------------------------------------------------ connect
function showLogin() { document.getElementById('login').hidden = false; document.getElementById('pin').focus(); }
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = document.getElementById('pin').value;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { document.getElementById('login').hidden = true; connect(); }
  else document.getElementById('loginErr').textContent = j.error || 'That did not work.';
});

let es = null;
function connect() {
  try { es?.close(); } catch {}
  es = new EventSource('/api/events');
  es.onmessage = (m) => { S = JSON.parse(m.data); render(); };
  es.onerror = async () => {
    es.close();
    const r = await fetch('/api/state').catch(() => null);
    if (r && r.status === 401) return showLogin();
    setTimeout(connect, 3000);
  };
}
connect();
