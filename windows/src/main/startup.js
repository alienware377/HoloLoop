'use strict';
// "Open with Windows": the per-user Run key (no admin needed), started in the tray.
const { app } = require('electron');

let hub = null;

function opts() {
  // In dev, electron.exe needs the app folder as its first argument.
  const args = app.isPackaged ? ['--tray'] : [app.getAppPath(), '--tray'];
  return { path: process.execPath, args };
}

function status() {
  const o = opts();
  const s = app.getLoginItemSettings(o);
  return { enabled: !!s.openAtLogin };
}

async function apply() {
  const want = !!hub.config.get().startup.withWindows;
  const o = opts();
  app.setLoginItemSettings({ openAtLogin: want, path: o.path, args: o.args, name: 'HoloLoop' });
  hub.log.info(`open with Windows: ${want ? 'on' : 'off'}`);
}

async function init(h) {
  hub = h;
  hub.startup = { status, apply };
  // keep the setting and Windows in agreement (e.g. after the app moved)
  if (hub.config.get().startup.withWindows) await apply();
}

module.exports = { init };
