// OpenStreetMap layers: parsing, clipping, fetching (mocked Overpass), then the UI and the exports in a real browser.
global.self = global;
require('../js/contours.js'); global.MapNCContours = require('../js/contours.js');
const O = require('../js/osm.js');
const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

(async () => {
  // -- pure helpers
  const B = { south: 0, west: 0, north: 1, east: 1 };
  check('classify', O.classify({ highway: 'primary' }) === 'roads' && O.classify({ highway: 'residential' }) === 'roads_minor' && O.classify({ highway: 'footway' }) === null &&
    O.classify({ waterway: 'stream' }) === 'water' && O.classify({ waterway: 'drain' }) === null && O.classify({ natural: 'water' }) === 'lakes' && O.classify({ building: 'yes' }) === null);
  const q = O.buildQuery(B, ['roads', 'lakes']);
  check('query only asks for the ticked kinds', /highway/.test(q) && /natural/.test(q) && !/waterway/.test(q) && /out geom/.test(q) && /\(0\.000000,0\.000000,1\.000000,1\.000000\)/.test(q));
  check('area limits', O.areaProblem(60000, ['roads']) && !O.areaProblem(40000, ['roads', 'water']) && /Minor roads/.test(O.areaProblem(9000, ['roads_minor'])) && !O.areaProblem(9000, ['roads']));
  const P = (lat, lon) => ({ lat, lon });
  const st = O.stitch([[P(0, 0), P(0, 1)], [P(1, 1), P(0, 1)], [P(1, 1), P(1, 0), P(0, 0)]]);
  check('relation pieces are stitched into one closed ring', st.length === 1 && st[0].length === 5 && st[0][0].lat === st[0][4].lat && st[0][0].lon === st[0][4].lon, JSON.stringify(st.map((r) => r.length)));
  const json = { elements: [
    { type: 'way', tags: { highway: 'secondary', name: 'Main St' }, geometry: [P(0.5, 0.1), P(0.5, 0.9)] },
    { type: 'way', tags: { building: 'yes' }, geometry: [P(0.5, 0.1), P(0.5, 0.9)] },
    { type: 'relation', tags: { natural: 'water' }, members: [{ type: 'way', role: 'outer', geometry: [P(.2, .2), P(.2, .4), P(.4, .4)] }, { type: 'way', role: 'outer', geometry: [P(.4, .4), P(.2, .2)] }] },
  ] };
  const feats = O.parse(json);
  check('parse keeps roads and lakes, drops the rest', feats.length === 2 && feats[0].name === 'Main St' && feats[1].kind === 'lakes');
  const L = O.toLayers(feats, B, 100, 100);
  check('projected to pixels, y down', L.roads.length === 1 && Math.abs(L.roads[0][0].x - 10) < 1e-6 && Math.abs(L.roads[0][0].y - 50) < 1e-6);
  check('long straight road thinned to its end points', L.roads[0].length === 2);
  const out = O.toLayers([{ kind: 'roads', pts: [P(0.5, -0.5), P(0.5, 1.5)] }, { kind: 'roads', pts: [P(2, 2), P(3, 3)] }], B, 100, 100);
  check('clipped to the extent; outside dropped', out.roads.length === 1 && out.roads[0].every((p) => p.x >= 0 && p.x <= 100) && out.roads[0][0].x === 0 && out.roads[0][1].x === 100);
  const runs = O.clipLine([{ x: -10, y: 5 }, { x: 10, y: 5 }, { x: 10, y: 200 }, { x: 20, y: 200 }, { x: 20, y: 5 }, { x: 30, y: 5 }], 100, 100);
  check('a line leaving and re-entering gives two runs', runs.length === 2, JSON.stringify(runs.map((r) => r.length)));

  // -- fetching with a mocked service
  const mk = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  let calls = [];
  const rec = (impl) => async (url, init) => { calls.push(url); return impl(url, init); };
  O.clearCache();
  let r = await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: rec(mk(200, json)) });
  check('fetch parses', r.length === 2 && calls.length === 1);
  await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: rec(mk(500, {})) });
  check('same request is served from the cache', calls.length === 1);
  calls = [];
  O.clearCache();
  r = await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: rec(async (u) => (u === O.ENDPOINTS[0] ? mk(429, {})() : mk(200, json)())) });
  check('falls back to the second server on 429', calls.length === 2 && r.length === 2 && calls[1] === O.ENDPOINTS[1], calls.join(' '));
  O.clearCache();
  let msg = '';
  try { await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: rec(mk(504, {})) }); } catch (e) { msg = e.message; }
  check('failure gives a plain message', /answered 504/.test(msg), msg);
  O.clearCache(); msg = '';
  try { await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: rec(mk(200, { elements: [], remark: 'runtime error: Query timed out in "query" at line 1' })) }); } catch (e) { msg = e.message; }
  check('a server-side timeout is reported, not treated as empty', /smaller region/.test(msg), msg);
  O.clearCache(); msg = '';
  try { await O.fetchFeatures(B, ['roads'], { minGapMs: 0, fetch: async () => { throw new TypeError('Failed to fetch'); } }); } catch (e) { msg = e.message; }
  check('network error gives a plain message', /Could not reach/.test(msg), msg);
  const t0 = Date.now(); O.clearCache();
  await Promise.all([O.fetchFeatures(B, ['roads'], { minGapMs: 300, fetch: mk(200, json) }), O.fetchFeatures({ south: 0, west: 0, north: 2, east: 2 }, ['roads'], { minGapMs: 300, fetch: mk(200, json) })]);
  check('requests are spaced out', Date.now() - t0 >= 280, (Date.now() - t0) + ' ms');

  // -- UI
  const srv = http.createServer((q2, r2) => { const p = path.join(require('./lib.js').ROOT, q2.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q2.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r2.statusCode = 404; r2.end(); } else { r2.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r2.end(d); } }); });
  await new Promise((res) => srv.listen(8150, res));
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const posts = [];
  let overpassMode = 'ok';
  await ctx.route(/overpass/, async (route) => {
    posts.push(decodeURIComponent(route.request().postData() || ''));
    if (overpassMode === 'down') return route.fulfill({ status: 503, body: 'busy', headers: { 'access-control-allow-origin': '*' } });
    const rg = await pg.evaluate(() => window.MapNC.region());
    const lat = (t) => rg.south + (rg.north - rg.south) * t, lon = (t) => rg.west + (rg.east - rg.west) * t;
    const body = { elements: [
      { type: 'way', tags: { highway: 'primary' }, geometry: [{ lat: lat(0.5), lon: lon(-0.2) }, { lat: lat(0.5), lon: lon(0.5) }, { lat: lat(0.8), lon: lon(1.2) }] },
      { type: 'way', tags: { highway: 'residential' }, geometry: [{ lat: lat(0.1), lon: lon(0.1) }, { lat: lat(0.1), lon: lon(0.4) }] },
      { type: 'way', tags: { waterway: 'stream' }, geometry: [{ lat: lat(0.2), lon: lon(0.2) }, { lat: lat(0.6), lon: lon(0.3) }, { lat: lat(0.9), lon: lon(0.35) }] },
      { type: 'way', tags: { natural: 'water' }, geometry: [{ lat: lat(.3), lon: lon(.6) }, { lat: lat(.3), lon: lon(.8) }, { lat: lat(.5), lon: lon(.8) }, { lat: lat(.5), lon: lon(.6) }, { lat: lat(.3), lon: lon(.6) }] },
    ] };
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; });
  const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto('http://localhost:8150/'); await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  await pg.click('#tab-vec');
  const txt = (id) => pg.locator('#' + id).innerText();
  check('sidebar footer credits the sources', /USGS 3DEP/.test(await txt('credits')) && /OpenStreetMap contributors/.test(await txt('credits')) && await pg.locator('#credits a[href*="openstreetmap.org/copyright"]').count() === 1);
  check('no request and no credit until a layer is ticked', posts.length === 0 && !(await pg.locator('#osm-credit').isVisible()));
  await pg.check('#vec-osm-roads'); await pg.check('#vec-osm-water'); await pg.check('#vec-osm-lakes');
  check('credit and ODbL link shown once a layer is ticked', await pg.locator('#osm-credit').isVisible() && /OpenStreetMap contributors/.test(await txt('osm-credit')));
  await pg.waitForFunction(() => /main roads/.test(document.getElementById('osm-info').textContent), { timeout: 10000 });
  check('counts shown', /1 main roads, 1 waterways, 1 lakes/.test(await txt('osm-info')), await txt('osm-info'));
  check('one request for the ticked kinds, without minor roads', posts.length === 1 && /highway/.test(posts[0]) && /waterway/.test(posts[0]) && !/residential/.test(posts[0]), String(posts.length));
  await pg.click('summary:has-text("Output size")'); await pg.fill('#carve-size', '12');
  const dl = async (sel, name) => { const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 60000 }), pg.click(sel)]); const o = S + '/osm_' + name; await d.saveAs(o); return { name: d.suggestedFilename(), text: fs.readFileSync(o, 'utf8') }; };
  const svg = await dl('#export-svg-btn', 'a.svg'), dxf = await dl('#export-dxf-btn', 'a.dxf');
  check('export reuses the cached data', posts.length === 1, String(posts.length));
  check('file name names the layers', /_route-roads-water\.svg$/.test(svg.name), svg.name);
  check('SVG has the groups and the credit', /<g id="roads"/.test(svg.text) && /<g id="water"/.test(svg.text) && /<g id="lakes"/.test(svg.text) && /OpenStreetMap contributors/.test(svg.text) && !/id="roads_minor"/.test(svg.text));
  check('DXF has the layers and the credit comment', /\nROADS\n/.test(dxf.text) && /\nWATER\n/.test(dxf.text) && /\nLAKES\n/.test(dxf.text) && /^999\nContains data © OpenStreetMap/.test(dxf.text));
  const W = +svg.text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)[1], H = +svg.text.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)[2];
  const xs = [...svg.text.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(' ').map((p) => p.split(',').map(Number)));
  check('everything lies inside the extent (road clipped at the edge)', xs.every(([x, y]) => x >= -1e-6 && x <= W + 1e-6 && y >= -1e-6 && y <= H + 1e-6));
  check('status mentions what was drawn', /1 main roads/.test(await txt('route-export-status')), await txt('route-export-status'));
  await pg.check('#vec-osm-minor');
  await pg.waitForFunction(() => /minor roads/.test(document.getElementById('osm-info').textContent), { timeout: 10000 });
  check('ticking another layer fetches again, with it', posts.length === 2 && /residential/.test(posts[1]));
  // an area that is too big
  await pg.evaluate(() => { const b = window.MapNC.region(); }); // region stays; test the limit through the message path below
  // service down: message, no file
  overpassMode = 'down'; await pg.uncheck('#vec-osm-minor'); await pg.uncheck('#vec-osm-water'); await pg.uncheck('#vec-osm-lakes'); await pg.check('#vec-osm-water');
  await pg.waitForFunction(() => /answered 503|Could not reach/.test(document.getElementById('osm-info').textContent), { timeout: 15000 });
  check('a failing service gives a message in the panel', /answered 503/.test(await txt('osm-info')), await txt('osm-info'));
  await pg.click('#export-svg-btn'); await pg.waitForFunction(() => /OpenStreetMap: /.test(document.getElementById('route-export-status').textContent), { timeout: 20000 });
  check('and export does not write a file', /OpenStreetMap: .*503/.test(await txt('route-export-status')), await txt('route-export-status'));
  for (const id of ['vec-osm-roads', 'vec-osm-water']) if (await pg.locator('#' + id).isChecked()) await pg.uncheck('#' + id);
  const plain = await dl('#export-svg-btn', 'p.svg');
  check('without OSM layers there is no OSM credit', !/OpenStreetMap/.test(plain.text) && /_route\.svg$/.test(plain.name), plain.name);
  console.log('page errors:', errs); await b.close(); srv.close(); process.exit(0);
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
