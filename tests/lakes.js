// Lake flattening: the polygon fill and the flatten/revert rules (pure), then the checkbox in a real browser.
global.self = global;
const L = require('../js/lakes.js');
const O = require('../js/osm.js');
const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

(async () => {
  const sq = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
  const count = (rings, W, H) => { let n = 0; L.forEachSpan(rings, W, H, (y, a, b) => { n += b - a + 1; }); return n; };
  check('fill covers the pixels whose centres are inside', count([sq(2, 2, 6, 6)], 10, 10) === 16);
  check('half-pixel edges follow the pixel centres', count([sq(2.6, 2.6, 5.6, 5.6)], 10, 10) === 9);
  check('an island ring is left dry', count([sq(1, 1, 9, 9), sq(3, 3, 6, 6)], 10, 10) === 64 - 9);
  check('clipped to the grid', count([sq(-5, -5, 5, 5)], 10, 10) === 25 && count([sq(20, 20, 30, 30)], 10, 10) === 0);
  const tri = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 }, { x: 0, y: 0 }];
  const cnt = count([tri], 10, 10);
  check('a diagonal edge gives about half the square', cnt >= 28 && cnt <= 36, String(cnt));

  // flatten
  const W = 20, H = 20;
  const plane = () => { const d = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = 100 + x + 2 * y; return d; };
  const orig = plane(), data = plane();
  const lakeA = { id: 'a', name: 'A', incomplete: false, rings: [sq(4, 4, 10, 10)] };
  let r = L.flatten(data, W, H, [lakeA]);
  const vals = new Set(); for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) vals.add(data[y * W + x]);
  check('every pixel in the lake takes one level', vals.size === 1 && r.summary.flattened === 1 && r.summary.pixels > 0, [...vals].join());
  const median = [...(() => { const a = []; for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) a.push(orig[y * W + x]); return a.sort((p, q) => p - q); })()];
  check('the level is the median of the lake', [...vals][0] === (median[17] + median[18]) / 2, String([...vals][0]));
  let outsideSame = true; for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; if (!(x >= 4 && x < 10 && y >= 4 && y < 10) && data[i] !== orig[i]) outsideSame = false; }
  check('pixels outside the lake are untouched', outsideSame);
  L.revert(data, r.patches);
  check('revert restores every sample exactly', data.every((v, i) => v === orig[i]));

  const flat = plane(); for (let y = 4; y < 10; y++) for (let x = 4; x < 10; x++) flat[y * W + x] = 500;
  r = L.flatten(flat, W, H, [lakeA]);
  check('a lake that is already flat is left alone', r.summary.flat === 1 && r.summary.flattened === 0 && r.patches.length === 0);

  const hole = plane(); for (let x = 4; x < 10; x++) hole[5 * W + x] = NaN;
  const holeOrig = Float32Array.from(hole);
  r = L.flatten(hole, W, H, [lakeA]);
  check('no-data inside a lake takes the level', !hole.slice(0).some((v, i) => v !== v && (i % W) >= 4 && (i % W) < 10 && ((i / W) | 0) >= 4 && ((i / W) | 0) < 10));
  L.revert(hole, r.patches);
  check('and revert brings the no-data back', hole.every((v, i) => v === holeOrig[i] || (v !== v && holeOrig[i] !== holeOrig[i])));

  const isl = plane();
  r = L.flatten(isl, W, H, [{ id: 'i', rings: [sq(2, 2, 14, 14), sq(6, 6, 10, 10)], incomplete: false }]);
  check('an island keeps its own elevation', isl[7 * W + 7] === orig[7 * W + 7] && isl[3 * W + 3] === isl[12 * W + 12] && r.summary.flattened === 1);

  r = L.flatten(plane(), W, H, [{ id: 'x', rings: [sq(1, 1, 2, 2)], incomplete: false }, { id: 'y', rings: [sq(4, 4, 9, 9)], incomplete: true }, { id: 'z', rings: [], incomplete: false }]);
  check('tiny and incomplete lakes are skipped and counted', r.summary.tiny === 1 && r.summary.incomplete === 2 && r.summary.flattened === 0, JSON.stringify(r.summary));

  const over = plane();
  r = L.flatten(over, W, H, [{ id: 'p', rings: [sq(2, 2, 12, 12)], incomplete: false }, { id: 'q', rings: [sq(8, 8, 16, 16)], incomplete: false }]);
  L.revert(over, r.patches);
  check('overlapping lakes revert in the right order', over.every((v, i) => v === orig[i]));

  // grouping from OSM data
  const P = (lat, lon) => ({ lat, lon });
  const B = { south: 0, west: 0, north: 1, east: 1 };
  const ring = (a, b) => [P(a, a), P(a, b), P(b, b), P(b, a), P(a, a)];
  const feats = O.parse({ elements: [
    { type: 'way', id: 1, tags: { natural: 'water', water: 'lake' }, geometry: ring(0.1, 0.3) },
    { type: 'way', id: 2, tags: { natural: 'water', water: 'river' }, geometry: ring(0.5, 0.6) },
    { type: 'way', id: 3, tags: { natural: 'water' }, geometry: [P(0.7, 0.7), P(0.7, 0.8), P(0.8, 0.8)] },
    { type: 'relation', id: 4, tags: { natural: 'water', water: 'reservoir', name: 'Res' }, members: [
      { type: 'way', role: 'outer', geometry: ring(0.4, 0.9) }, { type: 'way', role: 'inner', geometry: ring(0.6, 0.7) }] },
    { type: 'way', id: 5, tags: { highway: 'primary' }, geometry: [P(0, 0), P(1, 1)] },
  ] });
  check('parse tells outer rings from islands and keeps ids', feats.filter((f) => f.id === 'relation4').map((f) => f.role).sort().join() === 'inner,outer' && feats[0].water === 'lake');
  const lakes = L.groupLakes(feats, B, 100, 100);
  check('rivers and roads are not lakes; rings of a relation stay together', lakes.length === 3 && lakes.find((l) => l.name === 'Res').rings.length === 2 && !lakes.some((l) => l.id === 'way2'), lakes.map((l) => l.id).join());
  check('an open outline marks the lake incomplete', lakes.find((l) => l.id === 'way3').incomplete === true && !lakes.find((l) => l.id === 'way1').incomplete);
  check('projected into pixels, y down', Math.abs(lakes.find((l) => l.id === 'way1').rings[0][0].x - 10) < 1e-9 && Math.abs(lakes.find((l) => l.id === 'way1').rings[0][0].y - 90) < 1e-9);

  // -- the checkbox in the app
  const srv = http.createServer((q2, r2) => { const p = path.join(require('./lib.js').ROOT, q2.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q2.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r2.statusCode = 404; r2.end(); } else { r2.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r2.end(d); } }); });
  await new Promise((res) => srv.listen(8151, res));
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.route(/tile\.openstreetmap/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const posts = []; let mode = 'ok';
  await ctx.route(/overpass/, async (route) => {
    posts.push(decodeURIComponent(route.request().postData() || ''));
    if (mode === 'down') return route.fulfill({ status: 503, body: 'busy', headers: { 'access-control-allow-origin': '*' } });
    const rg = await pg.evaluate(() => window.MapNC.region());
    const lat = (t) => rg.south + (rg.north - rg.south) * t, lon = (t) => rg.west + (rg.east - rg.west) * t;
    const rc = (t0, t1, u0, u1) => [{ lat: lat(t0), lon: lon(u0) }, { lat: lat(t0), lon: lon(u1) }, { lat: lat(t1), lon: lon(u1) }, { lat: lat(t1), lon: lon(u0) }, { lat: lat(t0), lon: lon(u0) }];
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ elements: [
      { type: 'way', id: 11, tags: { natural: 'water', water: 'lake' }, geometry: rc(0.3, 0.5, 0.6, 0.8) },
      { type: 'way', id: 12, tags: { natural: 'water', water: 'river' }, geometry: rc(0.7, 0.9, 0.1, 0.4) },
    ] }) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://localhost:8151/'); await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const txt = (id) => pg.locator('#' + id).innerText();
  const snap = () => pg.evaluate(() => { const e = window.MapNC.elevation; return { data: Array.from(e.data), min: e.min, max: e.max, w: e.width, h: e.height }; });
  const before = await snap();
  check('lakes are not looked up until asked', posts.length === 0);
  await pg.check('#flatten-lakes');
  await pg.waitForFunction(() => /flattened/.test(document.getElementById('lake-note').textContent), { timeout: 15000 });
  check('one request, for lakes only', posts.length === 1 && /natural/.test(posts[0]) && !/highway/.test(posts[0]), String(posts.length));
  check('the note says what happened', /1 flattened/.test(await txt('lake-note')), await txt('lake-note'));
  const after = await snap();
  const px = (s, t, u) => s.data[Math.floor(t * s.h) * s.w + Math.floor(u * s.w)];
  // the Y axis is flipped: t is measured from the south edge
  const lakeVals = new Set();
  for (let u = 0.62; u < 0.78; u += 0.02) for (let t = 0.32; t < 0.48; t += 0.02) lakeVals.add(px(after, 1 - t, u));
  check('the lake is one flat level in the loaded data', lakeVals.size === 1, [...lakeVals].slice(0, 3).join());
  check('the river area is left sloping', new Set([0.15, 0.2, 0.3].map((u) => px(after, 1 - 0.8, u))).size === 3);
  check('the range is recomputed from the flattened data', after.min === after.data.reduce((m, v) => (v < m ? v : m), Infinity) && after.max === after.data.reduce((m, v) => (v > m ? v : m), -Infinity));
  check('the readout shows the new range', (await txt('res-range')).startsWith(after.min.toFixed(1)), await txt('res-range'));
  await pg.uncheck('#flatten-lakes');
  await pg.waitForFunction(() => !/flattened/.test(document.getElementById('lake-note').textContent), { timeout: 5000 });
  const back = await snap();
  check('unticking restores the original samples', back.data.every((v, i) => v === before.data[i]) && back.min === before.min && back.max === before.max);
  await pg.check('#flatten-lakes');
  await pg.waitForFunction(() => /flattened/.test(document.getElementById('lake-note').textContent), { timeout: 15000 });
  check('ticking again reuses the cached outlines', posts.length === 1, String(posts.length));
  // a failing service
  await pg.uncheck('#flatten-lakes');
  await pg.evaluate(() => window.MapNCOsm.clearCache());
  mode = 'down';
  await pg.check('#flatten-lakes');
  await pg.waitForFunction(() => /answered 503|Could not reach/.test(document.getElementById('lake-note').textContent), { timeout: 20000 });
  const failed = await snap();
  check('a failing service gives a message and leaves the data alone', /503/.test(await txt('lake-note')) && failed.data.every((v, i) => v === before.data[i]), await txt('lake-note'));
  console.log('page errors:', errs); await b.close(); srv.close(); process.exit(0);
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
