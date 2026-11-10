const path = require('path');
const { convert } = require('../src/convert/convert');
const [src, out, chunk] = process.argv.slice(2);
const t0 = Date.now(); let lastLog = 0;
convert({ src, outFile: out, workDir: out + '.work', settings: { chunkSec: Number(chunk) || 60, lanes: Number(process.env.HL_LANES) || undefined, batch: Number(process.env.HL_BATCH) || undefined, model: process.env.HL_MODEL || undefined } }, {
  onProgress: (p) => { const n = Date.now(); if (n - lastLog > 1000 || p.stage !== 'depth') { lastLog = n; console.log(p.stage, p.done.toFixed(1) + '/' + p.total.toFixed(1), 'speed', p.speed.toFixed(2) + 'x', p.backend, p.encoder); } },
}).then((m) => console.log('OK', ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(m))).catch((e) => { console.error('FAIL', e.stack || e); process.exit(1); });
