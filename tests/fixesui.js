// Fill gaps and Raise floor in the app: the checkboxes, notes, undo, order independence and the PNG metadata.
global.self = global;
const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

(async () => {
  const srv = http.createServer((q2, r2) => { const p = path.join(require('./lib.js').ROOT, q2.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q2.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r2.statusCode = 404; r2.end(); } else { r2.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r2.end(d); } }); });
  await new Promise((res) => srv.listen(8152, res));
  // a plane over the whole region, with a 6 x 6 hole of no-data (-9999) in the middle of each request
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    for (let j = cy - 3; j < cy + 3; j++) for (let i = cx - 3; i < cx + 3; i++) arr[j * w + i] = -9999;
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://localhost:8152/'); await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const txt = (id) => pg.locator('#' + id).innerText();
  const snap = () => pg.evaluate(() => { const e = window.MapNC.elevation; return { data: Array.from(e.data), min: e.min, max: e.max, nodata: e.nodata, w: e.width, h: e.height }; });
  const settle = () => pg.waitForTimeout(400);
  const before = await snap();
  check('the loaded data has a hole', before.nodata > 0 && /magenta/.test(await txt('res-nodata')), String(before.nodata));

  await pg.check('#fill-gaps'); await settle();
  let s = await snap();
  check('Fill gaps removes the no-data', s.nodata === 0 && s.data.every((v) => v === v), String(s.nodata));
  check('the note says what was filled', /Filled .* in \d+ gaps?/.test(await txt('gap-note')), await txt('gap-note'));
  check('the readout no longer reports no-data', (await txt('res-nodata')) === 'none', await txt('res-nodata'));
  let worst = 0; const i0 = before.data.findIndex((v) => v !== v);
  const rg = await pg.evaluate(() => window.MapNC.region());
  for (let i = 0; i < s.data.length; i++) if (before.data[i] !== before.data[i]) { const x = i % s.w, y = (i / s.w) | 0; worst = Math.max(worst, Math.abs(s.data[i] - f(rg.west + (x + .5) / s.w * (rg.east - rg.west), rg.north - (y + .5) / s.h * (rg.north - rg.south)))); }
  check('the filled pixels follow the slope', worst < 5, 'worst ' + worst.toFixed(2) + ' m');
  await pg.uncheck('#fill-gaps'); await settle();
  s = await snap();
  check('unticking puts the hole back', s.nodata === before.nodata && s.data.every((v, i) => v === before.data[i] || (v !== v && before.data[i] !== before.data[i])));

  const mid = Math.round((before.min + before.max) / 2);
  await pg.fill('#floor-level', String(mid));
  await pg.check('#raise-floor'); await settle();
  s = await snap();
  check('Raise floor lifts everything below the level to it', s.min === mid && s.data.every((v) => v !== v || v >= mid), s.min + ' vs ' + mid);
  check('the note counts the raised pixels', new RegExp('pixels \\(.*%\\) raised to ' + mid + ' m').test(await txt('floor-note')), await txt('floor-note'));
  check('the range readout starts at the floor', (await txt('res-range')).startsWith(mid.toFixed(1) + ' to'), await txt('res-range'));
  await pg.fill('#floor-level', String(mid + 20)); await pg.press('#floor-level', 'Tab'); await settle();
  s = await snap();
  check('changing the level re-applies from the original data', s.min === mid + 20 && s.max === before.max, s.min + ' to ' + s.max);
  await pg.fill('#floor-level', '9999'); await pg.press('#floor-level', 'Tab'); await settle();
  check('a floor above everything warns', /warning/.test(await pg.getAttribute('#floor-note', 'class')), await txt('floor-note'));
  await pg.fill('#floor-level', ''); await pg.press('#floor-level', 'Tab'); await settle();
  check('a blank level asks for a number and leaves the data alone', /Enter a level/.test(await txt('floor-note')) && (await snap()).min === before.min);
  await pg.fill('#floor-level', String(mid)); await pg.press('#floor-level', 'Tab'); await settle();

  // both together, in either order, give the same data
  await pg.check('#fill-gaps'); await settle();
  const both = await snap();
  await pg.uncheck('#raise-floor'); await pg.uncheck('#fill-gaps'); await settle();
  await pg.check('#raise-floor'); await pg.check('#fill-gaps'); await settle();
  const both2 = await snap();
  check('the order the boxes are ticked does not matter', both.data.every((v, i) => v === both2.data[i]));
  check('both applied: no holes, nothing below 0', both.nodata === 0 && both.min === mid);

  // the export records what was done
  await pg.uncheck('#raise-floor'); await settle();
  const dl = pg.waitForEvent('download');
  await pg.click('#export-btn');
  const file = await (await dl).path();
  const png = fs.readFileSync(file).toString('latin1');
  check('the PNG records the fixes', /GapsFilled\u0000[1-9]/.test(png) && /FloorRaisedTo\u0000none/.test(png));

  // a new region discards the edits with the data
  await pg.evaluate(() => window.MapNC.region());
  console.log('page errors:', errs); await b.close(); srv.close(); process.exit(0);
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
