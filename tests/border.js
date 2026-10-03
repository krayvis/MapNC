// Edge border (rim, chamfer, rounded) in the grey mapping, then the controls in the app.
global.self = global;
const H = require('../js/heightmap.js');
const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

(async () => {
  const W = 40, Hh = 30, e = new Float32Array(W * Hh).fill(50);
  const grey = (o) => H.toGrey(e, Object.assign({ bits: 8, stats: { min: 0, max: 100 }, rangeMode: 'auto' }, o));
  const bd = (style, toward, widthPx) => ({ style, toward, widthPx, width: W, height: Hh });
  const at = (g, x, y) => g.data[y * W + x];
  const base = at(grey({}), 20, 15);

  check('no border leaves the terrain alone', grey({}).data.every((v) => v === base) && grey({}).border === null);
  check('a zero width is no border', grey({ border: bd('rim', 'high', 0) }).data.every((v) => v === base));

  let g = grey({ border: bd('rim', 'high', 5) });
  check('a rim is a flat band at the top level', [0, 4].every((x) => at(g, x, 15) === 255) && at(g, 5, 15) === base && at(g, 20, 0) === 255 && at(g, 20, 4) === 255 && at(g, 20, 5) === base && at(g, W - 1, 15) === 255 && at(g, 20, Hh - 1) === 255);
  g = grey({ border: bd('rim', 'low', 5) });
  check('a low rim is black', at(g, 0, 15) === 0 && at(g, 4, 15) === 0 && at(g, 20, 15) === base);

  g = grey({ border: bd('chamfer', 'low', 10) });
  const row = []; for (let x = 0; x < 12; x++) row.push(at(g, x, 15));
  check('a chamfer slopes down to black at the edge', row[0] <= 2 && row.every((v, i) => i === 0 || v >= row[i - 1]) && row[11] === base, row.join(','));
  const steps = row.slice(1, 10).map((v, i) => v - row[i]);
  check('the chamfer slope is straight', Math.max(...steps) - Math.min(...steps) <= 2, steps.join(','));
  g = grey({ border: bd('chamfer', 'high', 10) });
  check('a chamfer toward the top rises to white', at(g, 0, 15) >= 253 && at(g, 11, 15) === base);

  g = grey({ border: bd('round', 'low', 10) });
  const r2 = []; for (let x = 0; x < 12; x++) r2.push(at(g, x, 15));
  const c2 = grey({ border: bd('chamfer', 'low', 10) });
  check('a rounded edge reaches the level at the edge and meets the terrain smoothly', r2[0] <= 2 && r2.every((v, i) => i === 0 || v >= r2[i - 1]) && r2[11] === base && r2[8] - r2[7] < r2[1] - r2[0], r2.join(','));
  check('a rounded edge keeps more terrain than a chamfer at mid-width', at(g, 5, 15) > at(c2, 5, 15));

  g = grey({ border: bd('chamfer', 'low', 10) });
  check('corners follow the nearest edge', at(g, 0, 0) <= 2 && at(g, 3, 3) === at(g, 3, 15) && at(g, 3, 3) === at(g, 15, 3));
  g = grey({ border: bd('rim', 'high', 1000) });
  check('a huge width stops at half the short side', at(g, 20, 14) === 255 && at(g, 20, 15) === 255, 'whole map is rim');
  g = grey({ bits: 16, border: bd('rim', 'high', 3) });
  check('works in 16 bit', at(g, 0, 0) === 65535 && at(g, 10, 10) === Math.round(0.5 * 65535));
  g = grey({ invert: true, border: bd('rim', 'high', 3) });
  check('invert flips the border with the terrain', at(g, 0, 0) === 0 && at(g, 10, 10) === 255 - base);
  const nan = e.slice(); nan[0] = NaN; nan[W + 5] = NaN;
  g = H.toGrey(nan, { bits: 8, stats: { min: 0, max: 100 }, rangeMode: 'auto', border: bd('rim', 'high', 3) });
  check('no-data stays black and counted', g.data[0] === 0 && g.data[W + 5] === 0 && g.nodata === 2);

  // ---- app
  const srv = http.createServer((q2, r2) => { const p = path.join(require('./lib.js').ROOT, q2.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q2.url.split('?')[0])); fs.readFile(p, (er, d) => { if (er) { r2.statusCode = 404; r2.end(); } else { r2.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r2.end(d); } }); });
  await new Promise((res) => srv.listen(8153, res));
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; });
  const errs = []; pg.on('pageerror', (er) => errs.push(er.message));
  await pg.goto('http://localhost:8153/'); await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const txt = (id) => pg.locator('#' + id).innerText();
  const px = (x, y) => pg.evaluate(([x, y]) => { const m = window.MapNC; return m.grey.data[y * m.elevation.width + x]; }, [x, y]);
  const plain = await px(0, 0);
  check('the width inputs are hidden until a style is chosen', !(await pg.isVisible('#border-width')));
  await pg.selectOption('#border-style', 'rim');
  check('choosing a style shows the width and level; a rim defaults to the top', (await pg.isVisible('#border-width')) && (await pg.inputValue('#border-toward')) === 'high');
  check('without a carve size it asks for one and changes nothing', /carve size/.test(await txt('border-note')) && (await px(0, 0)) === plain, await txt('border-note'));
  await pg.evaluate(() => { document.getElementById('pane-output').open = true; });
  await pg.fill('#carve-size', '200'); await pg.selectOption('#carve-unit', 'mm');
  await pg.fill('#border-width', '10'); await pg.waitForTimeout(300);
  const dims = await pg.evaluate(() => ({ w: window.MapNC.elevation.width, h: window.MapNC.elevation.height }));
  const wantPx = Math.round(10 / 200 * Math.max(dims.w, dims.h));
  check('the note gives the width in pixels', new RegExp('About ' + wantPx + ' pixels').test(await txt('border-note')), await txt('border-note'));
  const rimPx = [await px(0, 0), await px(wantPx - 1, 500), await px(wantPx + 3, 500)];
  check('the rim shows in the heightmap', rimPx[0] === 65535 && rimPx[1] === 65535 && rimPx[2] !== 65535, rimPx.join());
  await pg.selectOption('#border-style', 'chamfer');
  check('a chamfer defaults to the bottom level', (await pg.inputValue('#border-toward')) === 'low');
  await pg.waitForTimeout(200);
  const edge = await px(0, 500), inner = await px(Math.round(wantPx / 2), 500), deep = await px(wantPx + 5, 500);
  check('the chamfer rises from the edge into the terrain', edge < inner && inner < deep + 1 && edge < 200, [edge, inner, deep].join());
  await pg.selectOption('#border-style', 'none'); await pg.waitForTimeout(200);
  check('turning it off restores the terrain', (await px(0, 0)) === plain && !(await pg.isVisible('#border-width')));
  // export carries it
  await pg.selectOption('#border-style', 'rim'); await pg.waitForTimeout(200);
  const dl = pg.waitForEvent('download'); await pg.click('#export-btn');
  const png = fs.readFileSync(await (await dl).path()).toString('latin1');
  check('the PNG records the border', /EdgeBorder\u0000rim 10 mm, toward high/.test(png));
  console.log('page errors:', errs); await b.close(); srv.close(); process.exit(0);
})().catch((er) => { console.log('FAIL exception ' + er.stack); process.exit(1); });
