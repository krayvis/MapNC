/* Tiling for carves bigger than one piece: how to cut the finished heightmap grid into equal tiles, and the geometry
 * helpers the tile exports need. Pure functions, no DOM, so it runs in Node.
 *
 * A tile is a pixel rectangle of the one big grid, so every tile shares the grid's pixel size, its elevation window
 * (a given grey level means the same height everywhere) and its edge border (which therefore appears only on the
 * outer edges of the whole carve, never on the seams). Tiles are all the same size, so one stock size fits every piece.
 * They are spread evenly from edge to edge, and neighbours overlap by at least the requested amount (more when the
 * division is not exact), which gives the machine something to register on: the shared strip is cut twice from the
 * same data.
 *
 * Rows and columns are numbered from 1 starting at the top-left (north-west) tile, as the image reads.
 */
(function (root) {
  'use strict';

  const MAX_TILES = 400;           // beyond this the answer is "use a bigger piece", not a long list

  /** Splits a length of L pixels into equal tiles of at most `maxPx`, overlapping by at least `ovPx`. */
  function splitAxis(L, maxPx, ovPx) {
    if (L <= maxPx) return { n: 1, size: L, starts: [0] };
    let n = Math.max(2, Math.ceil((L - ovPx) / (maxPx - ovPx))), size = Math.ceil((L + (n - 1) * ovPx) / n);
    while (size > maxPx) { n++; size = Math.ceil((L + (n - 1) * ovPx) / n); }
    const starts = [];
    for (let i = 0; i < n; i++) starts.push(Math.round(i * (L - size) / (n - 1)));
    return { n, size, starts };
  }

  /**
   * Plans the tiles. o: { W, H (grid pixels), mmPerPx (carve size / grid, mm), maxPieceMm (largest piece either way, mm),
   * overlapMm }. Without a carve size or a largest piece there is one tile (the whole grid) and `needed` is false.
   * Returns { needed, count, cols, rows, tileW, tileH, tileWmm, tileHmm, carveWmm, carveHmm, overlapPx, minOverlapPx,
   * tiles: [{ row, col, x0, y0, w, h, name }], error? }.
   */
  function planTiles(o) {
    const W = o.W, H = o.H, k = o.mmPerPx, carveWmm = k > 0 ? W * k : 0, carveHmm = k > 0 ? H * k : 0;
    const whole = { needed: false, count: 1, cols: 1, rows: 1, tileW: W, tileH: H, tileWmm: carveWmm, tileHmm: carveHmm, carveWmm, carveHmm, overlapPx: 0, minOverlapPx: 0, tiles: [{ row: 1, col: 1, x0: 0, y0: 0, w: W, h: H, name: 'r1c1' }] };
    if (!(k > 0) || !(o.maxPieceMm > 0)) return whole;
    const maxPx = Math.floor(o.maxPieceMm / k);
    const ovPx = Math.max(0, Math.round((o.overlapMm > 0 ? o.overlapMm : 0) / k));
    if (W <= maxPx && H <= maxPx) return whole;
    if (maxPx < 16) return Object.assign(whole, { error: 'The largest piece is smaller than 16 pixels at this carve size; enter a bigger piece.' });
    if (ovPx >= maxPx / 2) return Object.assign(whole, { error: 'The overlap must be well under half the largest piece.' });
    const ax = splitAxis(W, maxPx, ovPx), ay = splitAxis(H, maxPx, ovPx);
    if (ax.n * ay.n > MAX_TILES) return Object.assign(whole, { error: 'That would be ' + ax.n * ay.n + ' tiles. Enter a bigger piece or a smaller carve.' });
    const tiles = [];
    for (let r = 0; r < ay.n; r++) for (let c = 0; c < ax.n; c++) tiles.push({ row: r + 1, col: c + 1, x0: ax.starts[c], y0: ay.starts[r], w: ax.size, h: ay.size, name: 'r' + (r + 1) + 'c' + (c + 1) });
    const gap = (a) => (a.n > 1 ? a.size - (a.starts[1] - a.starts[0]) : 0);     // overlap between the first two tiles (the largest, up to rounding)
    return {
      needed: true, count: tiles.length, cols: ax.n, rows: ay.n, tileW: ax.size, tileH: ay.size, tileWmm: ax.size * k, tileHmm: ay.size * k, carveWmm, carveHmm,
      overlapPx: ovPx, minOverlapPx: Math.min(ax.n > 1 ? gap(ax) : Infinity, ay.n > 1 ? gap(ay) : Infinity), tiles,
    };
  }

  /** Geographic bounds of a tile: the grid is linear in longitude and latitude, so pixels map straight across. */
  function tileBounds(b, W, H, t) {
    const dLon = b.east - b.west, dLat = b.north - b.south;
    return { west: b.west + t.x0 / W * dLon, east: b.west + (t.x0 + t.w) / W * dLon, north: b.north - t.y0 / H * dLat, south: b.north - (t.y0 + t.h) / H * dLat };
  }

  /**
   * Clips a polyline (points {x, y}) to the rectangle [x0, x0 + w] x [y0, y0 + h] and moves it so the rectangle's corner is
   * the origin. Returns the pieces that remain (a line that leaves and comes back becomes two).
   */
  function clipPolyline(pts, x0, y0, w, h) {
    const out = [];
    let cur = null;
    const push = (p) => { if (!cur) { cur = []; out.push(cur); } const l = cur[cur.length - 1]; if (!l || l.x !== p.x || l.y !== p.y) cur.push(p); };
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      if (i === 0) {
        if (a.x >= x0 && a.x <= x0 + w && a.y >= y0 && a.y <= y0 + h) push({ x: a.x - x0, y: a.y - y0 });
        continue;
      }
      const p = pts[i - 1], dx = a.x - p.x, dy = a.y - p.y;
      let t0 = 0, t1 = 1, ok = true;
      for (const [pp, qq] of [[-dx, p.x - x0], [dx, x0 + w - p.x], [-dy, p.y - y0], [dy, y0 + h - p.y]]) {
        if (pp === 0) { if (qq < 0) { ok = false; break; } continue; }
        const r = qq / pp;
        if (pp < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
      if (!ok) { cur = null; continue; }
      if (t0 > 0 || !cur) { cur = null; push({ x: p.x + t0 * dx - x0, y: p.y + t0 * dy - y0 }); }
      push({ x: p.x + t1 * dx - x0, y: p.y + t1 * dy - y0 });
      if (t1 < 1) cur = null;
    }
    return out.filter((l) => l.length > 1);
  }

  const api = { MAX_TILES, splitAxis, planTiles, tileBounds, clipPolyline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCTiles = api;
})(typeof self !== 'undefined' ? self : this);
