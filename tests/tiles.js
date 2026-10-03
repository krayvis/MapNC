// Tiling: the layout maths, tile bounds, line clipping, the windowed PNG encode and the ZIP writer.
const zlib = require('zlib'), fs = require('fs'), path = require('path'), cp = require('child_process');
const V = require('../js/vector.js'), T = require('../js/tiles.js'), HM = require('../js/heightmap.js'), Zip = require('../js/zip.js'), Track = require('../js/track.js');
const OUT = require('./lib.js').OUT;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

const chunks = (buf) => { const out = []; let o = 8; while (o < buf.length) { const len = buf.readUInt32BE(o); out.push({ type: buf.toString('latin1', o + 4, o + 8), body: buf.subarray(o + 8, o + 8 + len) }); o += 12 + len; } return out; };
const decode = (buf) => {
  const cs = chunks(buf), ih = cs.find((c) => c.type === 'IHDR').body, w = ih.readUInt32BE(0), h = ih.readUInt32BE(4), bits = ih[8], ch = ih[9] === 6 ? 4 : 1;
  const raw = zlib.inflateSync(Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.body))), rb = w * ch * (bits / 8), px = Buffer.alloc(h * rb);
  for (let y = 0; y < h; y++) for (let i = 0; i < rb; i++) px[y * rb + i] = (raw[y * (rb + 1) + 1 + i] + (raw[y * (rb + 1)] === 2 && y ? px[(y - 1) * rb + i] : 0)) & 255;
  return { w, h, bits, px, cs };
};

(async () => {
  // ---- the plan
  let p = T.planTiles({ W: 3000, H: 2000, mmPerPx: 0 });
  check('no carve size: one tile, not needed', !p.needed && p.count === 1 && p.tiles[0].w === 3000);
  p = T.planTiles({ W: 3000, H: 2000, mmPerPx: 0.2 });
  check('no largest piece: one tile', !p.needed && p.count === 1);
  p = T.planTiles({ W: 3000, H: 2000, mmPerPx: 0.2, maxPieceMm: 700 });
  check('a carve inside the piece needs no tiles', !p.needed && p.carveWmm === 600 && p.carveHmm === 400);
  p = T.planTiles({ W: 3000, H: 2000, mmPerPx: 0.2, maxPieceMm: 300, overlapMm: 5 });
  check('600 x 400 mm in 300 mm pieces with 5 mm overlap: 3 x 2', p.needed && p.cols === 3 && p.rows === 2 && p.count === 6, p.cols + 'x' + p.rows);
  check('every tile is the same size and fits the piece', p.tiles.every((t) => t.w === p.tileW && t.h === p.tileH) && p.tileW * 0.2 <= 300 && p.tileH * 0.2 <= 300, p.tileW + 'x' + p.tileH);
  check('tiles run row by row from the top-left and are named r<row>c<col>', p.tiles[0].name === 'r1c1' && p.tiles[1].name === 'r1c2' && p.tiles[3].name === 'r2c1' && p.tiles[5].name === 'r2c3');
  check('the first tile starts at 0 and the last ends at the edge', p.tiles[0].x0 === 0 && p.tiles[0].y0 === 0 && p.tiles[5].x0 + p.tiles[5].w === 3000 && p.tiles[5].y0 + p.tiles[5].h === 2000);
  check('the overlap is at least the 5 mm asked for', p.minOverlapPx * 0.2 >= 5 - 1e-9, p.minOverlapPx * 0.2 + ' mm');
  p = T.planTiles({ W: 3000, H: 2000, mmPerPx: 0.2, maxPieceMm: 300 });
  check('zero overlap still covers with butt joints', p.needed && p.tiles.filter((t) => t.row === 1).reduce((n, t) => Math.max(n, t.x0 + t.w), 0) === 3000 && p.minOverlapPx >= 0);
  p = T.planTiles({ W: 3000, H: 1000, mmPerPx: 0.2, maxPieceMm: 400 });
  check('a long thin carve tiles one way only', p.cols === 2 && p.rows === 1 && p.tileH === 1000, p.cols + 'x' + p.rows);

  // property: any inputs give full coverage, pieces that fit, overlap at least asked, and no gaps
  let bad = '', cases = 0;
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < 3000 && !bad; i++) {
    const W = Math.round(rnd(200, 9000)), H = Math.round(rnd(200, 9000)), k = rnd(0.05, 1), max = rnd(60, 1500), ov = Math.random() < 0.3 ? 0 : rnd(0, max / 3);
    const q = T.planTiles({ W, H, mmPerPx: k, maxPieceMm: max, overlapMm: ov });
    if (q.error) continue;
    cases++;
    const cover = (axis, L) => {
      const starts = [...new Set(q.tiles.map((t) => (axis === 'x' ? t.x0 : t.y0)))].sort((a, b) => a - b), size = axis === 'x' ? q.tileW : q.tileH;
      if (starts[0] !== 0 || starts[starts.length - 1] + size !== L) return false;
      return starts.every((s, j) => !j || (s - starts[j - 1] <= size - Math.round(ov / k) && s > starts[j - 1]));
    };
    if (!q.needed ? !(W <= Math.floor(max / k) && H <= Math.floor(max / k)) : (!cover('x', W) || !cover('y', H) || q.tileW > Math.floor(max / k) || q.tileH > Math.floor(max / k) || q.cols * q.rows !== q.count)) bad = JSON.stringify({ W, H, k, max, ov, cols: q.cols, rows: q.rows, tw: q.tileW, th: q.tileH });
  }
  check('property: ' + cases + ' random plans cover the grid, fit the piece and keep the overlap', !bad && cases > 2000, bad);

  check('a piece under 16 pixels is refused', !!T.planTiles({ W: 3000, H: 2000, mmPerPx: 1, maxPieceMm: 10 }).error);
  check('an overlap of half the piece or more is refused', !!T.planTiles({ W: 3000, H: 2000, mmPerPx: 0.2, maxPieceMm: 100, overlapMm: 60 }).error);
  check('an absurd tile count is refused with advice', /tiles/.test(T.planTiles({ W: 16000, H: 16000, mmPerPx: 1, maxPieceMm: 20 }).error || ''));

  // ---- bounds
  const b = { south: 39.6, west: -120.7, north: 39.7, east: -120.5 }, W = 2000, Hh = 1000;
  p = T.planTiles({ W, H: Hh, mmPerPx: 0.25, maxPieceMm: 300, overlapMm: 4 });
  const whole = T.tileBounds(b, W, Hh, { x0: 0, y0: 0, w: W, h: Hh });
  check('a tile covering the grid has the region bounds', ['south', 'west', 'north', 'east'].every((k) => Math.abs(whole[k] - b[k]) < 1e-12));
  const tt = p.tiles[p.tiles.length - 1], tb = T.tileBounds(b, W, Hh, tt);
  check('the last tile reaches the south-east corner', Math.abs(tb.south - b.south) < 1e-12 && Math.abs(tb.east - b.east) < 1e-12);
  const pt = { lat: 39.65, lon: -120.55 }, full = Track.toPixels({ segments: [[pt]] }, b, W, Hh)[0][0], inTile = Track.toPixels({ segments: [[pt]] }, tb, tt.w, tt.h)[0][0];
  check('a point lands on the same pixel in the tile as in the whole', Math.abs(inTile.x - (full.x - tt.x0)) < 1e-6 && Math.abs(inTile.y - (full.y - tt.y0)) < 1e-6, inTile.x.toFixed(4) + ' vs ' + (full.x - tt.x0).toFixed(4));

  // ---- clipping
  const P = (...a) => a.map(([x, y]) => ({ x, y }));
  let c = T.clipPolyline(P([2, 2], [8, 8]), 0, 0, 10, 10);
  check('a line inside is kept whole', c.length === 1 && c[0].length === 2 && c[0][1].x === 8);
  c = T.clipPolyline(P([-5, 5], [15, 5]), 0, 0, 10, 10);
  check('a line through is cut at both edges', c.length === 1 && c[0][0].x === 0 && c[0][1].x === 10 && c[0][0].y === 5, JSON.stringify(c));
  c = T.clipPolyline(P([20, 20], [30, 30]), 0, 0, 10, 10);
  check('a line outside leaves nothing', c.length === 0);
  c = T.clipPolyline(P([5, 5], [15, 5], [15, 7], [5, 7]), 0, 0, 10, 10);
  check('a line that leaves and returns becomes two pieces', c.length === 2 && c[0][1].x === 10 && c[1][0].x === 10 && c[1][1].x === 5 && c[1][0].y === 7, JSON.stringify(c));
  c = T.clipPolyline(P([12, 12], [14, 14], [7, 7]), 5, 5, 10, 10);
  check('the result is moved so the window corner is the origin', c.length === 1 && c[0].length === 3 && c[0][0].x === 7 && c[0][1].y === 9 && c[0][2].x === 2, JSON.stringify(c));
  c = T.clipPolyline(P([10, 0], [10, 10]), 0, 0, 10, 10);
  check('a line along the edge is kept', c.length === 1 && c[0].length === 2);
  c = T.clipPolyline(P([-5, -5], [5, 5]), 0, 0, 10, 10);
  check('a line that starts outside and ends inside is cut at the entry', c.length === 1 && c[0][0].x === 0 && c[0][0].y === 0 && c[0][1].x === 5);

  // clipping conserves length: cut a wandering line by a partition of rectangles and the pieces add up to the line
  {
    const len = (l) => l.reduce((n, q, i) => n + (i ? Math.hypot(q.x - l[i - 1].x, q.y - l[i - 1].y) : 0), 0);
    let worstErr = 0, line = [];
    for (let trial = 0; trial < 200; trial++) {
      line = []; let x = Math.random() * 300, y = Math.random() * 200;
      for (let i = 0; i < 40; i++) { line.push({ x, y }); x = Math.min(299.9, Math.max(0.1, x + (Math.random() - 0.5) * 80)); y = Math.min(199.9, Math.max(0.1, y + (Math.random() - 0.5) * 80)); }
      let sum = 0;
      for (let cx = 0; cx < 3; cx++) for (let cy = 0; cy < 2; cy++) sum += T.clipPolyline(line, cx * 100, cy * 100, 100, 100).reduce((n, l) => n + len(l), 0);
      worstErr = Math.max(worstErr, Math.abs(sum - len(line)));
    }
    check('property: pieces from a partition of rectangles add up to the whole line', worstErr < 1e-6, 'worst error ' + worstErr);
  }

  // ---- vector tiles: SVG and DXF written for a window
  {
    const track = Track.makeTrack('T', [[{ lat: 39.62, lon: -120.69 }, { lat: 39.65, lon: -120.6 }, { lat: 39.68, lon: -120.52 }]]);
    const gb = { south: 39.6, west: -120.7, north: 39.7, east: -120.5 }, GW = 1000, GH = 800, k = 0.5;
    const win = { x0: 300, y0: 200, w: 400, h: 300 };
    const dxfPts = (text, layer) => { const t = text.split('\n'), out = []; let on = false, cur = null; for (let i = 0; i + 1 < t.length; i += 2) { const c = t[i], v = t[i + 1]; if (c === '0' && v === 'VERTEX') { cur = {}; out.push(cur); on = true; } else if (c === '0') on = false; else if (on && c === '8') cur.layer = v; else if (on && c === '10') cur.x = +v; else if (on && c === '20') cur.y = +v; } return out.filter((q) => q.layer === layer); };
    const full = V.toDxf(track, gb, GW, GH, { mmPerPx: k, marks: true }), tile = V.toDxf(track, gb, GW, GH, { mmPerPx: k, marks: true, window: win });
    const marks = dxfPts(tile, 'CORNER_MARKS'), mx = marks.map((q) => q.x), my = marks.map((q) => q.y);
    check('DXF tile: the corner marks span the tile, not the whole grid', Math.min(...mx) === 0 && Math.max(...mx) === win.w * k && Math.min(...my) === 0 && Math.max(...my) === win.h * k, Math.max(...mx) + ' x ' + Math.max(...my));
    const rt = dxfPts(tile, 'ROUTE'), rf = dxfPts(full, 'ROUTE');
    check('DXF tile: the route is cut at the tile edges and stays inside the frame', rt.length >= 2 && rt.every((q) => q.x >= -1e-6 && q.x <= win.w * k + 1e-6 && q.y >= -1e-6 && q.y <= win.h * k + 1e-6) && rt.length < rf.length + 4);
    // a tile vertex corresponds to a whole-grid vertex shifted by the window corner (in mm, y up in DXF)
    const shifted = rf.map((q) => ({ x: q.x - win.x0 * k, y: q.y - (GH - win.y0 - win.h) * k }));
    check('DXF tile: a route point is the whole-grid point moved to the tile corner', rt.some((q) => shifted.some((r) => Math.abs(r.x - q.x) < 1e-2 && Math.abs(r.y - q.y) < 1e-2)));
    const svg = V.toSvg(track, gb, GW, GH, { mmPerPx: k, marks: true, window: win });
    check('SVG tile: the page is the tile size', new RegExp('viewBox="0 0 ' + win.w * k + ' ' + win.h * k + '"').test(svg) && new RegExp('width="' + win.w * k + 'mm"').test(svg));
    const fullSvg = V.toSvg(track, gb, GW, GH, { mmPerPx: k, marks: true });
    check('without a window nothing changes', /viewBox="0 0 500 400"/.test(fullSvg) && V.toDxf(track, gb, GW, GH, { mmPerPx: k, marks: true, window: null }) === full);
    // layers lines (contours) are cut too
    const lay = { name: 'contours', color: '#000', aci: 30, width: 1, lines: [[{ x: 100, y: 250 }, { x: 900, y: 250 }]] };
    const lt = dxfPts(V.toDxf(null, gb, GW, GH, { mmPerPx: k, layers: [lay], window: win }), 'CONTOURS');
    check('contour lines are cut to the tile too', lt.length === 2 && lt[0].x === 0 && lt[1].x === win.w * k, JSON.stringify(lt));
  }

  // ---- windowed encode: a tile equals the same window cut from the whole
  const GW = 301, GH = 217, g16 = new Uint16Array(GW * GH), g8 = new Uint8Array(GW * GH);
  for (let i = 0; i < g16.length; i++) { g16[i] = (i * 37 + (i >> 3)) & 0xffff; g8[i] = (i * 11) & 255; }
  for (const [bits, g] of [[16, g16], [8, g8]]) {
    const t = { x0: 53, y0: 41, w: 97, h: 80 };
    const blob = await HM.encodeGreyStream(t.w, t.h, bits, g, { view: { x0: t.x0, y0: t.y0, stride: GW }, rowsPerBand: 17, pixelsPerMetre: 5000, text: { Tile: 'r2c2' } });
    const d = decode(Buffer.from(await blob.arrayBuffer())), bpp = bits / 8;
    let same = d.w === t.w && d.h === t.h && d.bits === bits;
    for (let y = 0; y < t.h && same; y++) for (let x = 0; x < t.w; x++) {
      const v = g[(t.y0 + y) * GW + t.x0 + x], got = bits === 16 ? d.px.readUInt16BE((y * t.w + x) * 2) : d.px[y * t.w + x];
      if (v !== got) { same = false; break; }
    }
    check(bits + '-bit: an encoded window holds exactly that part of the grid', same);
    check(bits + '-bit: the window keeps the pixel density and text', d.cs.some((q) => q.type === 'pHYs') && d.cs.some((q) => q.type === 'tEXt' && /Tile\u0000r2c2/.test(q.body.toString('latin1'))));
  }
  const whole16 = await HM.encodeGreyStream(GW, GH, 16, g16, {}), plain = decode(Buffer.from(await whole16.arrayBuffer()));
  check('no window still encodes the whole grid', plain.w === GW && plain.h === GH && plain.px.readUInt16BE(0) === g16[0] && plain.px.readUInt16BE((GW * GH - 1) * 2) === g16[GW * GH - 1]);

  // ---- ZIP
  const png = await HM.encodeGreyStream(40, 30, 16, new Uint16Array(1200).map((_, i) => i * 50));
  const zip = await Zip.makeZip([{ name: 'a_r1c1.png', data: png }, { name: 'tiles.txt', data: 'héllo\nline two\n' }, { name: 'bytes.bin', data: Uint8Array.from([0, 1, 2, 255]) }]);
  const zp = path.join(OUT, 'tiles-test.zip');
  fs.writeFileSync(zp, Buffer.from(await zip.arrayBuffer()));
  const py = `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1])\nprint('TEST', z.testzip())\nprint('NAMES', ','.join(z.namelist()))\nprint('TXT', z.read('tiles.txt').decode('utf-8').replace('\\n','|'))\nprint('BIN', list(z.read('bytes.bin')))\nprint('PNGLEN', len(z.read('a_r1c1.png')))\n`;
  const r = cp.spawnSync('python3', ['-c', py, zp], { encoding: 'utf8' });
  const out = r.stdout || '';
  check('python reads the ZIP and every CRC matches', /TEST None/.test(out), (r.stderr || '').slice(0, 200));
  check('names, text (UTF-8) and bytes come back', /NAMES a_r1c1.png,tiles.txt,bytes.bin/.test(out) && /TXT héllo\|line two\|/.test(out) && /BIN \[0, 1, 2, 255\]/.test(out));
  check('the PNG inside is the same size as the source', new RegExp('PNGLEN ' + png.size + '\\b').test(out));
  const un = cp.spawnSync('unzip', ['-tq', zp], { encoding: 'utf8' });
  check('unzip agrees the archive is sound', un.error ? true : /No errors/.test(un.stdout), un.error ? 'unzip not installed, skipped' : un.stdout.trim());
  let dup = ''; try { await Zip.makeZip([{ name: 'x', data: 'a' }, { name: 'x', data: 'b' }]); } catch (e) { dup = e.message; }
  check('a duplicate name is refused', /Duplicate/.test(dup));
  check('crc32 matches the standard value', Zip.crc32(Buffer.from('123456789')) === 0xcbf43926);
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
