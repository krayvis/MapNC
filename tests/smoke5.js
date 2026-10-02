const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const root = require('./lib.js').ROOT, S = require('./lib.js').OUT;
const srv = http.createServer((q, r) => { const p = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8131, async () => {
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: 'dark', acceptDownloads: true });
  const tile = fs.readFileSync(S + '/tile.png'); const tileHits = {}; const depReq = [];
  for (const host of ['tile.openstreetmap.org', 'tile.opentopomap.org', 'server.arcgisonline.com', 'basemap.nationalmap.gov'])
    await ctx.route(`**/${host}/**`, r => { tileHits[host] = (tileHits[host] || 0) + 1; r.fulfill({ status: 200, contentType: 'image/png', body: tile }); });
  await ctx.route('**/*.tile.opentopomap.org/**', r => { tileHits['tile.opentopomap.org'] = (tileHits['tile.opentopomap.org'] || 0) + 1; r.fulfill({ status: 200, contentType: 'image/png', body: tile }); });
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    depReq.push({ w, h, interp: u.searchParams.get('interpolation') });
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; }); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
  await pg.goto('http://localhost:8131/'); await pg.waitForSelector('#track-info:not([hidden])');

  // --- sample route
  const info = await pg.locator('#track-info').innerText(); check('sample loads', /12\.\d km, 4360 points/.test(info), info);
  const grid = async () => (await pg.locator('#info-grid').innerText());
  const gridWH = async () => (await grid()).match(/(\d+) × (\d+)/).slice(1).map(Number);
  let [W, H] = await gridWH(); check('auto: long side 2048 for a ~2 km region', Math.max(W, H) === 2048, `${W}x${H}`);
  console.log('   out-px:', (await pg.locator('#out-px').innerText()), '|', await pg.locator('#out-carve').innerText());

  // --- modes
  await pg.click('summary:has-text("Output size")');
  await pg.selectOption('#res-mode', 'scale'); await pg.fill('#res-value', '2'); [W, H] = await gridWH();
  check('scale x2', Math.max(W, H) > 400 && Math.max(W, H) < 600, `${W}x${H}`);
  await pg.fill('#res-value', '8'); [W, H] = await gridWH(); check('scale x8 ~ 4x the x2 grid', Math.max(W, H) > 1800 && Math.max(W, H) < 2300, `${W}x${H}`);
  await pg.selectOption('#res-mode', 'pixels'); await pg.fill('#res-value', '1000'); [W, H] = await gridWH(); check('pixels 1000', Math.max(W, H) === 1000, `${W}x${H}`);
  await pg.selectOption('#res-mode', 'mpp'); await pg.fill('#res-value', '2'); [W, H] = await gridWH(); check('2 m/px', Math.max(W, H) > 1100 && Math.max(W, H) < 1400, `${W}x${H}`);
  await pg.selectOption('#res-mode', 'pixels'); await pg.fill('#res-value', '9000'); check('over cap flagged', await pg.locator('#cap-warning').isVisible() && /size limit/.test(await pg.locator('#status').innerText()));
  await pg.selectOption('#res-mode', 'auto'); [W, H] = await gridWH(); check('back to auto, size ok', Math.max(W, H) === 2048 && !(await pg.locator('#cap-warning').isVisible()));

  // --- carve size + fetch + export
  await pg.fill('#carve-size', '12'); const carve = await pg.locator('#out-carve').innerText(); check('carve readout 12 in', /0\.1\d\d mm per pixel/.test(carve), carve);
  await pg.waitForSelector('#result-info:not([hidden])', { timeout: 120000 });
  check('3DEP asked for cubic when upscaling', depReq.length > 0 && depReq.every(r => r.interp === 'RSP_CubicConvolution'), `${depReq.length} requests, sizes ${depReq.map(r => r.w + 'x' + r.h).join(' ')}`);
  const [d] = await Promise.all([pg.waitForEvent('download'), pg.click('#export-btn')]); await d.saveAs(S + '/sample16.png');
  const [d2] = await Promise.all([pg.waitForEvent('download'), pg.click('#export-route-btn')]); await d2.saveAs(S + '/samplelayer.png');
  fs.writeFileSync(S + '/info5.json', JSON.stringify({ W, H, b: await pg.evaluate(() => window.MapNC.elevation.bounds), min: await pg.evaluate(() => window.MapNC.elevation.min), max: await pg.evaluate(() => window.MapNC.elevation.max) }));

  // --- base maps (dark mode: photos must not be inverted)
  await pg.evaluate(() => window.MapNC.map.setView([39.6, -120.65], 14, { animate: false }));
  const names = await pg.evaluate(() => [...document.querySelectorAll('.leaflet-control-layers-base label')].map(l => l.textContent.trim()));
  check('4 base maps offered', names.length === 4, names.join(' | '));
  const filterOf = (cls) => pg.evaluate((c) => { const el = document.querySelector('.leaflet-layer.' + c); return el ? getComputedStyle(el).filter : null; }, cls);
  check('street map inverted in dark mode', (await filterOf('tiles-map')).includes('invert'), await filterOf('tiles-map'));
  { const tb = await pg.locator('.leaflet-control-layers-toggle').boundingBox(); await pg.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2); await pg.waitForTimeout(200); }
  await pg.click('text=Satellite (Esri World Imagery)'); await pg.waitForTimeout(500);
  check('satellite tiles requested', (tileHits['server.arcgisonline.com'] || 0) > 0, JSON.stringify(tileHits));
  check('satellite NOT inverted, only dimmed', (await filterOf('tiles-photo')).startsWith('brightness') && !(await filterOf('tiles-photo')).includes('invert'), await filterOf('tiles-photo'));
  await pg.screenshot({ path: S + '/basemap_sat_dark.png' });
  await pg.click('text=Topographic (OpenTopoMap)'); await pg.waitForTimeout(400);
  check('topo tiles requested', (tileHits['tile.opentopomap.org'] || 0) > 0);
  await pg.click('text=USGS Topo (US only)'); await pg.waitForTimeout(400);
  check('USGS topo tiles requested', (tileHits['basemap.nationalmap.gov'] || 0) > 0);
  await pg.click('text=Satellite (Esri World Imagery)');
  await pg.reload(); await pg.waitForTimeout(500);
  check('base map choice remembered after reload', (await pg.evaluate(() => !!document.querySelector('.leaflet-layer.tiles-photo'))));
  console.log('page errors:', errs);
  await b.close(); srv.close();
});
