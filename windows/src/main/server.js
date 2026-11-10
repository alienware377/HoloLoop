'use strict';
// One web app serves every screen: the desktop control window, the menu drawn on
// the Go, and the phone remote. Local requests are trusted; phones log in with
// the PIN shown in Settings (or on the Go) and get a cookie.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');
const { execFile } = require('child_process');

let hub = null, server = null, boundPort = null;
const UI_DIR = path.join(__dirname, '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const clients = new Set();
const attempts = new Map();

function token() { return crypto.createHmac('sha256', hub.config.get().remote.secret).update('hololoop-remote').digest('hex').slice(0, 40); }
function isLocal(req) { const a = req.socket.remoteAddress || ''; return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function cookies(req) { const o = {}; for (const p of String(req.headers.cookie || '').split(';')) { const [k, ...v] = p.trim().split('='); if (k) o[k] = decodeURIComponent(v.join('=')); } return o; }
function authed(req) { return isLocal(req) || cookies(req).hl === token() || req.headers['x-hololoop-token'] === token(); }

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    if (/^169\.254\./.test(a.address)) continue;
    const pri = /^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) continue;
    out.push({ name, address: a.address, pri });
  }
  return out.sort((a, b) => a.pri - b.pri);
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (b) => { n += b.length; if (n > 2e6) { reject(new Error('too big')); req.destroy(); } else parts.push(b); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(e); } });
  });
}

// ----------------------------------------------------------------- state
function itemView(it) {
  return { id: it.id, name: it.name, kind: it.kind, still: !!it.still, status: it.status, enabled: it.enabled, progress: it.progress || 0,
    eta: it.eta ?? null, error: it.error || null, duration: it.meta?.duration || null, path: it.path, look: it.look || null, resumeAt: it.resumeAt || 0,
    quality: it.quality || null, redo: it.redo || null,
    frame: it.frame || 'rotatebig', framed: it.meta?.framing ? (it.meta.framing.failed ? 'failed' : it.meta.framing.summary?.decided) : null,
    phone: hub.phonecopy?.describe(it) || null };
}

function state(req) {
  const c = hub.config.get();
  const L = hub.library.get();
  const cal = hub.getCalibration();
  const remote = { enabled: c.remote.enabled, port: boundPort, addresses: lanAddresses().map((a) => a.address) };
  if (isLocal(req)) remote.pin = c.remote.pin;
  return {
    build: hub.BUILD, version: hub.app.getVersion(), dev: hub.DEV, local: isLocal(req), elevated: hub.elevated ?? null,
    now: hub.playback.state(),
    items: L.items.map(itemView), folders: L.folders,
    convert: hub.converter.status(),
    phoneCopy: hub.phonecopy ? { ...hub.phonecopy.status(), sizes: hub.phonecopy.sizes() } : null,
    sleep: hub.schedule.describe(),
    go: hub.getGo(),
    calibration: cal ? { serial: cal.raw.serial, live: cal.live, source: cal.source } : null,
    config: { ...c, remote: { enabled: c.remote.enabled, port: c.remote.port } },
    remote,
    blocker: hub.blocker?.summary?.() || null,
    startup: hub.startup?.status?.() || null,
  };
}

let pushTimer = null;
function broadcast() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    for (const c of clients) { try { c.res.write(`data: ${JSON.stringify(state(c.req))}\n\n`); } catch {} }
  }, 300);
}

// ----------------------------------------------------------------- thumbnails
const thumbBusy = new Map();
function thumbPath(it) { return path.join(hub.config.get().convert.cacheDir, 'thumbs', `${it.key}.jpg`); }
function makeThumb(it) {
  const out = thumbPath(it);
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbBusy.has(out)) return thumbBusy.get(out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { FFMPEG } = require('../convert/media');
  const at = it.still ? [] : ['-ss', String(Math.min(30, Math.max(1, (it.meta?.duration || 20) * 0.1)))];
  let vf = 'scale=320:-2';
  if (it.kind === 'quilt') vf = `crop=iw/${it.cols}:ih/${it.rows}:iw/${it.cols}*${Math.floor(it.cols / 2)}:ih-ih/${it.rows}*${Math.floor(it.rows / 2) + 1},scale=320:-2`;
  if (it.kind === 'rgbd') vf = 'crop=iw/2:ih:0:0,scale=320:-2';
  const p = new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...at, '-i', it.path, '-frames:v', '1', '-vf', vf, '-q:v', '4', out], { windowsHide: true, timeout: 30000 }, () => {
      thumbBusy.delete(out); resolve(fs.existsSync(out) ? out : null);
    });
  });
  thumbBusy.set(out, p);
  return p;
}

// ----------------------------------------------------------------- folder browsing (phone add)
function drives() {
  const out = [];
  for (let i = 67; i <= 90; i++) { const d = String.fromCharCode(i) + ':\\'; try { fs.accessSync(d); out.push({ name: d, path: d, dir: true }); } catch {} }
  return out;
}
function browse(p) {
  if (!p) return { path: '', parent: null, entries: drives() };
  const abs = path.resolve(p);
  const ents = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !/^\$|^System Volume Information$/i.test(e.name));
  const entries = [];
  for (const e of ents) {
    if (e.isDirectory()) entries.push({ name: e.name, path: path.join(abs, e.name), dir: true });
    else if (hub.library.classify(e.name)) entries.push({ name: e.name, path: path.join(abs, e.name), dir: false });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(abs) === abs ? '' : path.dirname(abs);
  return { path: abs, parent, entries };
}

// ----------------------------------------------------------------- commands
async function api(req, res, url) {
  const route = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};
  const L = hub.library, pb = hub.playback;
  const ok = (extra = {}) => { broadcast(); send(res, 200, { ok: true, ...extra }); };

  switch (route) {
    case '/api/state': return send(res, 200, state(req));
    case '/api/cmd': {
      const c = body.cmd;
      if (c === 'next') pb.next();
      else if (c === 'prev') pb.prev();
      else if (c === 'pause') pb.pause();
      else if (c === 'resume') pb.resume();
      else if (c === 'play') pb.playId(body.id);
      else if (c === 'seek') hub.sendPlayer('player:seek', Number(body.t) || 0);
      else if (c === 'sleepNow') { hub.schedule.sleepNow(); await hub.applySleep(); }
      else if (c === 'wakeNow') { hub.schedule.wakeNow(); await hub.applySleep(); }
      else if (c === 'volume') { hub.config.update({ audio: { volume: Math.max(0, Math.min(1, Number(body.volume))), muted: !!body.muted } }); hub.sendPlayer('player:volume', hub.config.get().audio); }
      else if (c === 'testPattern') {
        const f = path.join(__dirname, '..', '..', 'assets', 'viewnum_qs11x6a0.667.png').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        const { pathToFileURL } = require('url');
        hub.sendPlayer('player:load', { id: 'test', url: pathToFileURL(f).href, kind: 'quilt', still: true, cols: 11, rows: 6, aspect: 0.667, look: hub.config.get().look });
      }
      else if (c === 'menu') hub.ui?.showGoMenu?.(!!body.show);
      else return send(res, 400, { error: 'unknown command' });
      return ok();
    }
    case '/api/config': {
      const patch = body.patch || {};
      delete patch.remote?.secret;
      if (patch.remote && 'pin' in patch.remote && !isLocal(req)) delete patch.remote.pin;
      hub.config.update(patch);
      if (patch.sleep) await hub.applySleep();
      if (patch.display) hub.placePlayer();
      if (patch.remote && ('enabled' in patch.remote || 'port' in patch.remote)) setTimeout(restart, 300);
      if (patch.startup && hub.startup) await hub.startup.apply();
      if (patch.blocker && hub.blocker) hub.blocker.reapply();
      return ok();
    }
    case '/api/library': {
      const a = body.action;
      if (a === 'add') L.addPaths(body.paths || []);
      else if (a === 'addFolder') L.addFolder(body.path);
      else if (a === 'removeFolder') L.removeFolder(body.path);
      else if (a === 'remove') L.removeItem(body.id, { deleteCache: !!body.deleteCache });
      else if (a === 'move') L.move(body.id, Number(body.delta) || 0);
      else if (a === 'reorder') L.reorder(body.ids || []);
      else if (a === 'enable') L.patchItem(body.id, { enabled: !!body.enabled });
      else if (a === 'look') L.patchItem(body.id, { look: body.look || null });
      else if (a === 'frame') L.patchItem(body.id, { frame: ['auto', 'fit', 'turnfit', 'fill', 'rotate', 'rotatebig'].includes(body.frame) ? body.frame : 'rotatebig' });
      else if (a === 'quality') hub.converter.setQuality(body.id, body.quality);
      else if (a === 'retry') hub.converter.retry(body.id);
      else if (a === 'rescan') L.rescan();
      else return send(res, 400, { error: 'unknown action' });
      hub.converter.tick();
      return ok();
    }
    case '/api/browse': {
      try { return send(res, 200, browse(url.searchParams.get('path') || '')); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    case '/api/dialog': {
      if (!isLocal(req)) return send(res, 403, { error: 'only on the PC itself' });
      const win = hub.ui?.controlWindow?.();
      const r = await hub.dialog.showOpenDialog(win || undefined, body.type === 'folder'
        ? { title: 'Pick a folder to loop', properties: ['openDirectory'] }
        : { title: 'Add videos or pictures', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Videos and pictures', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'wmv', 'ts', 'mpg', 'png', 'jpg', 'jpeg', 'webp'] }] });
      if (r.canceled) return send(res, 200, { canceled: true });
      if (body.type === 'folder') L.addFolder(r.filePaths[0]); else L.addPaths(r.filePaths);
      if (body.type === 'cacheDir') { /* unused */ }
      return ok({ paths: r.filePaths });
    }
    case '/api/pickCacheDir': {
      if (!isLocal(req)) return send(res, 403, { error: 'only on the PC itself' });
      const r = await hub.dialog.showOpenDialog(hub.ui?.controlWindow?.() || undefined, { title: 'Where should 3D copies be kept?', properties: ['openDirectory', 'createDirectory'] });
      if (!r.canceled) hub.config.update({ convert: { cacheDir: r.filePaths[0] } });
      return ok();
    }
    case '/api/calibration': {
      if (body.action === 'reload') hub.reloadCalibration();
      return ok();
    }
    case '/api/monitors': return send(res, 200, { monitors: await hub.power.monitors(), displays: require('electron').screen.getAllDisplays().map(hub.display.describe) });
    case '/api/sleepTest': {
      // show what a sleep mode looks like for 10 s, then come back
      const mode = body.mode;
      const cal = hub.getCalibration(); const W = cal?.raw?.screenW || 1440, H = cal?.raw?.screenH || 2560;
      if (mode === 'dim') {
        const b = await hub.power.getBrightness(W, H);
        if (b < 0) return send(res, 200, { ok: false, msg: 'The Go did not answer brightness control (DDC/CI). Use black or screen off instead.' });
        await hub.power.setBrightness(W, H, hub.config.get().sleep.dimLevel || 0);
        setTimeout(() => hub.power.setBrightness(W, H, b), 10000);
        return send(res, 200, { ok: true, msg: `Dimmed from ${b} for 10 seconds.` });
      }
      if (mode === 'monitorOff') { await hub.power.displaysOff(); setTimeout(() => hub.power.displaysWake(), 10000); return send(res, 200, { ok: true, msg: 'Screens off for 10 seconds. Watch whether the Go comes back by itself.' }); }
      return send(res, 200, { ok: true });
    }
    case '/api/blocker': {
      if (!hub.blocker) return send(res, 501, { error: 'not available' });
      if (req.method === 'GET') return send(res, 200, await hub.blocker.list(url.searchParams.get('type') || 'processes'));
      const r = await hub.blocker.set(body);
      broadcast();
      return send(res, 200, r);
    }
    case '/api/log': return send(res, 200, { lines: hub.log.recent() });
    case '/api/sync': {
      // What the phone player should have: every enabled, ready item, in loop order.
      const out = [];
      for (const it of hub.library.get().items) {
        if (!it.enabled || it.status !== 'ready') continue;
        // the small phone copy when there is one; waitCopy = one is being made, so don't fetch the big original
        const pf = hub.phonecopy.forPhone(it);
        const st = pf.st;
        if (!st) continue;
        out.push({ id: it.id, key: it.key, name: it.name, kind: it.kind === 'quilt' ? 'quilt' : 'rgbd', still: !!(it.still || it.meta?.still),
          cols: it.cols || null, rows: it.rows || null, aspect: it.aspect || null, depthLoc: it.meta?.depthLoc ?? 2,
          width: it.meta?.width || null, height: it.meta?.height || null,
          ...hub.library.view(it, it.meta?.framing && !it.meta.framing.failed ? it.meta.framing : null),
          file: path.basename(pf.file), size: st.size, mtime: Math.round(st.mtimeMs), duration: it.meta?.duration || null,
          waitCopy: pf.waiting, url: `/files/${it.id}` });
      }
      const cal = hub.getCalibration();
      return send(res, 200, { items: out, look: hub.config.get().look, serial: cal?.raw?.serial || null, calibration: cal?.raw || null });
    }
    case '/api/qr': {
      const addr = lanAddresses()[0]?.address;
      if (!addr) return send(res, 200, { svg: null });
      const QR = require('qrcode');
      const svg = await QR.toString(`http://${addr}:${boundPort}/`, { type: 'svg', margin: 1, color: { dark: '#e9ecf3', light: '#00000000' } });
      return send(res, 200, { svg, url: `http://${addr}:${boundPort}/` });
    }
    case '/api/elevate': {
      if (!isLocal(req)) return send(res, 403, { error: 'only on the PC itself' });
      hub.relaunchElevated?.();
      return ok();
    }
    default: return send(res, 404, { error: 'not found' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // stop other web pages in the PC's browser from driving the API
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'bad origin' });
  }
  if (url.pathname === '/api/hello') {
    // lets the phone find this PC on the Wi-Fi; says nothing private
    return send(res, 200, { app: 'hololoop', name: os.hostname(), version: hub.app.getVersion() }, undefined, { 'Access-Control-Allow-Origin': '*' });
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 60000) { a.n = 0; a.t = Date.now(); }
    if (++a.n > 6) { attempts.set(ip, a); return send(res, 429, { error: 'Too many tries. Wait a minute.' }); }
    attempts.set(ip, a);
    const body = await readBody(req).catch(() => ({}));
    if (String(body.pin || '').trim() === hub.config.get().remote.pin) {
      return send(res, 200, { ok: true, token: token() }, undefined, { 'Set-Cookie': `hl=${token()}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
    }
    return send(res, 401, { error: 'That PIN is not right.' });
  }
  if (url.pathname.startsWith('/files/')) {
    if (!authed(req)) return send(res, 401, { error: 'login' });
    const it = hub.library.find(url.pathname.slice(7));
    if (!it || it.status !== 'ready') return send(res, 404, { error: 'not found' });
    return streamFile(req, res, hub.phonecopy.fileFor(it, url.searchParams.get('file')));
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/thumb/')) {
    if (!authed(req)) return send(res, 401, { error: 'login' });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state(req))}\n\n`);
      const c = { req, res }; clients.add(c);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clients.delete(c); clearInterval(ping); });
      return;
    }
    if (url.pathname.startsWith('/thumb/')) {
      const it = hub.library.find(url.pathname.slice(7));
      if (!it) return send(res, 404, '');
      const f = await makeThumb(it);
      if (!f) return send(res, 404, '');
      return send(res, 200, fs.readFileSync(f), 'image/jpeg', { 'Cache-Control': 'max-age=86400' });
    }
    try { return await api(req, res, url); } catch (e) { hub.log.warn('api ' + url.pathname + ': ' + e.stack); return send(res, 500, { error: e.message }); }
  }
  // static UI
  let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(UI_DIR, path.normalize(rel));
  if (!file.startsWith(UI_DIR)) return send(res, 403, '');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
}

// Plain file download with Range support, so the phone can resume big files.
function streamFile(req, res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'gone' }); }
  const type = /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'video/mp4';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = st.size - 1, code = 200;
  if (m) {
    start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    code = 206;
  }
  const headers = { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

function listen() {
  const c = hub.config.get().remote;
  const host = c.enabled ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve) => {
    const tryPort = (port, left) => {
      server = http.createServer((req, res) => { handle(req, res).catch((e) => { try { send(res, 500, { error: e.message }); } catch {} }); });
      server.on('error', (e) => {
        if (e.code === 'EADDRINUSE' && left > 0) tryPort(port + 1, left - 1);
        else { hub.log.error('web server: ' + e.message); resolve(null); }
      });
      server.listen(port, host, () => { boundPort = port; hub.log.info(`web ui on http://${host === '0.0.0.0' ? (lanAddresses()[0]?.address || 'localhost') : '127.0.0.1'}:${port}/`); resolve(port); });
    };
    tryPort(c.port || 8787, 5);
  });
}

async function restart() {
  for (const c of clients) { try { c.res.end(); } catch {} }
  clients.clear();
  await new Promise((r) => server ? server.close(() => r()) : r());
  await listen();
  hub.firewall?.();
}

async function init(h) {
  hub = h;
  hub.emit = broadcast;
  hub.port = () => boundPort;
  hub.lanAddresses = lanAddresses;
  hub.library.onChange(broadcast);
  hub.playback.onState(broadcast);
  hub.converter.onStatus(broadcast);
  hub.phonecopy.onStatus(broadcast);
  hub.config.onChange(broadcast);
  await listen();
  setInterval(broadcast, 5000);
}

module.exports = { init };
