/* Binary STL of the terrain as a solid block, for CAD/CAM programs that read a mesh at full precision.
 *
 * Input: t (Float32Array, W x H, row 0 = north, heights already normalised to 0..1, NaN treated as 0),
 * and opts { widthMm, heightMm, reliefMm, baseMm }. Output: an ArrayBuffer of binary STL.
 *
 * Frame: millimetres, X east from 0, Y north from 0, Z up from 0 (the underside). The top surface sits at
 * baseMm + t * reliefMm, over a flat base of thickness baseMm, with vertical walls on all four sides. The solid is
 * closed (every edge is shared by exactly two triangles) and wound counter-clockwise seen from outside.
 */
(function (root) {
  'use strict';

  /** Triangle count for a W x H grid: two per top cell, a fan per wall side (one more than its top segments), and two for the underside. */
  function triangleCount(W, H) { return 2 * (W - 1) * (H - 1) + 2 * W + 2 * H + 2; }

  /** Bilinear resample of a normalised grid to newW x newH (corners map to corners). */
  function resample(t, W, H, newW, newH) {
    if (newW === W && newH === H) return t;
    const out = new Float32Array(newW * newH);
    for (let j = 0; j < newH; j++) {
      const y = newH > 1 ? j * (H - 1) / (newH - 1) : 0, y0 = Math.min(H - 2, Math.floor(y)), fy = y - y0;
      for (let i = 0; i < newW; i++) {
        const x = newW > 1 ? i * (W - 1) / (newW - 1) : 0, x0 = Math.min(W - 2, Math.floor(x)), fx = x - x0;
        const a = t[y0 * W + x0], b = t[y0 * W + x0 + 1], c = t[(y0 + 1) * W + x0], d = t[(y0 + 1) * W + x0 + 1];
        out[j * newW + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
    return out;
  }

  /**
   * Write a closed solid to binary STL. `top(tri)` emits the top-surface triangles through `tri`; `sides` are the four
   * boundary vertex lists [x, y, z] along the top edge, ordered so the outside is on the left seen from above: north
   * west-to-east, south east-to-west, west south-to-north, east north-to-south (each runs corner to corner, with every
   * boundary vertex of the top surface in it). `nTop` is the number of top triangles; (x1, y1) is the far corner.
   */
  function writeSolid(nTop, top, sides, x1, y1) {
    const n = nTop + sides.reduce((a, p) => a + p.length, 0) + 2, buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    const head = 'MapNC terrain, millimetres, Z up';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, n, true);
    let off = 84;
    const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) { dv.setFloat32(off, v, true); off += 4; }
      dv.setUint16(off, 0, true); off += 2;
    };
    top(tri);
    // Walls: each side is a fan from the bottom corner under its first top vertex over every top segment, then one
    // triangle to the far bottom corner, so the wall's top follows the terrain edge vertex for vertex and its bottom
    // is a single edge.
    for (const pts of sides) {
      const b0 = pts[0], m = pts.length - 1, last = pts[m];
      for (let k = 0; k < m; k++) tri(pts[k][0], pts[k][1], pts[k][2], pts[k + 1][0], pts[k + 1][1], pts[k + 1][2], b0[0], b0[1], 0);
      tri(last[0], last[1], last[2], last[0], last[1], 0, b0[0], b0[1], 0);
    }
    // Underside (normal down).
    tri(0, 0, 0, 0, y1, 0, x1, y1, 0); tri(0, 0, 0, x1, y1, 0, x1, 0, 0);
    return buf;
  }

  function buildStl(t, W, H, opts) {
    if (!(W >= 2 && H >= 2)) throw new Error('The grid must be at least 2 x 2.');
    const dx = opts.widthMm / (W - 1), dy = opts.heightMm / (H - 1), relief = opts.reliefMm, base = opts.baseMm;
    const X = (i) => i * dx, Y = (j) => (H - 1 - j) * dy;                       // row 0 is north, so the largest Y
    const Z = (i, j) => { const v = t[j * W + i]; return base + (v === v ? v : 0) * relief; };
    const P = (i, j) => [X(i), Y(j), Z(i, j)], range = (n) => Array.from({ length: n }, (_, k) => k);
    const sides = [
      range(W).map((i) => P(i, 0)),                      // north, west to east
      range(W).map((i) => P(W - 1 - i, H - 1)),          // south, east to west
      range(H).map((j) => P(0, H - 1 - j)),              // west, south to north
      range(H).map((j) => P(W - 1, j)),                  // east, north to south
    ];
    const top = (tri) => {
      // Vertices: a = (i, j), b = (i+1, j), c = (i, j+1), d = (i+1, j+1); +j is south (-Y).
      for (let j = 0; j < H - 1; j++) {
        for (let i = 0; i < W - 1; i++) {
          const a = P(i, j), b = P(i + 1, j), c = P(i, j + 1), d = P(i + 1, j + 1);
          tri(...a, ...c, ...b); tri(...b, ...c, ...d);
        }
      }
    };
    return writeSolid(2 * (W - 1) * (H - 1), top, sides, X(W - 1), Y(0));
  }

  // ---- faceted (adaptive) mesh ----------------------------------------------------------------

  const Delaunator = root.Delaunator || (typeof require !== 'undefined' ? require('./vendor/delaunator.min.js') : null);

  /** Local peaks and pits of the grid, strongest first: [{ i, j, score }] (score is the height difference, 0..1, to the ring around it). */
  function keyPoints(t, W, H, limit) {
    const R = Math.max(3, Math.round(Math.max(W, H) * 0.02)), out = [];
    const at = (i, j) => t[j * W + i];
    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const z = at(i, j);
        let hi = true, lo = true;
        for (let dj = -1; dj <= 1 && (hi || lo); dj++) for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const v = at(i + di, j + dj);
          if (v >= z) hi = false;
          if (v <= z) lo = false;
        }
        if (!hi && !lo) continue;
        let sum = 0, cnt = 0;
        for (let a = 0; a < 8; a++) {
          const ii = Math.round(i + R * Math.cos(a * Math.PI / 4)), jj = Math.round(j + R * Math.sin(a * Math.PI / 4));
          if (ii >= 0 && ii < W && jj >= 0 && jj < H) { sum += at(ii, jj); cnt++; }
        }
        if (cnt) out.push({ i, j, score: Math.abs(z - sum / cnt) });
      }
    }
    out.sort((p, q) => q.score - p.score);
    return out.slice(0, limit);
  }

  /**
   * Adaptive triangulation of the grid: start from the corners and the strongest local peaks and pits, then repeatedly
   * triangulate (Delaunay), find in each triangle the grid sample it fits worst, and add the worst of those, until the
   * top surface has about `target` triangles. Vertices therefore land on summits, ridges, valley floors and cliff
   * edges, and flat ground stays as a few large triangles.
   * Returns { points: [{ i, j }], tris: Uint32Array of point indices, maxErr (in the grid's 0..1 height units), W, H, t }
   * on a grid of at most `maxGrid` samples on the long side.
   */
  function facetedMesh(t0, W0, H0, opts) {
    const o = opts || {}, target = Math.max(8, Math.round(o.target || 3000)), maxGrid = o.maxGrid || 700;
    const long = Math.max(W0, H0), k = Math.min(1, maxGrid / long);
    const W = Math.max(2, Math.round(W0 * k)), H = Math.max(2, Math.round(H0 * k));
    const t = resample(t0, W0, H0, W, H);
    const seen = new Uint8Array(W * H), pts = [];                     // point list as [i, j] pairs; `seen` stops duplicates
    const add = (i, j) => { if (seen[j * W + i]) return false; seen[j * W + i] = 1; pts.push(i, j); return true; };
    add(0, 0); add(W - 1, 0); add(W - 1, H - 1); add(0, H - 1);
    for (const p of keyPoints(t, W, H, Math.min(400, Math.ceil(target / 12)))) add(p.i, p.j);
    const err = new Float32Array(W * H);
    let tri = null, maxErr = 0;
    for (let round = 0; round < 200; round++) {
      const n = pts.length / 2, d = new Delaunator(Float64Array.from(pts));
      tri = d.triangles;
      const nt = tri.length / 3, topCount = nt;
      // Fit error of every sample against its triangle; remember each triangle's worst sample.
      const worst = new Float32Array(nt), wi = new Int32Array(nt).fill(-1);
      maxErr = 0;
      for (let q = 0; q < nt; q++) {
        const ia = tri[3 * q], ib = tri[3 * q + 1], ic = tri[3 * q + 2];
        const ax = pts[2 * ia], ay = pts[2 * ia + 1], bx = pts[2 * ib], by = pts[2 * ib + 1], cx = pts[2 * ic], cy = pts[2 * ic + 1];
        const za = t[ay * W + ax], zb = t[by * W + bx], zc = t[cy * W + cx];
        const det = (by - ay) * (cx - ax) - (bx - ax) * (cy - ay);
        if (det === 0) continue;
        const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), y0 = Math.min(ay, by, cy), y1 = Math.max(ay, by, cy);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            // Barycentric weights of (x, y) in the triangle; accept a sliver of tolerance so edge samples count.
            const wb = ((y - ay) * (cx - ax) - (x - ax) * (cy - ay)) / det, wc = ((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / det, wa = 1 - wb - wc;
            if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
            const e = Math.abs(t[y * W + x] - (wa * za + wb * zb + wc * zc));
            if (e > worst[q] && !seen[y * W + x]) { worst[q] = e; wi[q] = y * W + x; }
            if (e > maxErr) maxErr = e;
          }
        }
      }
      const have = topCount;
      if (have >= target || n >= W * H) break;
      // Insert the worst sample of the worst triangles; a batch is a quarter of the points so far, never past the target.
      const order = Array.from({ length: nt }, (_, q) => q).filter((q) => wi[q] >= 0 && worst[q] > 1e-4).sort((p, q) => worst[q] - worst[p]);
      if (!order.length) break;                                       // every sample is on the surface already
      const room = Math.max(1, Math.ceil((target - have) / 2)), batch = Math.min(order.length, room, Math.max(8, Math.ceil(n / 4)));
      let added = 0;
      for (let b = 0; b < batch; b++) { const p = wi[order[b]]; if (add(p % W, Math.floor(p / W))) added++; }
      if (!added) break;
    }
    const points = []; for (let a = 0; a < pts.length; a += 2) points.push({ i: pts[a], j: pts[a + 1] });
    return { points, tris: tri, maxErr, W, H, t };
  }

  /**
   * Faceted STL: the adaptive mesh above as a closed solid, same frame and units as buildStl. Returns
   * { buf, triangles, points, maxErrMm } (maxErrMm is the worst fit error on the sampling grid, in millimetres of height).
   */
  function buildFacetedStl(t0, W0, H0, opts) {
    const m = facetedMesh(t0, W0, H0, opts), W = m.W, H = m.H, t = m.t;
    const dx = opts.widthMm / (W - 1), dy = opts.heightMm / (H - 1), relief = opts.reliefMm, base = opts.baseMm;
    const v = m.points.map((p) => { const z = t[p.j * W + p.i]; return [p.i * dx, (H - 1 - p.j) * dy, base + (z === z ? z : 0) * relief]; });
    const by = (cond, key) => m.points.map((p, idx) => idx).filter((idx) => cond(m.points[idx])).sort((a, b) => key(m.points[a]) - key(m.points[b])).map((idx) => v[idx]);
    const sides = [
      by((p) => p.j === 0, (p) => p.i),                      // north, west to east
      by((p) => p.j === H - 1, (p) => -p.i),                 // south, east to west
      by((p) => p.i === 0, (p) => -p.j),                     // west, south to north
      by((p) => p.i === W - 1, (p) => p.j),                  // east, north to south
    ];
    const tr = m.tris, nTop = tr.length / 3;
    const top = (tri) => {
      for (let q = 0; q < nTop; q++) {
        let a = v[tr[3 * q]], b = v[tr[3 * q + 1]], c = v[tr[3 * q + 2]];
        if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) { const s = b; b = c; c = s; }   // counter-clockwise from above
        tri(...a, ...b, ...c);
      }
    };
    const buf = writeSolid(nTop, top, sides, opts.widthMm, opts.heightMm);
    return { buf, triangles: new DataView(buf).getUint32(80, true), points: m.points.length, maxErrMm: m.maxErr * relief };
  }

  const api = { buildStl, buildFacetedStl, facetedMesh, keyPoints, resample, triangleCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCStl = api;
})(typeof self !== 'undefined' ? self : this);
