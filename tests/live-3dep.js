const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const srv = http.createServer((q, r) => {
  const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r.end(d); } });
}).listen(8144, async () => {
  const br = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await br.newContext({ ignoreHTTPSErrors: true });
  await ctx.route(/openstreetmap|arcgisonline|opentopomap|basemap.nationalmap/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('http://localhost:8144/?sample=off');
  const out = await page.evaluate(async () => {
    const b = { west: -120.655, east: -120.615, south: 39.575, north: 39.60 };
    const G = window.MapNCGeo, S = window.MapNCSources, res = [];
    for (const spec of [{ mode: 'auto' }, { mode: 'pixels', value: 2048 }, { mode: 'mpp', value: 2 }]) {
      const plan = G.planSource(b, '3dep', spec);
      const t = performance.now();
      try {
        const r = await S.fetch3dep(b, plan, {});
        const st = S.stats(r.data);
        res.push({ spec, grid: plan.grid, interp: plan.interpolation, chunks: S.depChunks(plan.grid).length, ms: Math.round(performance.now() - t), min: st.min, max: st.max, nodata: st.nodata, n: r.data.length });
      } catch (e) { res.push({ spec, grid: plan.grid, fail: e.message.slice(0, 300) }); }
    }
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await br.close(); srv.close();
});
