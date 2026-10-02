const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8142, async () => {
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.route(/tile\.openstreetmap/, r => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  let reqs = 0;
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    reqs++; const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; }); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
  const ready = () => pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const sum = () => pg.evaluate(() => { const g = window.MapNC.grey.data; let s = 0; for (let i = 0; i < g.length; i += 7) s = (s * 31 + g[i]) % 1000000007; return s; });
  const paths = () => pg.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length);
  const txt = (id) => pg.locator('#' + id).innerText();

  await pg.goto('http://localhost:8142/'); await ready();
  check('clean-up pane visible with a route', await pg.locator('#pane-clean').isVisible());
  await pg.click('summary:has-text("Clean up")');
  check('initially unchanged', /unchanged/.test(await txt('clean-points')), await txt('clean-points'));
  const base = await sum(), reqs0 = reqs, p0 = await paths();

  await pg.click('#clean-suggest'); await pg.waitForTimeout(500);
  const pts = await txt('clean-points'); const [a, c] = pts.split('→').map(s => parseInt(s));
  check('suggested settings cut the point count a lot', c < a / 3, pts);
  check('length + shift reported', /→/.test(await txt('clean-length')) && /m from the original/.test(await txt('clean-shift')), `${await txt('clean-length')} | ${await txt('clean-shift')}`);
  check('original shown dashed under the cleaned line', (await paths()) === p0 + 1);
  check('route in the heightmap changed', (await sum()) !== base);
  check('no elevation reload from cleaning', reqs === reqs0, `${reqs - reqs0} new requests`);
  check('track summary follows the cleaned track', new RegExp(c + ' points').test(await txt('track-info')), await txt('track-info'));

  await pg.click('#clean-reset'); await pg.waitForTimeout(500);
  check('reset restores the heightmap exactly', (await sum()) === base);
  check('reset removes the dashed original', (await paths()) === p0);

  // each control on its own
  for (const [id, val] of [['clean-smooth', '8'], ['clean-simplify', '4'], ['clean-spacing', '6']]) {
    await pg.fill('#' + id, val); await pg.waitForTimeout(400);
    check(`${id} = ${val} alone changes the route`, /→/.test(await txt('clean-points')) || (await sum()) !== base, await txt('clean-points'));
    await pg.fill('#' + id, '0'); await pg.waitForTimeout(400);
  }
  check('all zero = unchanged again', /unchanged/.test(await txt('clean-points')) && (await sum()) === base);

  // noisy file with injected spikes
  await pg.setInputFiles('#track-file', S + '/noisy.gpx'); await pg.waitForFunction(() => /Noisy sample/.test(document.getElementById('track-info').textContent));
  await ready();
  check('loading a new route resets the clean-up settings', !(await pg.locator('#clean-spikes').isChecked()) && (await pg.inputValue('#clean-smooth')) === '0');
  await pg.check('#clean-spikes'); await pg.fill('#clean-spike-m', '25'); await pg.waitForTimeout(500);
  const sp = parseInt(await txt('clean-spikes-n')); check('spike removal reports the injected spikes (46 injected)', sp >= 40 && sp <= 60, 'removed ' + sp);
  console.log('   ', await txt('clean-points'), '|', await txt('clean-shift'));
  await pg.click('#clean-suggest'); await pg.waitForTimeout(500);
  await pg.screenshot({ path: S + '/cleanui.png' });

  // clearing the route hides the pane
  await pg.click('#track-clear'); check('Clear route hides the clean-up pane', !(await pg.locator('#pane-clean').isVisible()));
  console.log('page errors:', errs); await b.close(); process.exit(0);
});
