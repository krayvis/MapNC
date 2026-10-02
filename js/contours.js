/* Contour lines from an elevation grid (marching squares), for the vector export.
 *
 * Input: data (Float32Array, metres, NaN = no data), W, H, the grid's row-major layout (row 0 = north), and an
 * interval in metres. Levels sit at whole multiples of the interval (so 10 m contours are at 0, 10, 20 ...).
 *
 * Output: { levels: [{ n, z, index, lines }] } sorted by level. `lines` are polylines of {x, y} in HEIGHTMAP PIXELS,
 * y down from the top-left of the extent: sample (i, j) is the centre of pixel (i, j), so it sits at (i + 0.5, j + 0.5),
 * the same frame as Track.toPixels. A closed line repeats its first point at the end. `index` is true for every
 * fifth level (n % 5 === 0), the heavier "index contour" of a topo map.
 *
 * Cells touching a no-data sample are skipped, so contours stop at holes instead of inventing a surface there.
 * Lines are lightly smoothed (to take out stair-steps from the grid) and thinned with Douglas-Peucker, and tiny
 * loops that are only noise are dropped.
 */
(function (root) {
  'use strict';

  /** A round interval (1, 2, 5 x 10^k) giving roughly `target` minor lines across `range` metres. */
  function niceInterval(range, target) {
    const raw = Math.max(range, 0) / (target || 15);
    if (!(raw > 0.5)) return 0.5;
    const e = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (m * e >= raw) return m * e;
    return 10 * e;
  }

  // Edge ids: a horizontal edge between samples (x, y) and (x + 1, y) is (y * W + x) * 2; a vertical edge between
  // (x, y) and (x, y + 1) is (y * W + x) * 2 + 1. Both cells sharing an edge compute the same crossing point.
  function segments(data, W, H, interval) {
    const levels = new Map();      // n -> flat array of [keyA, keyB, ax, ay, bx, by]
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        const k = j * W + i;
        const a = data[k], b = data[k + 1], c = data[k + W + 1], d = data[k + W];   // top-left, top-right, bottom-right, bottom-left
        if (a !== a || b !== b || c !== c || d !== d) continue;
        const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
        if (lo === hi) continue;
        const n1 = Math.floor(hi / interval);
        for (let n = Math.floor(lo / interval) + 1; n <= n1; n++) {
          const L = n * interval;
          const idx = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0);
          if (idx === 0 || idx === 15) continue;
          let arr = levels.get(n);
          if (!arr) { arr = []; levels.set(n, arr); }
          // Crossing on each edge, as [key, x, y].
          const T = () => [(j * W + i) * 2, i + 0.5 + (L - a) / (b - a), j + 0.5];
          const B = () => [((j + 1) * W + i) * 2, i + 0.5 + (L - d) / (c - d), j + 1.5];
          const Lf = () => [(j * W + i) * 2 + 1, i + 0.5, j + 0.5 + (L - a) / (d - a)];
          const R = () => [(j * W + i + 1) * 2 + 1, i + 1.5, j + 0.5 + (L - b) / (c - b)];
          const add = (p, q) => arr.push(p[0], q[0], p[1], p[2], q[1], q[2]);
          switch (idx) {
            case 1: case 14: add(Lf(), B()); break;
            case 2: case 13: add(B(), R()); break;
            case 3: case 12: add(Lf(), R()); break;
            case 4: case 11: add(T(), R()); break;
            case 6: case 9: add(T(), B()); break;
            case 7: case 8: add(T(), Lf()); break;
            case 5:                                   // top-right and bottom-left above: saddle
              if ((a + b + c + d) / 4 >= L) { add(T(), Lf()); add(B(), R()); } else { add(T(), R()); add(Lf(), B()); }
              break;
            case 10:                                  // top-left and bottom-right above: saddle
              if ((a + b + c + d) / 4 >= L) { add(T(), R()); add(Lf(), B()); } else { add(T(), Lf()); add(B(), R()); }
              break;
          }
        }
      }
    }
    return levels;
  }

  /** Join one level's segments end to end into polylines. */
  function chain(arr) {
    const m = arr.length / 6, adj = new Map();
    const link = (key, s) => { const l = adj.get(key); if (l) l.push(s); else adj.set(key, [s]); };
    for (let s = 0; s < m; s++) { link(arr[s * 6], s); link(arr[s * 6 + 1], s); }
    const used = new Uint8Array(m), lines = [];
    const next = (key) => { const l = adj.get(key); if (l) for (const s of l) if (!used[s]) return s; return -1; };
    // Step across segment s from the end at `key`: returns [far key, far point].
    const across = (s, key) => (arr[s * 6] === key
      ? [arr[s * 6 + 1], { x: arr[s * 6 + 4], y: arr[s * 6 + 5] }]
      : [arr[s * 6], { x: arr[s * 6 + 2], y: arr[s * 6 + 3] }]);
    for (let s0 = 0; s0 < m; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const fwd = [{ x: arr[s0 * 6 + 4], y: arr[s0 * 6 + 5] }], bwd = [{ x: arr[s0 * 6 + 2], y: arr[s0 * 6 + 3] }];
      const startKey = arr[s0 * 6];
      let endKey = arr[s0 * 6 + 1], s;
      while ((s = next(endKey)) >= 0) { used[s] = 1; const [k, p] = across(s, endKey); fwd.push(p); endKey = k; }
      if (endKey !== startKey) {
        let key = startKey;
        while ((s = next(key)) >= 0) { used[s] = 1; const [k, p] = across(s, key); bwd.push(p); key = k; }
      }
      lines.push({ pts: bwd.reverse().concat(fwd), closed: endKey === startKey });
    }
    return lines;
  }

  function smooth(pts, closed, passes) {
    let p = pts;
    for (let r = 0; r < passes && p.length > 3; r++) {
      const n = p.length, q = new Array(n);
      for (let i = 0; i < n; i++) {
        if (i === 0 || i === n - 1) {
          if (!closed) { q[i] = p[i]; continue; }
          const pr = p[n - 2], nx = p[1];
          q[i] = { x: 0.25 * pr.x + 0.5 * p[i].x + 0.25 * nx.x, y: 0.25 * pr.y + 0.5 * p[i].y + 0.25 * nx.y };
          continue;
        }
        q[i] = { x: 0.25 * p[i - 1].x + 0.5 * p[i].x + 0.25 * p[i + 1].x, y: 0.25 * p[i - 1].y + 0.5 * p[i].y + 0.25 * p[i + 1].y };
      }
      if (closed) q[n - 1] = q[0];
      p = q;
    }
    return p;
  }

  /** Douglas-Peucker thinning of an open polyline (iterative, so very long lines are safe). */
  function thin(pts, tol) {
    const n = pts.length;
    if (n < 3) return pts;
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      const A = pts[s], B = pts[e], dx = B.x - A.x, dy = B.y - A.y, len2 = dx * dx + dy * dy;
      let worst = -1, wi = -1;
      for (let i = s + 1; i < e; i++) {
        let t = len2 ? ((pts[i].x - A.x) * dx + (pts[i].y - A.y) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = pts[i].x - (A.x + t * dx), ey = pts[i].y - (A.y + t * dy), dd = ex * ex + ey * ey;
        if (dd > worst) { worst = dd; wi = i; }
      }
      if (wi >= 0 && worst > tol * tol) { keep[wi] = 1; stack.push([s, wi], [wi, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  const lengthOf = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; };

  function contourLines(data, W, H, interval, opts) {
    if (!(interval > 0)) throw new Error('Contour interval must be above zero.');
    const o = opts || {};
    const passes = o.smooth == null ? 2 : o.smooth, tol = o.tol == null ? 0.25 : o.tol, minLen = o.minLen == null ? 8 : o.minLen;
    const levels = [];
    for (const [n, arr] of segments(data, W, H, interval)) {
      const lines = [];
      for (const ln of chain(arr)) {
        let pts = smooth(ln.pts, ln.closed, passes);
        if (ln.closed && pts.length > 5) {                 // thin a ring as two halves so the chord never has zero length
          const mid = pts.length >> 1;
          pts = thin(pts.slice(0, mid + 1), tol).concat(thin(pts.slice(mid), tol).slice(1));
        } else pts = thin(pts, tol);
        if (pts.length >= 2 && lengthOf(pts) >= minLen) lines.push(pts);
      }
      if (lines.length) levels.push({ n, z: n * interval, index: n % 5 === 0, lines });
    }
    levels.sort((p, q) => p.n - q.n);
    return { levels };
  }

  const ringArea = (pts) => { let a = 0; for (let i = 1; i < pts.length; i++) a += pts[i - 1].x * pts[i].y - pts[i].x * pts[i - 1].y; return Math.abs(a) / 2; };

  /**
   * Cut outlines for a stacked ("layered") map: for each level L, the boundary of the ground at or above L, as closed
   * rings in heightmap pixels (same frame as contourLines), clipped square to the extent. A ring that follows the
   * extent's edge runs exactly along it, so the lowest layer is the whole rectangle. No-data counts as below every
   * level. Rings smaller than `minArea` square pixels are dropped (too small to cut).
   * Returns [{ z, rings }] in the order of `levels`.
   */
  function layerOutlines(data, W, H, levels, opts) {
    const o = opts || {}, minArea = o.minArea == null ? 4 : o.minArea;
    const PW = W + 4, PH = H + 4, pad = new Float64Array(PW * PH);
    const out = [];
    for (const L of levels) {
      // Shift so the level is 0, take it as the only contour (interval far above any relief), and ring the grid with
      // a copy of its edge plus one very low layer: the boundary then sits on the outer copy, which is clamped to the extent.
      for (let j = 0; j < PH; j++) {
        for (let i = 0; i < PW; i++) {
          const ii = Math.min(W - 1, Math.max(0, i - 2)), jj = Math.min(H - 1, Math.max(0, j - 2));
          const outer = i === 0 || j === 0 || i === PW - 1 || j === PH - 1;
          const v = data[jj * W + ii] - L;
          pad[j * PW + i] = outer || v !== v ? -1e6 : v;
        }
      }
      const rings = [];
      const seg = segments(pad, PW, PH, 1e12).get(0);
      for (const ln of seg ? chain(seg) : []) {
        if (!ln.closed) continue;
        let pts = ln.pts;
        if (pts.length > 5) {
          const mid = pts.length >> 1;
          pts = thin(pts.slice(0, mid + 1), 0.25).concat(thin(pts.slice(mid), 0.25).slice(1));
        }
        pts = pts.map((p) => ({ x: Math.min(W, Math.max(0, p.x - 2)), y: Math.min(H, Math.max(0, p.y - 2)) }));
        if (pts.length >= 4 && ringArea(pts) >= minArea) rings.push(pts);
      }
      out.push({ z: L, rings });
    }
    return out;
  }

  const api = { contourLines, layerOutlines, niceInterval, thin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCContours = api;
})(typeof self !== 'undefined' ? self : this);
