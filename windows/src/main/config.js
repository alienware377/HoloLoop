'use strict';
const crypto = require('crypto');
const { P, writeJson, readJson } = require('./paths');

function defaults() {
  return {
    version: 1,
    playlist: { order: 'inOrder', resumeLongVideos: true, resumeMinMinutes: 10, transitionSec: 0.6 },
    look: { depthiness: 0.32, focus: 0.5, fit: 'fit', zoom: 1, iterations: 14, filterEdge: true, depthInvert: false, edgeFix: 2, steady: 1, steadyMove: 1 },   // edgeFix 2 = clean + fill gaps (0 = the original look)
    audio: { volume: 0.8, muted: false },
    phone: { compress: false, mbps: 4 },      // smaller copies for the phone, Mbit/s
    convert: { enabled: true, when: 'anytime', maxLong: 1280, depthLong: 518, backend: 'auto', cacheDir: P.defaultCache },
    sleep: {
      enabled: false,
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '08:00' }],
      mode: 'black',             // black | monitorOff | dim
      dimLevel: 0,               // DDC/CI brightness while asleep, if the Go supports it
      convertWhileAsleep: true,
      wakeOnInput: true,
    },
    display: { goDisplayId: null, alwaysOnTop: true },
    remote: { enabled: true, port: 8787, pin: String(crypto.randomInt(100000, 999999)), secret: crypto.randomBytes(18).toString('hex') },
    startup: { withWindows: false, openControlWindow: true },
    blocker: { enabled: false, intervalSec: 20 },
    ui: { goMenuTimeoutSec: 20 },
  };
}

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = (k in base) ? merge(base[k], over[k]) : over[k];
  return out;
}

let cfg = null;
const listeners = new Set();

function load() { cfg = merge(defaults(), readJson(P.config, {}, (m) => require('./log').warn(m))); writeJson(P.config, cfg); return cfg; }
function get() { return cfg || load(); }
function save() { writeJson(P.config, cfg); for (const l of listeners) { try { l(cfg); } catch {} } }

// patch: deep partial object, e.g. { sleep: { enabled: true } }
function update(patch) { cfg = merge(get(), patch); save(); return cfg; }
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

module.exports = { load, get, update, save, onChange, defaults };
