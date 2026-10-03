/* Lake flattening for the heightmap: pools each lake to one flat level using its OpenStreetMap outline.
 *
 * Flow: groupLakes() turns OSM features into lakes (outer ring plus any island rings) in heightmap pixels,
 * flatten() sets every pixel inside each lake to the median elevation of that lake's own pixels and returns an undo
 * patch, revert() puts the original values back. Nothing here touches the DOM, so it runs in Node.
 *
 * Decisions: flat water only (no carved depth); the level is per lake (lakes in one region differ by hundreds of
 * metres); a lake whose DEM is already flat is left alone; rivers drawn as areas are skipped (they slope); a lake
 * whose outline is incomplete is skipped whole (filling a half-closed ring, or missing an island, would be worse
 * than leaving the lake). No-data pixels inside a lake take the lake's level.
 */
(function (root) {
  'use strict';

  /** natural=water areas that flow downhill, so a single flat level would be wrong for them. */
  const FLOWING = /^(river|stream|canal|ditch|drain|stream_pool|fish_pass|lock)$/;
  const FLAT_TOL_M = 0.05;                 // a lake whose samples span less than this is already flat
  const MIN_PIXELS = 4;                    // smaller than this, a median means nothing

  const sameLL = (a, b) => a.lat === b.lat && a.lon === b.lon;

  /**
   * OSM features (see osm.js parse) -> [{ id, name, rings: [[{x,y}]], incomplete }] in heightmap pixels.
   * Rings of one relation stay together so even-odd filling leaves islands dry. Only kind 'lakes' that are still water.
   */
  function groupLakes(features, bounds, W, H) {
    const sx = W / (bounds.east - bounds.west), sy = H / (bounds.north - bounds.south);
    const byId = new Map();
    features.forEach((f, i) => {
      if (f.kind !== 'lakes' || FLOWING.test(f.water || '')) return;
      const id = f.id != null ? f.id : 'f' + i;
      let lake = byId.get(id);
      if (!lake) byId.set(id, (lake = { id, name: f.name || '', rings: [], incomplete: false }));
      if (f.pts.length < 4 || !sameLL(f.pts[0], f.pts[f.pts.length - 1])) { lake.incomplete = true; return; }
      lake.rings.push(f.pts.map((p) => ({ x: (p.lon - bounds.west) * sx, y: (bounds.north - p.lat) * sy })));
    });
    return [...byId.values()];
  }

  /**
   * Calls fn(y, xStart, xEnd) for every run of pixels (inclusive) inside the rings, using the even-odd rule and pixel
   * centres, clipped to 0..W-1 and 0..H-1.
   */
  function forEachSpan(rings, W, H, fn) {
    const rows = new Map();
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i], b = ring[i + 1];
        if (a.y === b.y) continue;
        const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y) - 0.5)), y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) - 0.5) - 1);
        for (let y = y0; y <= y1; y++) {
          const x = a.x + (y + 0.5 - a.y) * (b.x - a.x) / (b.y - a.y);
          const list = rows.get(y);
          if (list) list.push(x); else rows.set(y, [x]);
        }
      }
    }
    for (const [y, xs] of rows) {
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(W - 1, Math.ceil(xs[i + 1] - 0.5) - 1);
        if (xb >= xa) fn(y, xa, xb);
      }
    }
  }

  /**
   * Flattens the lakes in place. Returns { patches, summary } where patches is for revert() and summary counts
   * { found, flattened, flat, tiny, incomplete, pixels }.
   */
  function flatten(data, W, H, lakes, opts) {
    const o = opts || {}, flatTol = o.flatTol == null ? FLAT_TOL_M : o.flatTol;
    const patches = [], summary = { found: lakes.length, flattened: 0, flat: 0, tiny: 0, incomplete: 0, pixels: 0 };
    for (const lake of lakes) {
      if (lake.incomplete || !lake.rings.length) { summary.incomplete++; continue; }
      let n = 0;
      forEachSpan(lake.rings, W, H, (y, xa, xb) => { n += xb - xa + 1; });
      if (n < MIN_PIXELS) { summary.tiny++; continue; }
      const vals = new Float32Array(n);
      let m = 0, hasNaN = false;
      forEachSpan(lake.rings, W, H, (y, xa, xb) => {
        for (let x = xa, i = y * W + xa; x <= xb; x++, i++) { const v = data[i]; if (v !== v) hasNaN = true; else vals[m++] = v; }
      });
      if (!m) { summary.tiny++; continue; }
      const finite = vals.subarray(0, m).sort();
      if (!hasNaN && finite[m - 1] - finite[0] < flatTol) { summary.flat++; continue; }
      const level = m % 2 ? finite[(m - 1) / 2] : (finite[m / 2 - 1] + finite[m / 2]) / 2;
      let changed = 0;
      forEachSpan(lake.rings, W, H, (y, xa, xb) => {
        for (let x = xa, i = y * W + xa; x <= xb; x++, i++) if (data[i] !== data[i] || data[i] !== Math.fround(level)) changed++;
      });
      const idx = new Uint32Array(changed), old = new Float32Array(changed);
      let k = 0;
      const lvl = Math.fround(level);
      forEachSpan(lake.rings, W, H, (y, xa, xb) => {
        for (let x = xa, i = y * W + xa; x <= xb; x++, i++) {
          if (data[i] !== data[i] || data[i] !== lvl) { idx[k] = i; old[k] = data[i]; k++; data[i] = lvl; }
        }
      });
      patches.push({ idx, old, level: lvl, name: lake.name });
      summary.flattened++; summary.pixels += changed;
    }
    return { patches, summary };
  }

  /** Puts the original values back (newest patch first, so overlapping lakes restore correctly). */
  function revert(data, patches) {
    for (let p = patches.length - 1; p >= 0; p--) {
      const { idx, old } = patches[p];
      for (let i = 0; i < idx.length; i++) data[idx[i]] = old[i];
    }
  }

  const api = { FLOWING, FLAT_TOL_M, groupLakes, forEachSpan, flatten, revert };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCLakes = api;
})(typeof self !== 'undefined' ? self : this);
