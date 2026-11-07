'use strict';
// Everything lives under ProgramData, not AppData: the app runs elevated at logon
// (Task Scheduler), and ProgramData is the one place the elevated app, a normal
// launch and the converter worker all see the same files.
const path = require('path');
const fs = require('fs');

const ROOT = process.env.HOLOLOOP_DATA || path.join(process.env.ProgramData || 'C:\\ProgramData', 'HoloLoop');

const P = {
  root: ROOT,
  config: path.join(ROOT, 'config.json'),
  library: path.join(ROOT, 'library.json'),
  calibration: path.join(ROOT, 'calibration.json'),
  blocker: path.join(ROOT, 'blocker.json'),
  logs: path.join(ROOT, 'logs'),
  defaultCache: path.join(ROOT, 'cache'),
};

function ensureDirs() {
  const fresh = !fs.existsSync(P.root);
  for (const d of [P.root, P.logs, P.defaultCache]) fs.mkdirSync(d, { recursive: true });
  // The elevated (autostart) copy and a normal launch must both be able to write
  // here, so give the local Users group modify rights once.
  const mark = path.join(P.root, '.acl');
  if (fresh || !fs.existsSync(mark)) {
    try {
      require('child_process').execFileSync('icacls', [P.root, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/T', '/C', '/Q'], { windowsHide: true, stdio: 'ignore' });
      fs.writeFileSync(mark, new Date().toISOString());
    } catch {}
  }
}

// Safe JSON write. After a hard crash, files written shortly before can come back
// full of zeros, the file AND its .bak, which would reset every setting and empty
// the library. So: flush to disk before the rename, only keep a .bak of a
// file that still reads fine, and keep one snapshot per day for a week in snapshots/,
// which a crash right after a save cannot touch.
const SNAP_DAYS = 7;
function writeJson(file, obj) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = file + '.tmp';
  writeSynced(tmp, data);
  if (fs.existsSync(file) && parses(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch {} }
  fs.renameSync(tmp, file);
  if (!parses(file + '.bak')) { try { fs.copyFileSync(file, file + '.bak'); } catch {} }   // never leave a broken .bak
  try { snapshot(file, data); } catch {}
}

function writeSynced(file, data) {
  const fd = fs.openSync(file, 'w');
  try { fs.writeSync(fd, data, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function parses(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); return true; } catch { return false; }
}

function snapDir(file) { return path.join(path.dirname(file), 'snapshots'); }
function snapsOf(file) {
  const base = path.basename(file, '.json') + '.';
  try {
    return fs.readdirSync(snapDir(file)).filter((n) => n.startsWith(base) && /\.\d{4}-\d\d-\d\d\.json$/.test(n)).sort().reverse()
      .map((n) => path.join(snapDir(file), n));
  } catch { return []; }
}

// once a day: snapshots/<name>.YYYY-MM-DD.json, the newest week kept
function snapshot(file, data) {
  const day = new Date().toISOString().slice(0, 10);
  const snap = path.join(snapDir(file), `${path.basename(file, '.json')}.${day}.json`);
  if (fs.existsSync(snap) && parses(snap)) return;
  fs.mkdirSync(snapDir(file), { recursive: true });
  writeSynced(snap, data);
  for (const old of snapsOf(file).slice(SNAP_DAYS)) { try { fs.unlinkSync(old); } catch {} }
}

// The file, else its .bak, else the newest daily snapshot that still reads.
// note(msg) hears about it when the file itself was unreadable.
function readJson(file, fallback, note) {
  const exists = fs.existsSync(file);
  for (const f of [file, file + '.bak', ...snapsOf(file)]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (f !== file && exists && note) note(`${path.basename(file)} was unreadable (crash?), restored from ${path.relative(path.dirname(file), f)}`);
      return v;
    } catch {}
  }
  if (exists && note) note(`${path.basename(file)} was unreadable and no backup reads; starting fresh`);
  return fallback;
}

module.exports = { P, ensureDirs, writeJson, readJson };
