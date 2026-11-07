'use strict';
// The desktop control window: the same web UI the phones use, in a normal window.
const { BrowserWindow, shell } = require('electron');
const path = require('path');

let hub = null, win = null;

function openControl() {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  const port = hub.port?.();
  if (!port) return;
  win = new BrowserWindow({
    width: 1080, height: 760, minWidth: 380, minHeight: 520, backgroundColor: '#101219', title: 'HoloLoop',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'), autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) e.preventDefault(); });
  win.on('closed', () => { win = null; });
}

async function init(h) {
  hub = h;
  hub.openControl = openControl;
  hub.ui = { controlWindow: () => (win && !win.isDestroyed() ? win : null) };
  const hidden = process.argv.includes('--tray');
  if (!hidden && (hub.config.get().startup.openControlWindow || hub.DEV)) openControl();
}

module.exports = { init };
