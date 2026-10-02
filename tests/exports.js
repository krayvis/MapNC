const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8143, async () => {
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap/, r => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', r => r.fulfill({ status: 500, body: 'no elevation in this test' }));   // elevation never loads
  await ctx.route('**/s3.amazonaws.com/**', r => r.abort());
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; }); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
  const txt = (id) => pg.locator('#' + id).innerText();
  const dl = async (sel, name) => { const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 120000 }), pg.click(sel)]); const out = S + '/ex_' + name; await d.saveAs(out); return { out, name: d.suggestedFilename() }; };
  const files = {};

  await pg.goto('http://localhost:8143/'); await pg.waitForSelector('#route-export:not([hidden])');
  await pg.waitForSelector('#fetch-error:not([hidden])', { timeout: 15000 });     // elevation failed, as intended
  check('elevation unavailable (as set up)', !(await pg.locator('#hm-section').isVisible()));
  check('route export still offered', await pg.locator('#route-export').isVisible());
  check('layer info before choosing', /1410 × 2048 px/.test(await txt('layer-info')), await txt('layer-info'));
  check('PNG tab is shown first, vector panel hidden', await pg.locator('#tabpanel-png').isVisible() && !(await pg.locator('#tabpanel-vec').isVisible()));
  await pg.click('#tab-vec'); check('vector tab switches panels', await pg.locator('#tabpanel-vec').isVisible() && !(await pg.locator('#tabpanel-png').isVisible()) && (await pg.getAttribute('#tab-vec', 'aria-selected')) === 'true');
  check('vector hint says pixels without a carve size', /pixels/.test(await txt('vec-hint')));

  await pg.click('summary:has-text("Output size")'); await pg.fill('#carve-size', '12');
  check('advice appears with a carve size', /stepover/.test(await txt('out-advice')), await txt('out-advice'));
  await pg.fill('#stepover', '0.01'); await pg.waitForTimeout(100); check('too-coarse warning for a very fine stepover', /Too coarse/.test(await txt('out-advice')), await txt('out-advice'));
  await pg.fill('#stepover', '5'); await pg.waitForTimeout(100); check('generous stepover is fine or over-provisioned', /sufficient|More than needed|only sampled/.test(await txt('out-advice')), await txt('out-advice')); await pg.fill('#stepover', '');
  // -- fast path: raw vs clean for the vector, same size PNG
  files.px = await dl('#export-dxf-btn', 'raw.dxf'); await pg.waitForTimeout(200);
  check('vector hint switches to millimetres', /millimetres/.test(await txt('vec-hint')));
  files.svg = await dl('#export-svg-btn', 'raw.svg'); files.dxf = await dl('#export-dxf-btn', 'mm.dxf');
  await pg.uncheck('#vec-border'); files.dxfNoBorder = await dl('#export-dxf-btn', 'noborder.dxf'); await pg.check('#vec-border');
  await pg.click('summary:has-text("Clean up")'); await pg.click('#clean-suggest'); await pg.waitForTimeout(400);
  files.dxfClean = await dl('#export-dxf-btn', 'clean.dxf');
  await pg.click('#clean-reset'); await pg.waitForTimeout(300);
  await pg.check('#spline-on'); files.svgSpline = await dl('#export-svg-btn', 'spline.svg'); await pg.uncheck('#spline-on');
  const fsz = (f) => require('fs').statSync(f.out).size;
  check('spline changes the SVG route', fsz(files.svgSpline) !== fsz(files.svg), fsz(files.svg) + ' -> ' + fsz(files.svgSpline) + ' bytes');

  // -- route layer PNG at several sizes
  await pg.click('#tab-png');
  files.same = await dl('#export-route-btn', 'same.png'); check('same-size layer saved', /_1410x2048_route\.png$/.test(files.same.name), files.same.name + ' | ' + await txt('route-export-status'));
  await pg.selectOption('#layer-size', '4'); check('4x info', /5640 × 8192 px/.test(await txt('layer-info')), await txt('layer-info'));
  const t0 = Date.now(); files.x4 = await dl('#export-route-btn', 'x4.png'); const t4 = ((Date.now() - t0) / 1000).toFixed(1);
  check('4x layer saved', /_5640x8192_route\.png$/.test(files.x4.name), `${t4} s | ${await txt('route-export-status')}`);
  await pg.selectOption('#layer-size', 'px'); await pg.fill('#layer-px', '99999'); check('size is clamped and says so', /Limited to 16384/.test(await txt('layer-info')) && /16384/.test(await txt('layer-info')), await txt('layer-info'));
  await pg.fill('#layer-px', '300'); files.small = await dl('#export-route-btn', 'small.png');

  // -- cancel a big one
  await pg.fill('#layer-px', '16384');
  let downloaded = false; pg.once('download', () => { downloaded = true; });
  await pg.click('#export-route-btn'); await pg.waitForTimeout(600);
  check('button becomes Cancel while working', (await txt('export-route-btn')) === 'Cancel', await txt('route-export-status'));
  await pg.click('#export-route-btn'); await pg.waitForFunction(() => /Cancelled/.test(document.getElementById('route-export-status').textContent), { timeout: 30000 });
  check('cancel stops the export, no file', !downloaded && (await txt('export-route-btn')) === 'Export route layer (PNG)');

  fs.writeFileSync(S + '/exfiles.json', JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.out]))));
  console.log('page errors:', errs); await b.close(); process.exit(0);
});
