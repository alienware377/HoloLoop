'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const DEV = process.argv.includes('--dev');
if (DEV) process.env.HOLOLOOP_DEV = '1';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// dev: --go-frame renders the player off screen at the Go's exact 1440x2560 pixels
const GO_FRAME = process.argv.includes('--go-frame');
if (GO_FRAME) app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// a test copy with its own data folder may run next to the installed app
if (process.env.HOLOLOOP_DATA) app.setPath('userData', path.join(process.env.HOLOLOOP_DATA, 'electron-userdata'));
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const { P, ensureDirs } = require('./paths');
ensureDirs();
const log = require('./log');
const config = require('./config');
const library = require('./library');
const calibration = require('./calibration');
const display = require('./display');
const playback = require('./playback');
const schedule = require('./schedule');
const converter = require('./converter');
const phonecopy = require('./phonecopy');
const power = require('./power');

const BUILD = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build-info.json'), 'utf8')); } catch { return { stamp: 'dev' }; } })();

let playerWin = null, playerReady = false, tray = null;
let cal = null, goInfo = null;
const hub = { BUILD, DEV };          // shared with server.js / ui.js
module.exports = hub;

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

// ------------------------------------------------------------------ player window
function sendPlayer(ch, data) { if (playerWin && !playerWin.isDestroyed() && playerReady) playerWin.webContents.send(ch, data); }

function pushCalibration() {
  if (!cal) return;
  sendPlayer('player:calibration', cal.derived);
}

function placePlayer() {
  if (GO_FRAME) { cal = calibration.load() || cal; return; }
  cal = calibration.load() || cal;
  const found = display.findGo(cal, config.get().display.goDisplayId);
  goInfo = found ? { ...display.describe(found.display), how: found.how } : null;
  if (!playerWin) return;
  if (found && !DEV) {
    const b = found.display.bounds;
    playerWin.setBounds(b);
    playerWin.setFullScreen(true);
    if (config.get().display.alwaysOnTop) playerWin.setAlwaysOnTop(true, 'screen-saver');
    playerWin.showInactive();
  } else if (DEV) {
    playerWin.setFullScreen(false);
    playerWin.setBounds({ x: 60, y: 60, width: 405, height: 720 });
    playerWin.show();
  } else {
    playerWin.hide();                 // no Go connected: nothing to draw on
  }
  playback.setActive(!!found || DEV);
  if (found && found.how === 'rotated') log.warn('The Go is set to landscape in Windows display settings; set it to portrait.');
  log.info(`display: ${goInfo ? `${goInfo.w}x${goInfo.h} @${goInfo.scale} (${goInfo.how})` : 'Go not found'}`);
  hub.emit?.('status');
}

function createPlayer() {
  playerWin = new BrowserWindow({
    show: false, frame: false, backgroundColor: '#000000', skipTaskbar: !DEV, resizable: DEV, fullscreenable: true,
    title: 'HoloLoop Player', autoHideMenuBar: true, focusable: true,
    ...(GO_FRAME ? { width: 1440, height: 2560, useContentSize: true, enableLargerThanScreen: true } : {}),
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'player.js'), backgroundThrottling: false, contextIsolation: true, sandbox: false,
      ...(GO_FRAME ? { offscreen: true } : {}) },
  });
  if (GO_FRAME) playerWin.webContents.setFrameRate(30);
  playerWin.loadFile(path.join(__dirname, '..', 'player', 'index.html'));
  playerWin.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 2 || DEV) log[level >= 3 ? 'error' : level === 2 ? 'warn' : 'info'](`[player] ${message} (${path.basename(src || '')}:${line})`);
  });
  playerWin.webContents.on('render-process-gone', (_e, d) => {
    log.error('player renderer gone: ' + d.reason);
    playerReady = false;
    setTimeout(() => { try { playerWin.destroy(); } catch {} playerWin = null; createPlayer(); }, 2000);
  });
  playerWin.on('closed', () => { playerWin = null; playerReady = false; });
  placePlayer();
}

ipcMain.on('player:ready', (e, d) => {
  if (!playerWin || e.sender !== playerWin.webContents) return;
  playerReady = true;
  log.info(`player ready ${d.w}x${d.h} dpr ${d.dpr}`);
  pushCalibration();
  sendPlayer('player:look', config.get().look);
  const dv = arg('--debug-view');
  if (dv != null) sendPlayer('player:debug', { on: true, value: Number(dv) });
  if (GO_FRAME) sendPlayer('player:debug', { size: [cal?.screenW || 1440, cal?.screenH || 2560] });
  if (arg('--look')) sendPlayer('player:look', JSON.parse(arg('--look')));
  const testFile = arg('--play');
  if (testFile) {
    const c = library.classify(testFile) || { kind: 'rgbd' };
    const { pathToFileURL } = require('url');
    sendPlayer('player:load', { url: pathToFileURL(path.resolve(testFile)).href, kind: c.kind === 'quilt' ? 'quilt' : 'rgbd', still: !!c.still,
      cols: c.cols, rows: c.rows, aspect: c.aspect, depthLoc: 2, loop: true, look: Object.assign({}, config.get().look, arg('--look') ? JSON.parse(arg('--look')) : {}),
      volume: 0, startAt: Number(arg('--seek') || 0), ...testFraming(testFile) });
    return;
  }
  if (schedule.asleep()) playback.setAsleep(true); else playback.next();
});

// dev: a test file's sidecar framing, shown with --frame <auto|fit|turnfit|fill|rotate>
function testFraming(f) {
  let framing = null;
  try { framing = JSON.parse(fs.readFileSync(f + '.json', 'utf8')).framing || null; } catch {}
  return framing || arg('--frame') ? { framing, frame: arg('--frame') || 'auto' } : {};
}

// dev: --snap out.png grabs the player canvas after a few seconds and quits
if (arg('--snap')) {
  app.whenReady().then(() => setTimeout(async () => {
    if (GO_FRAME) {   // same frame every run: pause, seek to the exact time, then grab
      sendPlayer('player:pause'); grabNext(); return;
    }
    try { const img = await playerWin.webContents.capturePage(); fs.writeFileSync(arg('--snap'), img.toPNG()); } catch (e) { console.error(e); }
    hub.quitting = true; app.quit();
  }, Number(arg('--snap-after') || 4000)));
  // the exact Go frame: GL rows come bottom first and RGBA; PNG wants top first and BGRA
  // --grab-frames N: N frames in a row (1/30 s apart), saved as <snap>_0.png, _1.png, ...
  let grabbed = 0;
  const grabN = Number(arg('--grab-frames') || 0);
  const grabT0 = Number(arg('--grab-at') || Number(arg('--seek') || 0) + 5);
  function grabNext() {
    const t = grabT0 + grabbed / 30 + 0.005;
    if (grabbed) sendPlayer('player:debug', { stepTo: t }); else sendPlayer('player:seek', t);
    setTimeout(() => sendPlayer('player:debug', { grab: true }), 1200);
  }
  ipcMain.on('player:grab', (_e, d) => {
    const { nativeImage } = require('electron');
    const src = Buffer.from(d.px.buffer, d.px.byteOffset, d.px.byteLength), out = Buffer.alloc(src.length), row = d.w * 4;
    for (let y = 0; y < d.h; y++) {
      const a = (d.h - 1 - y) * row, b = y * row;
      for (let x = 0; x < row; x += 4) { out[b + x] = src[a + x + 2]; out[b + x + 1] = src[a + x + 1]; out[b + x + 2] = src[a + x]; out[b + x + 3] = 255; }
    }
    const file = grabN ? arg('--snap').replace(/\.png$/i, `_${grabbed}.png`) : arg('--snap');
    fs.writeFileSync(file, nativeImage.createFromBitmap(out, { width: d.w, height: d.h }).toPNG());
    log.info(`grabbed ${d.w}x${d.h} at ${d.t.toFixed(3)} s`);
    if (++grabbed < grabN) { grabNext(); return; }
    hub.quitting = true; app.quit();
  });
}
ipcMain.on('player:started', (_e, d) => playback.onStarted(d));
ipcMain.on('player:ended', () => { if (!arg('--play')) playback.onEnded(); });
ipcMain.on('player:error', (_e, d) => { log.warn('player: ' + JSON.stringify(d)); if (!arg('--play')) playback.onError(d); });
ipcMain.on('player:stalled', (_e, d) => playback.onStalled(d));
ipcMain.on('player:progress', (_e, d) => playback.onProgress(d));
ipcMain.on('player:input', (_e, d) => hub.onPlayerInput?.(d));

// ------------------------------------------------------------------ sleep
let lastAsleep = null, savedBrightness = null;
async function applySleep() {
  const asleep = schedule.asleep();
  if (asleep === lastAsleep) return;
  lastAsleep = asleep;
  const s = config.get().sleep;
  log.info(asleep ? 'going to sleep' : 'waking up');
  playback.setAsleep(asleep);
  power.keep(asleep ? 'system' : 'display');
  const W = cal?.raw?.screenW || 1440, H = cal?.raw?.screenH || 2560;
  if (asleep) {
    if (s.mode === 'dim') {
      const b = await power.getBrightness(W, H);
      if (b >= 0) { savedBrightness = b; await power.setBrightness(W, H, s.dimLevel || 0); }
      else log.warn('the Go does not answer brightness control; showing black instead');
    } else if (s.mode === 'monitorOff') {
      setTimeout(() => power.displaysOff(), 1500);   // after the fade to black
    }
  } else {
    if (savedBrightness != null) { await power.setBrightness(W, H, savedBrightness); savedBrightness = null; }
    if (s.mode === 'monitorOff') await power.displaysWake();
    setTimeout(placePlayer, 1500);                   // the display may have re-enumerated
  }
  converter.tick();
  hub.emit?.('status');
}
hub.applySleep = applySleep;

function convertAllowed() {
  const c = config.get().convert;
  if (c.when === 'asleep') return schedule.asleep();
  return true;
}

// ------------------------------------------------------------------ tray
function trayIcon() {
  const f = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  return fs.existsSync(f) ? nativeImage.createFromPath(f).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
}
function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('HoloLoop');
  const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open HoloLoop', click: () => hub.openControl?.() },
    { type: 'separator' },
    { label: 'Next video', click: () => playback.next() },
    schedule.asleep() ? { label: 'Wake up now', click: () => { schedule.wakeNow(); applySleep(); refresh(); } }
      : { label: 'Sleep now', click: () => { schedule.sleepNow(); applySleep(); refresh(); } },
    { type: 'separator' },
    { label: 'Quit HoloLoop', click: () => { hub.quitting = true; app.quit(); } },
  ]));
  refresh();
  tray.on('click', () => hub.openControl?.());
  hub.refreshTray = refresh;
}

// ------------------------------------------------------------------ boot
app.whenReady().then(async () => {
  log.prune();
  log.info(`HoloLoop ${app.getVersion()} build ${BUILD.stamp} starting${DEV ? ' (dev)' : ''}; data ${P.root}`);
  config.load(); library.load(); library.rescan();
  cal = calibration.load();
  log.info(cal ? `calibration ${cal.raw.serial} from ${cal.source}${cal.live ? '' : ' (cached)'}` : 'no calibration yet: plug the Go in over USB once');

  playback.attach(sendPlayer);
  library.onChange(() => playback.onLibrary());
  createPlayer();
  power.keep('display');

  screen.on('display-added', () => setTimeout(placePlayer, 1500));
  screen.on('display-removed', () => setTimeout(placePlayer, 1500));
  screen.on('display-metrics-changed', () => setTimeout(placePlayer, 800));
  config.onChange(() => { sendPlayer('player:look', config.get().look); });

  converter.start(convertAllowed);
  phonecopy.start(convertAllowed);
  setInterval(applySleep, 15000); applySleep();
  setInterval(() => library.rescan(), 5 * 60 * 1000);
  setInterval(() => { const c = calibration.load(); if (c && (!cal || c.raw.serial !== cal.raw.serial || c.live !== cal.live)) { cal = c; pushCalibration(); } }, 60000);

  for (const mod of ['server', 'ui', 'blocker', 'startup']) {
    if (!fs.existsSync(path.join(__dirname, mod + '.js'))) continue;
    try { await require('./' + mod).init?.(hub); } catch (e) { log.error(`${mod}: ${e.stack}`); }
  }
  buildTray();
});

app.on('second-instance', () => hub.openControl?.());
app.on('window-all-closed', (e) => { /* keep running in the tray */ });

// shared API for server/ui
Object.assign(hub, {
  config, library, playback, schedule, converter, phonecopy, power, calibration, display, log,
  getCalibration: () => cal,
  getGo: () => goInfo,
  sendPlayer, placePlayer, pushCalibration,
  reloadCalibration: () => { cal = calibration.load() || cal; pushCalibration(); placePlayer(); return cal; },
  importCalibration: (f) => { cal = calibration.importFile(f); pushCalibration(); placePlayer(); return cal; },
  playerWindow: () => playerWin,
  dialog, shell, app,
});
