// 3D terrain view: pure helpers, then the WebGL view in a real browser (software GL).
const { chromium } = require('./lib.js').playwright;
const T = require('../js/terrain3d.js');
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

// -- helpers
const mp = T.metresPerDegree(0), mp60 = T.metresPerDegree(60);
check('metres per degree at the equator', Math.abs(mp.lat - 110574) < 5 && Math.abs(mp.lng - 111320) < 5, JSON.stringify(mp));
check('longitude degree halves at 60N', Math.abs(mp60.lng / mp.lng - 0.5) < 0.01);
const d = new Float32Array(1000 * 600).fill(5); d[0] = NaN;
const g = T.reduceGrid(d, 1000, 600, 512);
check('grid reduced to the side cap', g.stride === 2 && g.gw === 500 && g.gh === 300, [g.stride, g.gw, g.gh].join(','));
check('averaging keeps values and ignores no-data', g.min === 5 && g.max === 5 && g.h[0] === 5);
const nd = new Float32Array(16).fill(NaN);
check('all no-data gives NaN cells', T.reduceGrid(nd, 4, 4, 512).h.every((v) => v !== v));
check('small grids are not reduced', T.reduceGrid(new Float32Array(100), 10, 10, 512).stride === 1);

http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, dd) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r.end(dd); } }); }).listen(8149, async () => {
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(Object.assign({}, require('./lib.js').launchOpts, { args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }));
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.route(/tile\.openstreetmap/, r => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; }); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:8149/');
  check('3D disabled before elevation', await pg.locator('#view-3d').isDisabled());
  await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  check('3D enabled with elevation', !(await pg.locator('#view-3d').isDisabled()));
  await pg.click('#view-3d');
  check('3D view shown, map hidden', await pg.locator('#t3-view').isVisible() && !(await pg.locator('#map').isVisible()) && (await pg.getAttribute('#view-3d', 'aria-pressed')) === 'true');
  const st = () => pg.evaluate(() => window.MapNC.t3 && window.MapNC.t3.state);
  const s0 = await st();
  if (!s0) { check('WebGL available in this browser', false, await pg.locator('#t3-msg').innerText()); console.log('page errors:', errs); await b.close(); process.exit(0); }
  check('mesh built from the grid', s0.mesh && s0.triangles > 100, JSON.stringify([s0.grid, s0.triangles]));
  await pg.waitForTimeout(300);
  // pixel stats from the canvas: coloured (non-transparent) share, and red route pixels
  const px = () => pg.evaluate(() => {
    const c = document.getElementById('t3-canvas'), t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0); const d = x.getImageData(0, 0, t.width, t.height).data;
    let on = 0, red = 0, sum = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { on++; sum += d[i] + d[i + 1] + d[i + 2]; if (d[i] > 190 && d[i + 1] < 70 && d[i + 2] < 100) red++; }
    return { on, red, total: d.length / 4, avg: on ? sum / on / 3 : 0 };
  });
  const p0 = await px();
  check('terrain is drawn', p0.on > p0.total * 0.15, JSON.stringify(p0));
  check('route is drawn on it', p0.red > 30 && s0.route, 'red=' + p0.red);
  await pg.uncheck('#t3-route'); await pg.waitForTimeout(300);
  check('route can be hidden', (await px()).red === 0);
  await pg.check('#t3-route'); await pg.waitForTimeout(300);
  // orbit by dragging
  const box = await pg.locator('#t3-canvas').boundingBox(), cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 120, cy + 40, { steps: 6 }); await pg.mouse.up();
  const s1 = await st();
  check('dragging rotates the view', Math.abs(s1.yaw - s0.yaw) > 0.5 && s1.pitch !== s0.pitch, [s0.yaw, s1.yaw, s0.pitch, s1.pitch].map(v => v.toFixed(2)).join(' '));
  await pg.mouse.move(cx, cy); await pg.mouse.wheel(0, -300); await pg.waitForTimeout(100);
  const s2 = await st();
  check('wheel zooms in', s2.dist < s1.dist, s1.dist.toFixed(0) + ' -> ' + s2.dist.toFixed(0));
  await pg.keyboard.down('Shift'); await pg.mouse.move(cx, cy); await pg.mouse.down(); await pg.mouse.move(cx + 80, cy, { steps: 4 }); await pg.mouse.up(); await pg.keyboard.up('Shift');
  const s3 = await st();
  check('shift-drag pans', Math.hypot(s3.target[0] - s2.target[0], s3.target[2] - s2.target[2]) > 1 && s3.yaw === s2.yaw);
  await pg.fill('#t3-exag', '6'); await pg.dispatchEvent('#t3-exag', 'input');
  check('exaggeration slider applies', (await st()).exag === 6 && (await txt('t3-exag-out')) === '6×');
  async function txt(id) { return pg.locator('#' + id).innerText(); }
  const p6 = await px();
  check('exaggeration changes the picture', Math.abs(p6.on - p0.on) > 50 || Math.abs(p6.avg - p0.avg) > 0.5, JSON.stringify([p0.on, p6.on]));
  await pg.screenshot({ path: S + '/t3-exag6.png' });
  await pg.click('#t3-reset');
  const s4 = await st();
  check('reset view restores the camera', Math.abs(s4.yaw - s0.yaw) < 1e-6 && Math.abs(s4.dist - s0.dist) < 1e-3 * s0.dist);
  // touch: two-finger pinch via synthetic pointer events
  await pg.evaluate(() => {
    const c = document.getElementById('t3-canvas'), r = c.getBoundingClientRect();
    const ev = (t, id, x, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', clientX: r.x + x, clientY: r.y + y, bubbles: true, button: 0 }));
    c.setPointerCapture = () => {};
    ev('pointerdown', 1, 300, 300); ev('pointerdown', 2, 400, 300);
    ev('pointermove', 1, 200, 300); ev('pointermove', 2, 500, 300);
    ev('pointerup', 1, 200, 300); ev('pointerup', 2, 500, 300);
  });
  const s5 = await st();
  check('pinch zooms in', s5.dist < s4.dist, s4.dist.toFixed(0) + ' -> ' + s5.dist.toFixed(0));
  check('canvas owns touch gestures', (await pg.evaluate(() => getComputedStyle(document.getElementById('t3-canvas')).touchAction)) === 'none');
  await pg.click('#view-map');
  check('back to the map', await pg.locator('#map').isVisible() && !(await pg.locator('#t3-view').isVisible()));
  await pg.click('#show-hm'); await pg.click('#view-3d');
  check('switches heightmap to 3D', await pg.locator('#t3-view').isVisible() && !(await pg.locator('#hm-view').isVisible()));
  await pg.click('#view-map');
  await pg.click('summary:has-text("Clean up")'); await pg.click('#edit-toggle');
  check('editing returns to the map and disables 3D', await pg.locator('#map').isVisible() && await pg.locator('#view-3d').isDisabled());
  console.log('page errors:', errs); await b.close(); process.exit(0);
});
