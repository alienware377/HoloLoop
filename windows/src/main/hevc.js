'use strict';
// Can this PC's player show HEVC video? Chromium decodes HEVC only on the graphics card, so
// on older cards a 3D copy made straight at the phone's size (HEVC) would not play here.
// Asked once, in a hidden window; until the answer is in, plays() is null.
const { BrowserWindow } = require('electron');
const log = require('./log');

const CODEC = 'hvc1.1.6.L120.90';       // HEVC Main, level 4, as the phone copies are made
let answer = null, asking = null;

const QUESTION = `(async () => {
  try {
    if (window.VideoDecoder) {
      const r = await VideoDecoder.isConfigSupported({ codec: '${CODEC}', codedWidth: 2560, codedHeight: 720 });
      if (r && r.supported) return true;
    }
  } catch {}
  try { return MediaSource.isTypeSupported('video/mp4; codecs="${CODEC}"'); } catch { return false; }
})()`;

function ask() {
  if (asking) return asking;
  asking = (async () => {
    let win = null;
    try {
      win = new BrowserWindow({ show: false, skipTaskbar: true, width: 64, height: 64, webPreferences: { backgroundThrottling: false } });
      await win.loadURL('data:text/html,<meta charset="utf-8">');
      answer = !!(await Promise.race([win.webContents.executeJavaScript(QUESTION), new Promise((r) => setTimeout(() => r(false), 10000))]));
    } catch (e) { answer = false; log.warn(`HEVC check failed: ${e.message}`); }
    finally { try { if (win && !win.isDestroyed()) win.destroy(); } catch {} }
    log.info(`HEVC playback on this PC: ${answer ? 'yes' : 'no'}`);
    return answer;
  })();
  return asking;
}

module.exports = { ask, plays: () => answer };
