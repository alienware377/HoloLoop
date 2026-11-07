'use strict';
// Keeps the PC awake (so its USB-C port never cuts the Go's power), and handles
// the sleep look: black picture, displays signal off, or Go dimmed over DDC/CI.
const path = require('path');
const { execFile } = require('child_process');
const { powerSaveBlocker } = require('electron');
const log = require('./log');

const SCRIPT = path.join(__dirname, 'win', 'display-power.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function ps(args) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args.map(String)],
      { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
        if (err) { log.warn('display-power ' + args[0] + ': ' + (stderr || err.message)); resolve(null); }
        else resolve(String(stdout).trim());
      });
  });
}

let blocker = null, blockerType = null;
function keep(type) {           // 'display' while playing, 'system' while asleep
  const want = type === 'display' ? 'prevent-display-sleep' : 'prevent-app-suspension';
  if (blockerType === want && blocker != null && powerSaveBlocker.isStarted(blocker)) return;
  if (blocker != null) { try { powerSaveBlocker.stop(blocker); } catch {} }
  blocker = powerSaveBlocker.start(want); blockerType = want;
}

async function monitors() { try { return JSON.parse(await ps(['list']) || '[]'); } catch { return []; } }
async function getBrightness(w, h) { const r = Number(await ps(['get', w, h])); return Number.isFinite(r) ? r : -2; }
async function setBrightness(w, h, v) { const r = Number(await ps(['set', w, h, Math.round(v)])); return Number.isFinite(r) ? r : -2; }
async function displaysOff() { return ps(['off']); }
async function displaysWake() { return ps(['wake']); }

module.exports = { keep, monitors, getBrightness, setBrightness, displaysOff, displaysWake };
