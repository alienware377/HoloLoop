'use strict';
// Looking Glass calibration: read visual.json off the Go's USB drive (it shows up
// as a drive labelled LKG-xxxxxx), cache it, and work out the shader uniforms.
const fs = require('fs');
const path = require('path');
const { P, writeJson, readJson } = require('./paths');

function num(v, d = 0) {
  if (v && typeof v === 'object' && 'value' in v) v = v.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function parse(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    serial: String(j.serial?.value ?? j.serial ?? ''),
    pitch: num(j.pitch), slope: num(j.slope), center: num(j.center),
    fringe: num(j.fringe), viewCone: num(j.viewCone, 40),
    invView: !!num(j.invView), verticalAngle: num(j.verticalAngle),
    dpi: num(j.DPI ?? j.dpi, 324),
    screenW: num(j.screenW, 1440), screenH: num(j.screenH, 2560),
    flipImageX: !!num(j.flipImageX), flipImageY: !!num(j.flipImageY), flipSubp: !!num(j.flipSubp),
    cellPatternMode: num(j.CellPatternMode ?? j.cellPatternMode, 0),
  };
}

function derive(c) {
  const flip = c.flipImageX ? -1 : 1;
  return {
    serial: c.serial,
    screenW: c.screenW, screenH: c.screenH,
    pitch: c.pitch * (c.screenW / c.dpi) * Math.cos(Math.atan(1 / c.slope)),
    slope: (c.screenH / (c.screenW * c.slope)) * flip,
    center: c.center,
    subpixelSize: (1 / (3 * c.screenW)) * flip,
    invView: c.invView,
    viewCone: c.viewCone,
  };
}

// Look for visual.json on every drive letter. The Go's drive is small and
// removable; checking a letter with no media just fails fast.
function findOnDrives() {
  const hits = [];
  for (let i = 67; i <= 90; i++) {           // C..Z
    const L = String.fromCharCode(i) + ':\\';
    for (const rel of ['LKG_calibration\\visual.json', 'visual.json']) {
      const f = path.join(L, rel);
      try { if (fs.statSync(f).isFile()) hits.push(f); } catch {}
    }
  }
  return hits;
}

function load() {
  for (const f of findOnDrives()) {
    try {
      const raw = parse(fs.readFileSync(f, 'utf8'));
      if (raw.pitch && raw.slope) {
        writeJson(P.calibration, { source: f, readAt: new Date().toISOString(), raw });
        return { raw, derived: derive(raw), source: f, live: true };
      }
    } catch {}
  }
  const cached = readJson(P.calibration, null);
  if (cached?.raw) return { raw: cached.raw, derived: derive(cached.raw), source: cached.source, live: false };
  return null;
}

function importFile(file) {
  const raw = parse(fs.readFileSync(file, 'utf8'));
  writeJson(P.calibration, { source: file, readAt: new Date().toISOString(), raw });
  return { raw, derived: derive(raw), source: file, live: false };
}

module.exports = { load, importFile, parse, derive };
