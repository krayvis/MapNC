// Live check of the NRCan elevation service (network needed, not part of the suite): values, timing, and whether the
// returned raster sits where the request said. Runs in a page because geotiff.js needs a browser.
const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const srv = http.createServer((q, r) => {
  const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r.end(d); } });
}).listen(8147, async () => {
  const br = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await br.newContext({ ignoreHTTPSErrors: true });
  await ctx.route(/openstreetmap|arcgisonline|opentopomap|basemap.nationalmap/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto('http://localhost:8147/?sample=off');
  const out = await page.evaluate(async () => {
    const G = window.MapNCGeo, S = window.MapNCSources, res = {};
    // 1. a city region and a remote one, at the automatic resolution
    for (const [name, b] of [['Ottawa', { west: -75.74, east: -75.66, south: 45.38, north: 45.44 }], ['NW Ontario', { west: -90.05, east: -89.95, south: 51.0, north: 51.06 }]]) {
      const plan = G.planSource(b, 'auto', { mode: 'auto' });
      const t = performance.now();
      try { const r = await S.fetchElevation(b, 'auto', {}); res[name] = { id: plan.id, grid: plan.grid.width + 'x' + plan.grid.height, ms: Math.round(performance.now() - t), min: r.min, max: r.max, nodata: r.nodata, note: r.note }; }
      catch (e) { res[name] = { id: plan.id, fail: e.message.slice(0, 300) }; }
    }
    // 2. placement: a small box and a bigger box that contains it must agree where they overlap
    const big = { west: -75.74, east: -75.66, south: 45.38, north: 45.44 }, small = { west: -75.71, east: -75.69, south: 45.40, north: 45.42 };
    const spec = { mode: 'mpp', value: 5 };
    const A = await S.fetchElevation(Object.assign({}, big), 'canada', { spec }), B = await S.fetchElevation(Object.assign({}, small), 'canada', { spec });
    const at = (r, b, lon, lat) => { const x = Math.floor((lon - b.west) / (b.east - b.west) * r.width), y = Math.floor((b.north - lat) / (b.north - b.south) * r.height); return r.data[y * r.width + x]; };
    const diffs = [];
    for (const [sx, sy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {         // shifting the small grid by whole pixels worsens the match if it is aligned
      const dLon = (small.east - small.west) / B.width, dLat = (small.north - small.south) / B.height;
      let acc = 0, n = 0;
      for (let j = 10; j < B.height - 10; j += 3) for (let i = 10; i < B.width - 10; i += 3) {
        const lon = small.west + (i + 0.5 + sx) * dLon, lat = small.north - (j + 0.5 + sy) * dLat;
        const a = at(A, big, lon, lat), b = B.data[j * B.width + i];
        if (a === a && b === b) { acc += Math.abs(a - b); n++; }
      }
      diffs.push({ shift: sx + ',' + sy, meanAbsDiff: +(acc / n).toFixed(3) });
    }
    res.placement = diffs; res.pixel = { big: A.width + 'x' + A.height, small: B.width + 'x' + B.height };
    return res;
  });
  console.log(JSON.stringify(out, null, 1));
  await br.close(); srv.close();
});
