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

  const api = { parseTrackText, trackBounds, padBounds, trackLengthKm, toPixels, profile, rasterize, makeTrack };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCTrack = api;
})(typeof self !== 'undefined' ? self : this);
