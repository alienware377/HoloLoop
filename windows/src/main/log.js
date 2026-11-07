'use strict';
// Small rolling log in ProgramData\HoloLoop\logs (one file per day, 14 kept).
const fs = require('fs');
const path = require('path');
const { P } = require('./paths');

const recent = [];
function file() { return path.join(P.logs, `hololoop-${new Date().toISOString().slice(0, 10)}.log`); }
function write(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  recent.push(line); if (recent.length > 400) recent.shift();
  try { fs.appendFileSync(file(), line + '\r\n'); } catch {}
  if (process.env.HOLOLOOP_DEV) console.log(line);
}
function prune() {
  try {
    const fsn = fs.readdirSync(P.logs).filter((f) => f.startsWith('hololoop-')).sort();
    for (const f of fsn.slice(0, Math.max(0, fsn.length - 14))) fs.unlinkSync(path.join(P.logs, f));
  } catch {}
}
module.exports = { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m), recent: () => recent.slice(), prune };
