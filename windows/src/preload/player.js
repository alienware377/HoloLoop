'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const IN = new Set(['player:calibration', 'player:look', 'player:debug', 'player:load', 'player:black',
  'player:pause', 'player:resume', 'player:seek', 'player:volume', 'player:ui']);
const OUT = new Set(['player:ready', 'player:started', 'player:ended', 'player:error', 'player:stalled',
  'player:progress', 'player:blacked', 'player:input', 'player:grab']);

contextBridge.exposeInMainWorld('holo', {
  on: (ch, cb) => { if (IN.has(ch)) ipcRenderer.on(ch, (_e, d) => cb(d)); },
  send: (ch, d) => { if (OUT.has(ch)) ipcRenderer.send(ch, d); },
});
