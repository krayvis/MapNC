/* OpenStreetMap roads and water for the vector export, fetched from the Overpass API (works straight from the browser).
 *
 * Kinds: roads (motorway..tertiary), roads_minor (streets, tracks), water (rivers, canals, streams), lakes (outlines).
 * Flow: areaProblem() -> fetchFeatures() (cached, polite, falls back between public servers) -> toLayers() which projects
 * into heightmap pixels (the same linear lat/lon frame as Track.toPixels), clips to the heightmap's extent and thins.
 *
 * The data is © OpenStreetMap contributors, ODbL. CREDIT is the text to put on anything made from it.
 * Overpass is a shared free service: keep queries small (see LIMITS), one at a time, and cached.
 */
(function (root) {
  'use strict';
  const Contours = root.MapNCContours || (typeof require !== 'undefined' ? require('./contours.js') : null);

  const CREDIT = 'Contains data © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright';
  const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  /** Longest side of the region (metres) each kind may be asked for. Dense minor roads get a much smaller area. */
  const LIMITS = { roads: 50000, water: 50000, lakes: 50000, roads_minor: 8000 };
  const KINDS = Object.keys(LIMITS);
  const MIN_GAP_MS = 1100;                                      // between requests to the same service

  const HIGHWAY_MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
  const HIGHWAY_MINOR = /^(unclassified|residential|living_street|service|track|road)$/;
  const WATERWAY = /^(river|canal|stream)$/;

  /** A message if the region is too big for the requested kinds, else null. */
  function areaProblem(longM, kinds) {
    for (const k of kinds) {
      if (longM > LIMITS[k]) {
        const km = LIMITS[k] / 1000;
        return (k === 'roads_minor' ? 'Minor roads' : k === 'roads' ? 'Main roads' : k === 'water' ? 'Rivers and streams' : 'Lakes') +
          ' are limited to regions up to ' + km + ' km on the long side (this one is ' + (longM / 1000).toFixed(1) + ' km), to keep the OpenStreetMap request small.';
      }
    }
    return null;
  }

  function buildQuery(b, kinds) {
    const bb = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
    const q = [];
    if (kinds.includes('roads')) q.push('way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](' + bb + ');');
    if (kinds.includes('roads_minor')) q.push('way["highway"~"^(unclassified|residential|living_street|service|track|road)$"](' + bb + ');');
    if (kinds.includes('water')) q.push('way["waterway"~"^(river|canal|stream)$"](' + bb + ');');
    if (kinds.includes('lakes')) q.push('way["natural"="water"](' + bb + ');', 'relation["natural"="water"](' + bb + ');');
    return '[out:json][timeout:40];(' + q.join('') + ');out geom;';
  }

  /** Which of our kinds an OSM element belongs to, or null. */
  function classify(tags) {
    if (!tags) return null;
    if (tags.highway) return HIGHWAY_MAJOR.test(tags.highway) ? 'roads' : HIGHWAY_MINOR.test(tags.highway) ? 'roads_minor' : null;
    if (tags.waterway) return WATERWAY.test(tags.waterway) ? 'water' : null;
    if (tags.natural === 'water') return 'lakes';
    return null;
  }

  const key = (p) => p.lat.toFixed(7) + ',' + p.lon.toFixed(7);

  /** Joins polylines that share end points into longer ones (a lake relation arrives as several ways). */
  function stitch(parts) {
    const todo = parts.filter((p) => p.length >= 2).map((p) => p.slice()), out = [];
    while (todo.length) {
      let cur = todo.pop(), grew = true;
      while (grew && key(cur[0]) !== key(cur[cur.length - 1])) {
        grew = false;
        for (let i = 0; i < todo.length; i++) {
          const t = todo[i], head = key(cur[0]), tail = key(cur[cur.length - 1]);
          if (key(t[0]) === tail) cur = cur.concat(t.slice(1));
          else if (key(t[t.length - 1]) === tail) cur = cur.concat(t.slice(0, -1).reverse());
          else if (key(t[t.length - 1]) === head) cur = t.concat(cur.slice(1));
          else if (key(t[0]) === head) cur = t.slice(1).reverse().concat(cur);
          else continue;
          todo.splice(i, 1); grew = true; break;
        }
      }
      out.push(cur);
    }
    return out;
  }

  /** Overpass `out geom` JSON -> [{ kind, name, pts: [{lat, lon}] }]. Elements of other kinds are dropped. */
  function parse(json) {
    const out = [];
    for (const el of (json && json.elements) || []) {
      const kind = classify(el.tags);
      if (!kind) continue;
      if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
        out.push({ kind, name: el.tags.name || '', pts: el.geometry.map((g) => ({ lat: g.lat, lon: g.lon })) });
      } else if (el.type === 'relation' && el.members) {
        const parts = el.members.filter((m) => m.type === 'way' && m.geometry && m.geometry.length >= 2)
          .map((m) => m.geometry.map((g) => ({ lat: g.lat, lon: g.lon })));
        for (const ring of stitch(parts)) out.push({ kind, name: el.tags.name || '', pts: ring });
      }
    }
    return out;
  }

  // ---- fetching ----

  const cache = new Map();                                       // request key -> features
  let lastRequestAt = 0, chain = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cacheKey = (b, kinds) => JSON.stringify([b.south, b.west, b.north, b.east].map((v) => +v.toFixed(5)).concat([kinds.slice().sort()]));

  /**
   * Features for the kinds inside bounds. Cached per (bounds, kinds); requests run one at a time, at least MIN_GAP_MS apart,
   * and fall back to the second public server on a network error, 429 or 5xx. opts.fetch / opts.endpoints / opts.signal are for tests and cancelling.
   * Throws an Error with a plain-language message on failure.
   */
  function fetchFeatures(bounds, kinds, opts) {
    const o = opts || {};
    kinds = kinds.filter((k) => KINDS.includes(k));
    if (!kinds.length) return Promise.resolve([]);
    const ck = cacheKey(bounds, kinds);
    if (cache.has(ck)) return Promise.resolve(cache.get(ck));
    const run = chain.then(async () => {
      if (cache.has(ck)) return cache.get(ck);
      const doFetch = o.fetch || ((...a) => root.fetch(...a));
      const body = 'data=' + encodeURIComponent(buildQuery(bounds, kinds));
      let lastErr = null;
      for (const url of o.endpoints || ENDPOINTS) {
        const wait = lastRequestAt + (o.minGapMs == null ? MIN_GAP_MS : o.minGapMs) - Date.now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
        try {
          const res = await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: o.signal });
          if (!res.ok) { lastErr = new Error('OpenStreetMap server answered ' + res.status + (res.status === 429 ? ' (busy, try again in a minute)' : '')); continue; }
          const json = await res.json();
          if (json.remark && /error|timed out|out of memory/i.test(json.remark) && !(json.elements || []).length) {
            lastErr = new Error('OpenStreetMap server could not finish the query (' + json.remark.replace(/^runtime error:\s*/i, '') + '). Try a smaller region.'); continue;
          }
          const feats = parse(json);
          cache.set(ck, feats);
          return feats;
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          lastErr = new Error('Could not reach the OpenStreetMap server (' + (err && err.message || 'network error') + ').');
        }
      }
      throw lastErr || new Error('Could not reach the OpenStreetMap server.');
    });
    chain = run.catch(() => {});
    return run;
  }

  // ---- projection, clipping, thinning ----

  /** Liang-Barsky: the [t0, t1] part of segment a-b inside [0,W]x[0,H], or null. */
  function clipSeg(a, b, W, H) {
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y, p = [-dx, dx, -dy, dy], q = [a.x, W - a.x, a.y, H - a.y];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  }

  /** The runs of a polyline that lie inside the rectangle. */
  function clipLine(pts, W, H) {
    const out = [];
    let cur = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], c = clipSeg(a, b, W, H);
      if (!c) { cur = null; continue; }
      const at = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      if (!cur || c[0] > 0) { cur = [at(c[0])]; out.push(cur); }
      cur.push(at(c[1]));
      if (c[1] < 1) cur = null;
    }
    return out;
  }

  const lengthOf = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; };

  /**
   * Features -> { roads: [[{x,y}...]], roads_minor, water, lakes } in heightmap pixels, clipped to 0..W x 0..H.
   * opts.tol: thinning tolerance in px (default 0.4); opts.minLen: drop runs shorter than this many px (default 6).
   */
  function toLayers(features, bounds, W, H, opts) {
    const o = opts || {}, tol = o.tol == null ? 0.4 : o.tol, minLen = o.minLen == null ? 6 : o.minLen;
    const sx = W / (bounds.east - bounds.west), sy = H / (bounds.north - bounds.south);
    const out = { roads: [], roads_minor: [], water: [], lakes: [] };
    for (const f of features) {
      const px = f.pts.map((p) => ({ x: (p.lon - bounds.west) * sx, y: (bounds.north - p.lat) * sy }));
      for (let run of clipLine(px, W, H)) {
        run = Contours.thin(run, tol);
        if (run.length >= 2 && lengthOf(run) >= minLen) out[f.kind].push(run);
      }
    }
    return out;
  }

  const api = { CREDIT, LIMITS, KINDS, ENDPOINTS, areaProblem, buildQuery, classify, parse, stitch, fetchFeatures, clipSeg, clipLine, toLayers, clearCache: () => cache.clear() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCOsm = api;
})(typeof self !== 'undefined' ? self : this);
