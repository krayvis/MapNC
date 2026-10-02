const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8147, async () => {
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

  const txt = (id) => pg.locator('#' + id).innerText();
  await pg.goto('http://localhost:8147/'); await ready();
  check('layer export is offered', await pg.locator('#route-export').isVisible());
  await pg.click('#tab-vec');
  check('contour checkbox enabled once elevation is in', !(await pg.locator('#vec-contours').isDisabled()) && !(await pg.locator('#contour-need').isVisible()));
  check('interval hidden until contours are on', !(await pg.locator('#contour-m').isVisible()));
  await pg.check('#vec-contours');
  check('interval shown, with a sensible default', await pg.locator('#contour-m').isVisible() && +(await pg.inputValue('#contour-m')) > 0, await pg.inputValue('#contour-m'));
  await pg.waitForFunction(() => /lines on/.test(document.getElementById('contour-info').textContent), { timeout: 10000 });
  const info1 = await txt('contour-info'); check('line count shown', /\d+ lines on \d+ levels/.test(info1), info1);
  await pg.fill('#contour-m', '10'); await pg.waitForFunction((t) => document.getElementById('contour-info').textContent !== t && /lines on/.test(document.getElementById('contour-info').textContent), info1, { timeout: 10000 });
  const lv = (s) => +s.match(/on (\d+) levels/)[1];
  check('a finer interval gives more levels', lv(await txt('contour-info')) > lv(info1), await txt('contour-info'));
  await pg.fill('#contour-m', '0.2'); await pg.waitForTimeout(500);
  check('too many levels is refused', /larger interval/.test(await txt('contour-info')), await txt('contour-info'));
  await pg.fill('#contour-m', '20'); await pg.waitForTimeout(500);

  await pg.click('summary:has-text("Output size")'); await pg.fill('#carve-size', '12');
  const dl = async (sel, name) => { const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click(sel)]); const out = S + '/ct_' + name; await d.saveAs(out); return { out, name: d.suggestedFilename(), text: fs.readFileSync(out, 'utf8') }; };
  const svg = await dl('#export-svg-btn', 'c.svg'), dxf = await dl('#export-dxf-btn', 'c.dxf');
  check('file name says route and contours', /_route-contours\.svg$/.test(svg.name), svg.name);
  check('SVG carries contours and the route', /<g id="contours"/.test(svg.text) && /<g id="contours_index"/.test(svg.text) && /<g id="route"/.test(svg.text));
  check('DXF carries contour layers and the route', /\nCONTOURS\n/.test(dxf.text) && /\nCONTOURS_INDEX\n/.test(dxf.text) && /\nROUTE\n/.test(dxf.text));
  const xs = [...svg.text.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(' ').map((p) => p.split(',').map(Number)));
  const W = +svg.text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)[1], Hh = +svg.text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)[2];
  check('every point lies inside the extent', xs.every(([x, y]) => x >= -1e-6 && x <= W + 1e-6 && y >= -1e-6 && y <= Hh + 1e-6));
  // On this tilted plane the lines are straight: all contours should run in one direction.
  await pg.uncheck('#vec-contours');
  const plain = await dl('#export-svg-btn', 'p.svg');
  check('contours off: only the route', !/id="contours/.test(plain.text) && /<g id="route"/.test(plain.text));

  await pg.click('#tab-png');
  await pg.click('#view-hm'); await pg.waitForTimeout(300);
  const red = () => pg.evaluate(() => { const c = document.getElementById('hm-canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 120) n++; return n; });
  await pg.fill('#route-width', '5'); await pg.waitForTimeout(300); const thin = await red();
  await pg.fill('#route-width', '200'); await pg.waitForTimeout(300); const thick = await red();
  check('heightmap guide line follows the line width', thick > thin * 2, thin + ' -> ' + thick);
  await pg.click('#view-map'); await pg.click('#tab-vec');
  await pg.click('#track-clear');
  check('layer export stays for contours with no route', await pg.locator('#route-export').isVisible());
  check('route layer button disabled without a route', await pg.locator('#export-route-btn').isDisabled());
  await pg.check('#vec-contours');
  const only = await dl('#export-svg-btn', 'o.svg');
  check('contours-only file has no route', /_contours\.svg$/.test(only.name) && !/id="route"/.test(only.text) && /<g id="contours"/.test(only.text), only.name);
  await pg.uncheck('#vec-contours'); await pg.click('#export-svg-btn');
  check('nothing selected gives a message, no file', /Nothing to export/.test(await txt('route-export-status')), await txt('route-export-status'));
  await pg.evaluate(() => { document.getElementById('view-map').click(); document.getElementById('pane-extras').open = false; });
  await pg.waitForTimeout(100);
  await pg.evaluate(() => { document.getElementById('pane-extras').open = true; }); await pg.waitForTimeout(200);
  check('opening the toppings step switches to the heightmap view', (await pg.getAttribute('#view-hm', 'aria-pressed')) === 'true');
  // STL mesh
  const stlInfo = await txt('stl-info'); check('STL info gives size and triangle count', /million triangles/.test(stlInfo), stlInfo);
  await pg.fill('#stl-detail', '60');
  const stl = await (async () => { const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click('#export-stl-btn')]); const out = S + '/ct_m.stl'; await d.saveAs(out); return { name: d.suggestedFilename(), buf: fs.readFileSync(out) }; })();
  const nTri = stl.buf.readUInt32LE(80);
  check('STL file is binary with a consistent size', stl.buf.length === 84 + 50 * nTri && nTri > 1000 && /\.stl$/.test(stl.name), stl.name + ' ' + nTri);
  // Layered map
  await pg.click('#tab-layers');
  check('layers export enabled with elevation and a carve size', !(await pg.locator('#layers-svg-btn').isDisabled()), await txt('layers-info'));
  check('layers info gives the layer count and height step', /10 layers, each about/.test(await txt('layers-info')), await txt('layers-info'));
  await pg.fill('#layer-count', '5');
  const ls = await dl('#layers-svg-btn', 'l.svg'), ld = await dl('#layers-dxf-btn', 'l.dxf');
  check('layers file name says layer count', /_5layers\.svg$/.test(ls.name), ls.name);
  check('layers SVG has numbered groups', (ls.text.match(/<g id="layer-\d\d"/g) || []).length >= 2, String((ls.text.match(/<g id="layer-\d\d"/g) || []).length));
  check('layers DXF has CUT layer', /\nCUT\n/.test(ld.text));
  console.log('page errors:', errs); await b.close(); process.exit(0);
});
