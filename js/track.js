/* Track parsing and rasterizing for MapNC (GPX and TCX; FIT is not supported).
 *
 * A "track" is { name, segments: [[{lat, lon}, ...], ...] } in WGS84 degrees. Segments are drawn as separate
 * polylines (a pause or a new <trkseg> is never bridged).
 *
 * Raster frame: the heightmap grid. Column 0 is the WEST edge, row 0 is the NORTH edge, and samples are evenly
 * spaced in lon/lat across `bounds` (same as the elevation grid), so lon/lat -> pixel is linear:
 *    x = (lon - west) / (east - west) * W        y = (north - lat) / (north - south) * H
 * Radii are in PIXELS of that grid; the caller converts a ground width in metres using the grid's ground pixel size.
 */
(function (root) {
  'use strict';

  function makeTrack(name, segments) {
    const clean = [];
    for (const seg of segments) {
      const pts = [];
      for (const p of seg) {
        if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)) continue;
        const last = pts[pts.length - 1];
        if (last && last.lat === p.lat && last.lon === p.lon) continue;   // drop exact repeats
        pts.push({ lat: p.lat, lon: p.lon });
      }
      if (pts.length >= 2) clean.push(pts);
    }
    if (!clean.length) throw new Error('No usable track points found (need at least 2 points in a segment).');
    return { name: name || '', segments: clean };
  }

  function parseGpx(doc) {
    const segments = [];
    for (const seg of doc.getElementsByTagName('trkseg')) segments.push(readPoints(seg.getElementsByTagName('trkpt')));
    for (const rte of doc.getElementsByTagName('rte')) segments.push(readPoints(rte.getElementsByTagName('rtept')));
    const nameEl = doc.getElementsByTagName('name')[0];
    return makeTrack(nameEl ? nameEl.textContent.trim() : '', segments);
  }

  function readPoints(nodes) {
    const pts = [];
    for (const n of nodes) {
      const lat = parseFloat(n.getAttribute('lat')), lon = parseFloat(n.getAttribute('lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
    }
    return pts;
  }

  function parseTcx(doc) {
    const segments = [];
    for (const lap of doc.getElementsByTagName('Track')) {
      const pts = [];
      for (const tp of lap.getElementsByTagName('Trackpoint')) {   // points without a Position (e.g. paused) are skipped
        const la = tp.getElementsByTagName('LatitudeDegrees')[0], lo = tp.getElementsByTagName('LongitudeDegrees')[0];
        if (!la || !lo) continue;
        const lat = parseFloat(la.textContent), lon = parseFloat(lo.textContent);
        if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon });
      }
      segments.push(pts);
    }
    const idEl = doc.getElementsByTagName('Id')[0];
    return makeTrack(idEl ? idEl.textContent.trim() : '', segments);
  }

  /** Parse GPX or TCX text. Throws a user-readable Error on anything else. */
  function parseTrackText(text, filename) {
    if (/\.fit$/i.test(filename || '')) throw new Error('FIT files are not supported yet. Convert to GPX or TCX.');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not read the file as XML.');
    const rootName = doc.documentElement.localName;
    if (rootName === 'gpx') return parseGpx(doc);
    if (rootName === 'TrainingCenterDatabase') return parseTcx(doc);
    throw new Error('Unrecognised file (expected GPX or TCX, found <' + rootName + '>).');
  }

  /** Bounding box { south, west, north, east } of all segments. */
  function trackBounds(track) {
    let south = 90, north = -90, west = 180, east = -180;
    for (const seg of track.segments) for (const p of seg) {
      if (p.lat < south) south = p.lat; if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon; if (p.lon > east) east = p.lon;
    }
    return { south, west, north, east };
  }

  /** Grow a box by `fraction` of its own size on each side (0.1 = 10 % margin per side). Never degenerate. */
  function padBounds(b, fraction) {
    const minSpan = 0.002;   // about 200 m, so a near-point track still yields a usable region
    const dLat = Math.max(b.north - b.south, minSpan), dLon = Math.max(b.east - b.west, minSpan);
    const cLat = (b.north + b.south) / 2, cLon = (b.east + b.west) / 2;
    return {
      south: Math.max(-85, cLat - dLat * (0.5 + fraction)), north: Math.min(85, cLat + dLat * (0.5 + fraction)),
      west: Math.max(-180, cLon - dLon * (0.5 + fraction)), east: Math.min(180, cLon + dLon * (0.5 + fraction)),
    };
  }

  /** Length in km (haversine). */
  function trackLengthKm(track) {
    const R = 6371.0088, rad = Math.PI / 180;
    let km = 0;
    for (const seg of track.segments) for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1], b = seg[i];
      const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
      km += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return km;
  }


  // ---- clean-up: spikes, spacing, smoothing, simplification ------------------------------------
  // The track is treated as a polyline in a local metric frame (metres east/north of the track's centre), so every
  // threshold below is in real metres. No timestamps are needed. The steps run in this order, each one optional:
  //   1. spikes     points (or runs of up to 3) that jump far off the path and come straight back are dropped
  //   2. spacing    points closer than a minimum distance to the last kept point are dropped (standing-still jitter)
  //   3. smoothing  Gaussian average along arc length (resampled evenly first, so point density does not bias it);
  //                 the two ends stay exactly where they were
  //   4. simplify   Ramer-Douglas-Peucker: drops nodes that deviate from the straight line by less than a tolerance

  const M_LAT = 110574, M_LON = 111320;

  function localFrame(track) {
    const b = trackBounds(track), lat0 = (b.north + b.south) / 2, lon0 = (b.east + b.west) / 2;
    return { lat0, lon0, kx: M_LON * Math.cos((lat0 * Math.PI) / 180), ky: M_LAT };
  }
  const toXY = (p, f) => ({ x: (p.lon - f.lon0) * f.kx, y: (p.lat - f.lat0) * f.ky });
  const toLL = (q, f) => ({ lat: f.lat0 + q.y / f.ky, lon: f.lon0 + q.x / f.kx });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** Distance from point p to the segment a-c. */
  function distToSeg(p, a, c) {
    const vx = c.x - a.x, vy = c.y - a.y, l2 = vx * vx + vy * vy;
    if (!l2) return dist(p, a);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }

  /**
   * A spike is a run of 1-3 points that all lie farther than `T` metres from the line between their neighbours, where
   * that line is much shorter than the detour through the run (the path goes out and comes straight back). A real
   * hairpin does not match: its neighbours are close to it, so it is never farther than `T` from them.
   * The legs into and out of the run must also be well above the track's typical step: in a sparsely sampled track
   * (a point every 100 m) a genuine turnaround looks just like a spike, so nothing is removed from such a track.
   */
  function removeSpikes(pts, T) {
    let cur = pts, removed = 0;
    if (cur.length < 3) return { pts: cur, removed };
    const steps = [];
    for (let i = 1; i < cur.length; i++) steps.push(dist(cur[i - 1], cur[i]));
    steps.sort((u, v) => u - v);
    const legMin = Math.max(T, 3 * steps[Math.floor(steps.length / 2)]);   // 3 x the median step
    for (let pass = 0; pass < 6; pass++) {
      const out = [cur[0]];
      let i = 1, changed = false;
      while (i < cur.length - 1) {
        const a = out[out.length - 1];
        let hit = 0;
        for (let k = 3; k >= 1 && !hit; k--) {          // try the longest run first
          const ci = i + k;
          if (ci >= cur.length) continue;
          const c = cur[ci];
          let path = dist(a, cur[i]), ok = path > legMin && dist(cur[ci - 1], c) > legMin;
          for (let j = i; ok && j < ci; j++) {
            path += dist(cur[j], cur[j + 1]);
            if (distToSeg(cur[j], a, c) <= T) { ok = false; break; }
          }
          if (ok && dist(a, c) < 0.6 * path) hit = k;
        }
        if (hit) { removed += hit; i += hit; changed = true; } else { out.push(cur[i]); i++; }
      }
      out.push(cur[cur.length - 1]);
      cur = out;
      if (!changed) break;
    }
    return { pts: cur, removed };
  }

  function minSpacing(pts, s) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) if (dist(out[out.length - 1], pts[i]) >= s) out.push(pts[i]);
    out.push(pts[pts.length - 1]);
    return out;
  }

  /** Points every `h` metres along the polyline (linear interpolation), ending exactly on the last point. */
  function resample(pts, h) {
    const out = [pts[0]];
    let carry = 0;                                       // distance already travelled since the last output point
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], len = dist(a, b);
      let pos = h - carry;
      while (pos <= len) { const t = len ? pos / len : 0; out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); pos += h; }
      carry = len - (pos - h);
    }
    const last = pts[pts.length - 1];
    if (dist(out[out.length - 1], last) > h * 0.25) out.push(last); else out[out.length - 1] = last;
    return out;
  }

  function smooth(pts, sigma) {
    if (pts.length < 3 || !(sigma > 0)) return pts;
    const total = pts.reduce((n, p, i) => n + (i ? dist(pts[i - 1], p) : 0), 0);
    const step = Math.max(sigma / 4, 0.5, total / 200000);       // sample spacing; bounded work for very long tracks
    const r = resample(pts, step), n = r.length, m = Math.ceil((3 * sigma) / step);
    const w = [];
    let wsum = 0;
    for (let k = -m; k <= m; k++) { const v = Math.exp(-((k * step) ** 2) / (2 * sigma * sigma)); w.push(v); wsum += v; }
    // Odd (point) reflection about the end points: the smoothed curve keeps the ends exactly and their direction.
    const at = (j) => {
      if (j < 0) { const q = r[Math.min(-j, n - 1)]; return { x: 2 * r[0].x - q.x, y: 2 * r[0].y - q.y }; }
      if (j > n - 1) { const q = r[Math.max(2 * (n - 1) - j, 0)]; return { x: 2 * r[n - 1].x - q.x, y: 2 * r[n - 1].y - q.y }; }
      return r[j];
    };
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0;
      for (let k = -m; k <= m; k++) { const q = at(i + k), wk = w[k + m]; x += q.x * wk; y += q.y * wk; }
      out[i] = { x: x / wsum, y: y / wsum };
    }
    return out;
  }

  function simplify(pts, tol) {
    if (pts.length < 3 || !(tol > 0)) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let far = -1, best = tol;
      for (let i = lo + 1; i < hi; i++) { const d = distToSeg(pts[i], pts[lo], pts[hi]); if (d > best) { best = d; far = i; } }
      if (far >= 0) { keep[far] = 1; stack.push([lo, far], [far, hi]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /** Largest distance from (a sample of) the original vertices to the cleaned polylines, in metres. */
  function maxShift(orig, cleaned) {
    const cap = 2000, stride = Math.max(1, Math.ceil(orig.reduce((n, s) => n + s.length, 0) / cap));
    let worst = 0;
    for (const seg of orig) for (let i = 0; i < seg.length; i += stride) {
      let best = Infinity;
      for (const c of cleaned) for (let j = 1; j < c.length && best > worst; j++) best = Math.min(best, distToSeg(seg[i], c[j - 1], c[j]));
      if (best < Infinity && best > worst) worst = best;
    }
    return worst;
  }

  /**
   * Clean a track. opts: { spikeM, spacingM, smoothM, simplifyM }, each 0/undefined = skip that step.
   * maxShiftM is measured from the original points that were not removed as spikes (a removed spike is not a "shift").
   * Returns { track, stats: { pointsBefore, pointsAfter, spikes, lengthBeforeKm, lengthAfterKm, maxShiftM, changed } }.
   */
  function cleanTrack(track, opts) {
    const o = opts || {};
    const before = track.segments.reduce((n, s) => n + s.length, 0);
    const f = localFrame(track);
    const orig = track.segments.map((seg) => seg.map((p) => toXY(p, f)));
    let spikes = 0;
    const reference = [];                    // the original points that were not dropped as spikes
    const cleaned = orig.map((seg) => {
      let pts = seg;
      if (o.spikeM > 0) { const r = removeSpikes(pts, o.spikeM); pts = r.pts; spikes += r.removed; }
      reference.push(pts);
      if (o.spacingM > 0) pts = minSpacing(pts, o.spacingM);
      // Smoothing resamples evenly (finer than the input), so thin the result a little: it must never add points.
      if (o.smoothM > 0) pts = simplify(smooth(pts, o.smoothM), Math.max(0.2, o.smoothM * 0.05));
      if (o.simplifyM > 0) pts = simplify(pts, o.simplifyM);
      return pts;
    });
    const changed = !!(o.spikeM > 0 || o.spacingM > 0 || o.smoothM > 0 || o.simplifyM > 0);
    let out = track;
    if (changed) {
      try { out = makeTrack(track.name, cleaned.map((seg) => seg.map((q) => toLL(q, f)))); } catch (e) { out = track; }
    }
    const after = out.segments.reduce((n, s) => n + s.length, 0);
    return {
      track: out,
      stats: {
        pointsBefore: before, pointsAfter: after, spikes, changed,
        lengthBeforeKm: trackLengthKm(track), lengthAfterKm: trackLengthKm(out),
        maxShiftM: changed && out !== track ? maxShift(reference, out.segments.map((seg) => seg.map((p) => toXY(p, f)))) : 0,
      },
    };
  }

  /** Track points in grid pixel coordinates (see frame note at the top). */
  function toPixels(track, bounds, W, H) {
    const sx = W / (bounds.east - bounds.west), sy = H / (bounds.north - bounds.south);
    return track.segments.map((seg) => seg.map((p) => ({ x: (p.lon - bounds.west) * sx, y: (bounds.north - p.lat) * sy })));
  }

  /**
   * Cross-section weight at distance d (px) from the centreline, for a line of radius r (px). Returns 0..1.
   *   uniform : flat top, 1 px soft edge (a constant-depth channel)
   *   rounded : half-circle section, sqrt(1 - (d/r)^2) (a ball-nose groove or round ridge)
   *   v       : linear taper to the centre (a V-bit groove)
   */
  function profile(shape, d, r) {
    if (shape === 'rounded') return d >= r ? 0 : Math.sqrt(1 - (d / r) * (d / r));
    if (shape === 'v') return d >= r ? 0 : 1 - d / r;
    const e = r + 0.5 - d;                     // uniform: ramp from 0 at r+0.5 to 1 at r-0.5
    return e <= 0 ? 0 : e >= 1 ? 1 : e;
  }

  /**
   * Rasterize the track into a W*H Float32Array of weights 0..1 (max-combined where lines overlap, so a
   * crossing never digs twice as deep). `radiusPx` is the half-width in pixels.
   */
  function rasterize(track, bounds, W, H, radiusPx, shape) {
    const r = Math.max(radiusPx, 0.75);        // never thinner than about 1.5 px
    const out = new Float32Array(W * H);
    const reach = r + 1;
    const MAX_PIECE = 48;                      // split long segments so each bounding box stays small
    for (const seg of toPixels(track, bounds, W, H)) {
      for (let i = 1; i < seg.length; i++) {
        const dx = seg[i].x - seg[i - 1].x, dy = seg[i].y - seg[i - 1].y;
        const pieces = Math.max(1, Math.ceil(Math.hypot(dx, dy) / MAX_PIECE));
        for (let k = 0; k < pieces; k++) {
          paintSegment(out, W, H,
            seg[i - 1].x + dx * (k / pieces), seg[i - 1].y + dy * (k / pieces),
            seg[i - 1].x + dx * ((k + 1) / pieces), seg[i - 1].y + dy * ((k + 1) / pieces), r, reach, shape);
        }
      }
    }
    return out;
  }

  function paintSegment(out, W, H, x0, y0, x1, y1, r, reach, shape) {
    const xa = Math.max(0, Math.floor(Math.min(x0, x1) - reach)), xb = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + reach));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1) - reach)), yb = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + reach));
    const vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const px = x + 0.5, py = y + 0.5;      // pixel centre
        let t = len2 ? ((px - x0) * vx + (py - y0) * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - (x0 + t * vx), py - (y0 + t * vy));
        if (d >= reach) continue;
        const w = profile(shape, d, r);
        const idx = y * W + x;
        if (w > out[idx]) out[idx] = w;
      }
    }
  }

  const api = { cleanTrack, removeSpikes, minSpacing, smooth, simplify, resample, distToSeg, localFrame, parseTrackText, trackBounds, padBounds, trackLengthKm, toPixels, profile, rasterize, makeTrack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCTrack = api;
})(typeof self !== 'undefined' ? self : this);
