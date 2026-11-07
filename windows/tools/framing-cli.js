const { analyze } = require('../src/convert/framing');
(async () => {
  for (const f of process.argv.slice(2)) {
    const t0 = Date.now();
    const r = await analyze(f, { rgbd: true });
    console.log(f.split(/[\/]/).pop(), ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify({ content: r.content, aspect: r.aspect, minW: r.minW, summary: r.summary, keys: r.keys.length, first: r.keys.slice(0, 6) }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
