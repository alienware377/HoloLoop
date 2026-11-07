'use strict';
// Finds the Looking Glass Go among Windows' displays: the one whose real pixel
// size matches the calibration (1440x2560 for the Go).
const { screen } = require('electron');

function physical(d) {
  return { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) };
}

function describe(d) {
  const p = physical(d);
  return { id: d.id, label: d.label || '', w: p.w, h: p.h, scale: d.scaleFactor, rotation: d.rotation, bounds: d.bounds, primary: d.id === screen.getPrimaryDisplay().id };
}

function findGo(cal, preferredId) {
  const all = screen.getAllDisplays();
  if (preferredId != null) {
    const pick = all.find((d) => String(d.id) === String(preferredId));
    if (pick) return { display: pick, how: 'chosen' };
  }
  const W = cal?.raw?.screenW || 1440, H = cal?.raw?.screenH || 2560;
  const exact = all.find((d) => { const p = physical(d); return p.w === W && p.h === H; });
  if (exact) return { display: exact, how: 'match' };
  const rotated = all.find((d) => { const p = physical(d); return p.w === H && p.h === W; });
  if (rotated) return { display: rotated, how: 'rotated' };   // Windows has it in landscape
  const label = all.find((d) => /looking ?glass|lkg/i.test(d.label || ''));
  if (label) return { display: label, how: 'label' };
  return null;
}

module.exports = { findGo, describe, physical };
