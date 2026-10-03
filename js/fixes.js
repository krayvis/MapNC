/* Elevation fixes for the heightmap: filling no-data gaps and raising a floor.
 *
 * Both work in place on the Float32 grid (no-data is NaN) and return undo patches in the same shape as lakes.js
 * ({ idx: Uint32Array, old: Float32Array }), so Lakes.revert() puts the original samples back. Nothing here touches
 * the DOM, so it runs in Node.
 *
 * fillGaps: a gap is a connected run of no-data pixels (8-way). Small gaps (voids in the source data) are filled by
 * linear interpolation along the row and the column, blended with weight 1/distance, using only the original samples
 * so the result does not depend on scan order. Gaps bigger than opts.maxFraction of the grid (default 2%) are left:
 * those are usually outside the source's coverage or open sea, where inventing terrain would be wrong.
 * raiseFloor: every sample below a level is set to that level (a flat sea at 0 m, or a coast cut-off), so the
 * automatic range then starts at the level.
 */
(function (root) {
  'use strict';

  const MAX_FRACTION = 0.02;

  /** Fills small no-data gaps. Returns { patches, summary: { gaps, filled, left, leftPixels } }. */
  function fillGaps(data, W, H, opts) {
    const o = opts || {}, maxArea = Math.max(1, Math.floor((o.maxFraction == null ? MAX_FRACTION : o.maxFraction) * W * H));
    const summary = { gaps: 0, filled: 0, left: 0, leftPixels: 0 };
    let any = false;
    for (let i = 0; i < data.length; i++) if (data[i] !== data[i]) { any = true; break; }
    if (!any) return { patches: [], summary };

    const seen = new Uint8Array(data.length);
    const idx = [], vals = [];
    const nearest = (x, y, dx, dy, limit) => {           // [value, distance] of the first sample in a direction
      for (let d = 1; d <= limit; d++) {
        const xx = x + dx * d, yy = y + dy * d;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return null;
        const v = data[yy * W + xx];
        if (v === v) return [v, d];
      }
      return null;
    };
    for (let start = 0; start < data.length; start++) {
      if (seen[start] || data[start] === data[start]) continue;
      // breadth-first flood; the queue is the component, kept only while it can still be filled
      let queue = [start], head = 0, count = 0, list = [];
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      seen[start] = 1;
      while (head < queue.length) {
        const p = queue[head++], px = p % W, py = (p - px) / W;
        count++;
        if (list) { if (count > maxArea) list = null; else list.push(p); }
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= W || (!dx && !dy)) continue;
            const q = ny * W + nx;
            if (!seen[q] && data[q] !== data[q]) { seen[q] = 1; queue.push(q); }
          }
        }
        if (head > 65536 && head * 2 > queue.length) { queue = queue.slice(head); head = 0; }
      }
      if (!list) { summary.left++; summary.leftPixels += count; continue; }
      const limit = Math.max(x1 - x0, y1 - y0) + 2;
      const fresh = new Float32Array(list.length), ok = new Uint8Array(list.length);
      for (let k = 0; k < list.length; k++) {
        const p = list[k], x = p % W, y = (p - x) / W;
        let wsum = 0, vsum = 0;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const hit = nearest(x, y, dx, dy, limit);
          if (hit) { wsum += 1 / hit[1]; vsum += hit[0] / hit[1]; }
        }
        if (wsum > 0) { fresh[k] = vsum / wsum; ok[k] = 1; }
      }
      let filled = 0;
      for (let k = 0; k < list.length; k++) if (ok[k]) { idx.push(list[k]); vals.push(fresh[k]); filled++; }
      if (filled) { summary.gaps++; summary.filled += filled; }
      if (filled < list.length) { summary.left++; summary.leftPixels += list.length - filled; }
    }
    // write after every gap has been measured, so the order of gaps cannot matter
    const pIdx = Uint32Array.from(idx), pOld = new Float32Array(idx.length).fill(NaN);
    for (let k = 0; k < pIdx.length; k++) data[pIdx[k]] = vals[k];
    return { patches: pIdx.length ? [{ idx: pIdx, old: pOld }] : [], summary };
  }

  /** Sets every sample below level to level. Returns { patches, summary: { raised, finite } } (finite = samples with data). */
  function raiseFloor(data, level) {
    const lvl = Math.fround(level);
    let n = 0, finite = 0;
    for (let i = 0; i < data.length; i++) { if (data[i] === data[i]) finite++; if (data[i] < lvl) n++; }
    const idx = new Uint32Array(n), old = new Float32Array(n);
    let k = 0;
    for (let i = 0; i < data.length; i++) if (data[i] < lvl) { idx[k] = i; old[k] = data[i]; k++; data[i] = lvl; }
    return { patches: n ? [{ idx, old, level: lvl }] : [], summary: { raised: n, finite } };
  }

  const api = { MAX_FRACTION, fillGaps, raiseFloor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCFixes = api;
})(typeof self !== 'undefined' ? self : this);
