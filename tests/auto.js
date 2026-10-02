const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8141, async () => {
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 900 } });
  const tile = fs.readFileSync(S + '/tile.png');
  await ctx.route(/tile\.openstreetmap|arcgisonline|opentopomap|basemap\.nationalmap/, r => r.fulfill({ status: 200, contentType: 'image/png', body: tile }));
  let mode = 'ok', delay = 0; const reqs = [];
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    reqs.push({ t: Date.now(), w, h });
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (mode === 'fail') return route.fulfill({ status: 500, body: 'boom' });
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  await ctx.route('**/s3.amazonaws.com/**', r => r.abort());   // no Terrarium fallback in this test
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
  const ready = () => pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const status = () => pg.locator('#status').innerText();
  const hbx = () => pg.evaluate(() => [...document.querySelectorAll('.corner-handle')].map(e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }));

  // 1. default sample -> zoomed in, loads with no click
  await pg.goto('http://localhost:8141/');
  await ready();
  check('loaded with no click', /USGS 3DEP/.test(await status()), await status());
  const z = await pg.evaluate(() => window.MapNC.map.getZoom()); check('map zoomed to the sample', z >= 13, 'zoom ' + z);
  check('heightmap + export panes populated', await pg.locator('#hm-section').isVisible() && await pg.locator('#export-section').isVisible() && !(await pg.locator('#hm-empty').isVisible()));
  check('no manual fetch button when auto', !(await pg.locator('#fetch-btn').isVisible()));
  const n1 = reqs.length;

  // 2. not while dragging; once after release
  const mv = await pg.evaluate(() => { const r = document.querySelector('.move-handle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await pg.mouse.move(mv[0], mv[1]); await pg.mouse.down(); await pg.mouse.move(mv[0] + 60, mv[1] + 30, { steps: 6 });
  await pg.waitForTimeout(1600);                                 // longer than the settle delay, button still held
  check('no loading while mid-drag', reqs.length === n1 && /Waiting|editing/i.test(await status()), `${reqs.length - n1} new requests; "${await status()}"`);
  check('heightmap cleared while editing', !(await pg.locator('#hm-section').isVisible()));
  await pg.mouse.up();
  await ready();
  check('loads again after release', reqs.length > n1);
  const regionNow = await pg.evaluate(() => window.MapNC.region()), eb = await pg.evaluate(() => window.MapNC.elevation.bounds);
  check('loaded data matches the moved region', Math.abs(regionNow.north - eb.north) < 1e-9 && Math.abs(regionNow.west - eb.west) < 1e-9);

  // 3. setting change -> reload
  const n2 = reqs.length; await pg.selectOption('#aspect-select', '1:1'); await ready(); check('aspect change reloads', reqs.length > n2);

  // 4. large output waits for a click
  await pg.click('summary:has-text("Output size")');
  await pg.selectOption('#res-mode', 'pixels'); await pg.fill('#res-value', '3000'); const n3 = reqs.length; await pg.waitForTimeout(1500);
  check('large output: no automatic load', reqs.length === n3 && await pg.locator('#fetch-btn').isVisible() && /Large output/.test(await status()), await status());
  await pg.click('#fetch-btn'); await ready(); check('large output loads on click', reqs.length > n3 && !(await pg.locator('#fetch-btn').isVisible()));

  // 5. over the cap
  await pg.fill('#res-value', '9000'); await pg.waitForTimeout(1200);
  check('over cap: message, no button', /size limit/.test(await status()) && !(await pg.locator('#fetch-btn').isVisible()), await status());
  await pg.selectOption('#res-mode', 'auto');

  // 6. change during a slow load cancels it; only the latest result lands
  delay = 2500; await ready().catch(() => {}); await pg.selectOption('#aspect-select', '3:2');
  await pg.waitForSelector('#progress:not([hidden])', { timeout: 8000 });
  check('progress + Stop shown while loading', await pg.locator('#cancel-btn').isVisible());
  await pg.selectOption('#aspect-select', '4:3');                 // change mid-load
  delay = 0; await pg.waitForTimeout(300); await ready();
  const rr = await pg.evaluate(() => { const r = window.MapNC.region(); const e = window.MapNC.elevation.bounds; const G = window.MapNCGeo; return { ratio: G.groundRatio(r), same: Math.abs(r.north - e.north) < 1e-9 }; });
  check('only the latest settings land', Math.abs(rr.ratio - 4 / 3) < 1e-3 && rr.same, JSON.stringify(rr));
  check('progress hidden when done', !(await pg.locator('#progress').isVisible()));

  // 7. Stop button
  delay = 4000; await pg.selectOption('#aspect-select', '1:1'); await pg.waitForSelector('#progress:not([hidden])', { timeout: 8000 });
  await pg.click('#cancel-btn'); check('Stop cancels and offers to load', /Stopped/.test(await status()) && await pg.locator('#fetch-btn').isVisible()); delay = 0;
  await pg.click('#fetch-btn'); await ready();

  // 8. failure -> error + Retry
  mode = 'fail'; await pg.selectOption('#aspect-select', '16:9');
  await pg.waitForSelector('#fetch-error:not([hidden])', { timeout: 15000 });
  check('error shown with Retry', /Retry/.test(await pg.locator('#fetch-btn').innerText()) && /Could not load/.test(await status()), (await pg.locator('#fetch-error').innerText()).slice(0, 80));
  mode = 'ok'; await pg.click('#fetch-btn'); await ready(); check('Retry recovers', !(await pg.locator('#fetch-error').isVisible()));

  // 9. sticky strip + panes
  await pg.evaluate(() => { document.getElementById('panel').scrollTop = 400; });
  const strip = await pg.locator('#data-strip').boundingBox(), panel = await pg.locator('#panel').boundingBox();
  check('data strip stays pinned while scrolling', Math.abs(strip.y - panel.y) < 2, `strip y ${strip.y} panel y ${panel.y}`);
  await pg.evaluate(() => { document.getElementById('panel').scrollTop = 0; });
  await pg.click('summary:has-text("Heightmap")'); check('pane collapses', !(await pg.locator('#pane-heightmap').evaluate(e => e.open)));
  await pg.reload(); await pg.waitForTimeout(500);
  check('collapsed pane remembered after reload', !(await pg.locator('#pane-heightmap').evaluate(e => e.open)) && (await pg.locator('#pane-region').evaluate(e => e.open)));
  await pg.screenshot({ path: S + '/panes.png' });
  console.log('page errors:', errs);
  await b.close(); process.exit(0);
});
