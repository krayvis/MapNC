// Tiling in the app: the step 4 suggestion, the step 5 tile export (ZIP of PNGs), shared window, border on the outer edges only.
global.self = global;
const T = require('../js/tiles.js');
const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const zlib = require('zlib'), cp = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

const chunks = (buf) => { const out = []; let o = 8; while (o < buf.length) { const len = buf.readUInt32BE(o); out.push({ type: buf.toString('latin1', o + 4, o + 8), body: buf.subarray(o + 8, o + 8 + len) }); o += 12 + len; } return out; };
const decode = (buf) => {
  const cs = chunks(buf), ih = cs.find((c) => c.type === 'IHDR').body, w = ih.readUInt32BE(0), h = ih.readUInt32BE(4), bits = ih[8], ch = ih[9] === 6 ? 4 : 1;
  const raw = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.body))), rb = w * ch * (bits / 8), px = Buffer.alloc(h * rb);
  for (let y = 0; y < h; y++) for (let i = 0; i < rb; i++) px[y * rb + i] = (raw[y * (rb + 1) + 1 + i] + (raw[y * (rb + 1)] === 2 && y ? px[(y - 1) * rb + i] : 0)) & 255;
  const text = {}; for (const c of cs.filter((q) => q.type === 'tEXt')) { const s = c.body.toString('latin1'), z = s.indexOf('\0'); text[s.slice(0, z)] = s.slice(z + 1); }
  return { w, h, bits, ch, px, text };
};

(async () => {
  const srv = http.createServer((q2, r2) => { const p = path.join(require('./lib.js').ROOT, q2.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q2.url.split('?')[0])); fs.readFile(p, (er, d) => { if (er) { r2.statusCode = 404; r2.end(); } else { r2.setHeader('Content-Type', { js: 'text/javascript', css: 'text/css', html: 'text/html', gpx: 'application/gpx+xml' }[p.split('.').pop()] || 'image/png'); r2.end(d); } }); });
  await new Promise((res) => srv.listen(8154, res));
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap/, (rt) => rt.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south)) + 30 * Math.sin(i / 40) * Math.cos(j / 55);
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); await pg.addInitScript(() => { window.__MAPNC_FREE_PANES = true; });
  const errs = []; pg.on('pageerror', (er) => errs.push(er.message));
  await pg.goto('http://localhost:8154/'); await pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const txt = (id) => pg.locator('#' + id).innerText();
  const dims = await pg.evaluate(() => ({ w: window.MapNC.elevation.width, h: window.MapNC.elevation.height }));
  const settle = () => pg.waitForTimeout(250);

  await pg.evaluate(() => { document.getElementById('pane-output').open = true; document.getElementById('pane-export').open = true; });
  check('the tiling fields start empty with a hint, and no tile export is offered', (await pg.inputValue('#piece-size')) === '' && /largest piece/.test(await txt('tile-note')) && !(await pg.isVisible('#tile-export')));
  await pg.fill('#carve-size', '24'); await pg.selectOption('#carve-unit', 'in'); await settle();
  check('a carve size alone leaves the hint', /largest piece/.test(await txt('tile-note')) && !(await pg.isVisible('#tile-export')));
  await pg.fill('#piece-size', '40'); await settle();
  check('a piece bigger than the carve: no tiling needed', /fits in one piece/.test(await txt('tile-note')) && !(await pg.isVisible('#tile-export')), await txt('tile-note'));

  await pg.fill('#piece-size', '10'); await pg.fill('#tile-overlap', '0.25'); await settle();
  const want = T.planTiles({ W: dims.w, H: dims.h, mmPerPx: 24 * 25.4 / Math.max(dims.w, dims.h), maxPieceMm: 254, overlapMm: 6.35 });
  const note = await txt('tile-note');
  check('the suggestion names the tile grid', want.needed && new RegExp('Tiling suggested').test(note) && note.includes(want.cols + ' × ' + want.rows + ' tiles (' + want.count + ')'), note);
  check('it gives tile size in the carve unit, pixels and the overlap', /in × [\d.]+ in \(\d+ × \d+ px/.test(note) && /overlapping by at least 0\.2\d in/.test(note), note);
  check('the step 5 tile export appears with the same count', (await pg.isVisible('#tile-export')) && (await txt('tile-export-info')).includes(want.cols + ' × ' + want.rows + ' tiles'), await txt('tile-export-info'));
  check('the route checkbox shows because a route is loaded', await pg.isVisible('#tile-route'));
  check('the unit labels follow the carve unit', (await pg.locator('.carve-unit-name').first().innerText()) === 'in');
  await pg.selectOption('#carve-unit', 'mm'); await settle();
  check('switching to mm keeps the numbers as typed and re-plans', (await pg.locator('.carve-unit-name').first().innerText()) === 'mm' && /Tiling suggested|fits in one piece/.test(await txt('tile-note')), await txt('tile-note'));
  await pg.selectOption('#carve-unit', 'in'); await settle();

  await pg.fill('#piece-size', '0.1'); await settle();
  check('a tiny piece is refused with a message', /smaller than 16 pixels|tiles/.test(await txt('tile-note')) && !(await pg.isVisible('#tile-export')) && /warning/.test(await pg.getAttribute('#tile-note', 'class')), await txt('tile-note'));
  await pg.fill('#piece-size', '10'); await settle();

  // a rim on the outer edge, so we can see it lands on the outer edges only
  await pg.selectOption('#border-style', 'rim'); await pg.fill('#border-width', '10'); await settle();

  // ---- export the tiles
  const dl = pg.waitForEvent('download', { timeout: 120000 });
  await pg.click('#export-tiles-btn');
  const download = await dl, zipPath = await download.path();
  await pg.waitForFunction(() => /Saved/.test(document.getElementById('tile-export-status').textContent), null, { timeout: 60000 });
  check('the status reports the saved ZIP', /Saved .*_tiles_\d+x\d+\.zip \(\d+ tiles/.test(await txt('tile-export-status')), await txt('tile-export-status'));
  check('the file is named for the tile grid', new RegExp('_tiles_' + want.cols + 'x' + want.rows + '\\.zip$').test(download.suggestedFilename()), download.suggestedFilename());
  const dir = path.join(S, 'tiles-unzipped'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const un = cp.spawnSync('unzip', ['-q', '-o', zipPath, '-d', dir], { encoding: 'utf8' });
  const files = fs.readdirSync(dir).sort();
  check('the ZIP opens', un.status === 0, un.stderr);
  const heights = files.filter((n) => /_r\d+c\d+_\d+x\d+_16bit\.png$/.test(n)), routes = files.filter((n) => /_route\.png$/.test(n));
  const dxfs = files.filter((n) => /_vectors\.dxf$/.test(n));
  check('one heightmap PNG, route PNG and DXF per tile, plus tiles.txt', heights.length === want.count && routes.length === want.count && dxfs.length === want.count && files.includes('tiles.txt') && files.length === 3 * want.count + 1, files.length + ' files');
  const dxfVerts = (txt2, layer) => { const t = txt2.split('\n'), out = []; let on = false, cur = null; for (let i = 0; i + 1 < t.length; i += 2) { const c = t[i], v = t[i + 1]; if (c === '0' && v === 'VERTEX') { cur = {}; out.push(cur); on = true; } else if (c === '0') on = false; else if (on && c === '8') cur.layer = v; else if (on && c === '10') cur.x = +v; else if (on && c === '20') cur.y = +v; } return out.filter((q) => q.layer === layer); };
  const mmPx = 24 * 25.4 / Math.max(dims.w, dims.h);
  let inFrame = true, withRoute = 0, markSpan = true;
  for (const t of want.tiles) {
    const d = fs.readFileSync(path.join(dir, dxfs.find((n) => n.includes('_' + t.name + '_'))), 'utf8'), r = dxfVerts(d, 'ROUTE'), m = dxfVerts(d, 'CORNER_MARKS');
    if (r.length) withRoute++;
    if (!r.every((q) => q.x >= -1e-6 && q.x <= t.w * mmPx + 1e-3 && q.y >= -1e-6 && q.y <= t.h * mmPx + 1e-3)) inFrame = false;
    if (m.length && (Math.max(...m.map((q) => q.x)) < t.w * mmPx - 1e-2 || Math.max(...m.map((q) => q.y)) < t.h * mmPx - 1e-2)) markSpan = false;
  }
  check('every tile DXF keeps the route inside its own frame, in mm', inFrame && withRoute >= 2 && withRoute <= want.count, withRoute + ' tiles hold route');
  check('the corner marks sit on each tile\'s own corners', markSpan);

  const grey = await pg.evaluate(() => ({ data: Array.from(window.MapNC.grey.data), lo: window.MapNC.grey.lo, hi: window.MapNC.grey.hi, border: window.MapNC.grey.border }));
  let allSame = true, windows = new Set(), sizes = new Set(), badTile = '';
  for (const t of want.tiles) {
    const name = heights.find((n) => n.includes('_' + t.name + '_')), d = decode(fs.readFileSync(path.join(dir, name)));
    windows.add(d.text.ElevationWindowM); sizes.add(d.w + 'x' + d.h);
    for (let y = 0; y < t.h && allSame; y++) for (let x = 0; x < t.w; x++) if (d.px.readUInt16BE((y * t.w + x) * 2) !== grey.data[(t.y0 + y) * dims.w + t.x0 + x]) { allSame = false; badTile = t.name + ' at ' + x + ',' + y; break; }
  }
  check('every tile holds exactly its window of the finished heightmap (border and all)', allSame, badTile);
  check('all tiles share one elevation window and one size', windows.size === 1 && [...windows][0] === grey.lo.toFixed(3) + ',' + grey.hi.toFixed(3) && sizes.size === 1, [...windows].join(' | ') + ' / ' + [...sizes].join(' | '));
  const topLeft = decode(fs.readFileSync(path.join(dir, heights.find((n) => n.includes('_r1c1_')))));
  const inner = want.tiles.find((t) => t.row === 2 && t.col === 2) || want.tiles[want.tiles.length - 1];
  const innerPng = decode(fs.readFileSync(path.join(dir, heights.find((n) => n.includes('_' + inner.name + '_')))));
  check('the rim is on the outer edge of the first tile', topLeft.px.readUInt16BE(0) === 65535);
  check('an inner corner of a tile is terrain, not rim (no border on the seams)', want.rows > 1 && want.cols > 1 ? innerPng.px.readUInt16BE(0) !== 65535 : true);
  check('each tile records its name, place and the pixel density', /^r1c1 of \d+x\d+$/.test(topLeft.text.Tile) && topLeft.text.TileOffsetMm === '0.000,0.000' && /^[\d.-]+,[\d.-]+,[\d.-]+,[\d.-]+$/.test(topLeft.text.Bounds) && topLeft.text.Bounds !== topLeft.text.WholeBounds, JSON.stringify(topLeft.text).slice(0, 220));

  // the route layer tiles: the same drawing as the whole-grid route layer, cut into windows
  const dl2 = pg.waitForEvent('download', { timeout: 60000 });
  await pg.evaluate(() => { document.getElementById('pane-extras').open = true; });
  await pg.click('#export-route-btn');
  const whole = decode(fs.readFileSync(await (await dl2).path()));
  check('the whole route layer is the heightmap grid size', whole.w === dims.w && whole.h === dims.h && whole.ch === 4, whole.w + 'x' + whole.h);
  let worst = 0, drawn = 0;
  for (const t of want.tiles) {
    const d = decode(fs.readFileSync(path.join(dir, routes.find((n) => n.includes('_' + t.name + '_')))));
    if (d.w !== t.w || d.h !== t.h) { worst = 999; break; }
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
      const a = d.px[(y * t.w + x) * 4 + 3], bb = whole.px[((t.y0 + y) * dims.w + t.x0 + x) * 4 + 3];
      if (a) drawn++;
      worst = Math.max(worst, Math.abs(a - bb));
    }
  }
  check('route tiles match the whole route layer cut the same way', worst <= 2 && drawn > 100, 'worst alpha difference ' + worst + ', ' + drawn + ' drawn pixels');
  const lay = fs.readFileSync(path.join(dir, 'tiles.txt'), 'utf8');
  check('tiles.txt lists every tile with its offsets and the shared window', want.tiles.every((t) => lay.includes(t.name)) && /Elevation window shared by every tile/.test(lay) && /Edge border \(rim, 10 mm\)/.test(lay), lay.split('\n').slice(0, 9).join(' / '));

  // turning the route checkbox off leaves heightmap tiles only
  await pg.evaluate(() => { document.getElementById('pane-export').open = true; });
  await pg.uncheck('#tile-route');
  const dl3 = pg.waitForEvent('download', { timeout: 120000 });
  await pg.click('#export-tiles-btn'); await dl3;
  await pg.waitForFunction(() => /Saved/.test(document.getElementById('tile-export-status').textContent), null, { timeout: 60000 });
  const un2 = cp.spawnSync('unzip', ['-Z1', await (await dl3).path()], { encoding: 'utf8' }).stdout.trim().split('\n');
  check('without the route box the ZIP has no route PNGs', un2.length === 2 * want.count + 1 && !un2.some((n) => /route/.test(n)), un2.length + ' entries');
  await pg.uncheck('#tile-vectors');
  const dl5 = pg.waitForEvent('download', { timeout: 120000 });
  await pg.click('#export-tiles-btn'); const d5 = await dl5;
  await pg.waitForFunction(() => /Saved/.test(document.getElementById('tile-export-status').textContent), null, { timeout: 60000 });
  const un3 = cp.spawnSync('unzip', ['-Z1', await d5.path()], { encoding: 'utf8' }).stdout.trim().split('\n');
  check('with both boxes off: heightmap tiles and tiles.txt only', un3.length === want.count + 1 && un3.every((n) => /_16bit\.png$|^tiles\.txt$/.test(n)), un3.length + ' entries');

  // the plain whole-heightmap export is still there and still one file
  const dl4 = pg.waitForEvent('download'); await pg.click('#export-btn');
  const one = decode(fs.readFileSync(await (await dl4).path()));
  check('the ordinary export is still the whole heightmap', one.w === dims.w && one.h === dims.h);

  console.log('page errors:', errs); await b.close(); srv.close(); process.exit(0);
})().catch((er) => { console.log('FAIL exception ' + er.stack); process.exit(1); });
