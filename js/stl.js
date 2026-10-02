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

  function buildStl(t, W, H, opts) {
    if (!(W >= 2 && H >= 2)) throw new Error('The grid must be at least 2 x 2.');
    const dx = opts.widthMm / (W - 1), dy = opts.heightMm / (H - 1), relief = opts.reliefMm, base = opts.baseMm;
    const n = triangleCount(W, H), buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    const head = 'MapNC terrain, millimetres, Z up';
    for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, n, true);
    let off = 84;
    const X = (i) => i * dx, Y = (j) => (H - 1 - j) * dy;                       // row 0 is north, so the largest Y
    const Z = (i, j) => { const v = t[j * W + i]; return base + (v === v ? v : 0) * relief; };
    const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay), ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az), nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) { dv.setFloat32(off, v, true); off += 4; }
      dv.setUint16(off, 0, true); off += 2;
    };
    // Top surface (normal up). Vertices: p00 = (i, j), p10 = (i+1, j), p01 = (i, j+1), p11 = (i+1, j+1); +j is south (-Y).
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const a = [X(i), Y(j), Z(i, j)], b = [X(i + 1), Y(j), Z(i + 1, j)], c = [X(i), Y(j + 1), Z(i, j + 1)], d = [X(i + 1), Y(j + 1), Z(i + 1, j + 1)];
        tri(...a, ...c, ...b); tri(...b, ...c, ...d);
      }
    }
    // Walls: each side is a fan from the bottom corner under its first top vertex over every top segment, then one
    // triangle to the far bottom corner, so the wall's top follows the terrain edge vertex for vertex and its bottom
    // is a single edge. `pts` run along the top edge with the outside on the left when seen from above.
    const wall = (pts) => {
      const b0 = [pts[0][0], pts[0][1], 0], n = pts.length - 1, last = pts[n];
      for (let k = 0; k < n; k++) tri(pts[k][0], pts[k][1], pts[k][2], pts[k + 1][0], pts[k + 1][1], pts[k + 1][2], b0[0], b0[1], 0);
      tri(last[0], last[1], last[2], last[0], last[1], 0, b0[0], b0[1], 0);
    };
    const P = (i, j) => [X(i), Y(j), Z(i, j)], range = (n) => Array.from({ length: n }, (_, k) => k);
    wall(range(W).map((i) => P(i, 0)));                                  // north, west to east
    wall(range(W).map((i) => P(W - 1 - i, H - 1)));                      // south, east to west
    wall(range(H).map((j) => P(0, H - 1 - j)));                          // west, south to north
    wall(range(H).map((j) => P(W - 1, j)));                              // east, north to south
    // Underside (normal down).
    const x1 = X(W - 1), y1 = Y(0);
    tri(0, 0, 0, 0, y1, 0, x1, y1, 0); tri(0, 0, 0, x1, y1, 0, x1, 0, 0);
    return buf;
  }

  const api = { buildStl, resample, triangleCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCStl = api;
})(typeof self !== 'undefined' ? self : this);
