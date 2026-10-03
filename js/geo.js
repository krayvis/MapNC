/* Pure geometry helpers for MapNC. No DOM access, so this can be loaded in Node for tests.
 *
 * Frames used here:
 *   - "bounds"  = { south, west, north, east } in degrees (WGS84, lon/lat, north-up).
 *   - "ground"  = metres on the surface, east (x) and north (y).
 *   - "grid"    = output heightmap samples, x = east, y = south-down image rows.
 */
(function (root) {
  'use strict';

  const DEG = Math.PI / 180;
  const M_PER_DEG_LAT = 110574;      // metres per degree latitude (near equator; varies ~1% to the poles)
  const M_PER_DEG_LON_EQ = 111320;   // metres per degree longitude at the equator
  const EARTH_CIRC = 40075016.686;   // equatorial circumference, metres (Web Mercator)

  const DEFAULT_MAX_SIDE = 4096;
  const LIMITS = {
    maxSide: DEFAULT_MAX_SIDE,       // samples per side
    maxSamples: DEFAULT_MAX_SIDE * DEFAULT_MAX_SIDE, // Float32 elevation grid = 64 MB at 4096
    maxTiles: 144,                   // Terrarium tiles fetched per region (scales with the cap)
    maxTerrariumZoom: 15,            // top of the Terrarium pyramid
  };

  /** User-adjustable cap. Tile budget scales with the sample budget so a bigger cap is reachable. */
  function setMaxSide(n) {
    LIMITS.maxSide = n;
    LIMITS.maxSamples = n * n;
    LIMITS.maxTiles = Math.round(144 * (n / DEFAULT_MAX_SIDE) * (n / DEFAULT_MAX_SIDE));
  }

  /** Approximate peak memory (MB) for a fetch at this grid: Float32 grid + Terrarium mosaic + 16-bit output. */
  function memoryEstimateMB(grid, plan) {
    const samples = grid.width * grid.height;
    let bytes = samples * 4 + samples * 2;
    if (plan && plan.id === 'terrarium' && plan.tiles) bytes += plan.tiles.count * 256 * 256 * 4;
    return bytes / 1048576;
  }

  // Rough 3DEP 1/3 arc-second coverage. Deliberately coarse: the ImageServer returns NoData outside
  // real coverage. Alaska is left out of auto-detect because its coverage is patchy.
  const US_3DEP_BOXES = [
    { name: 'CONUS', south: 24.5, west: -125.0, north: 49.5, east: -66.9 },
    { name: 'Hawaii', south: 18.8, west: -160.4, north: 22.4, east: -154.7 },
  ];
  const DEP_NOMINAL_RES_M = 10;      // 1/3 arc-second is about 10 m

  // Rough outline of Canada, [lon, lat] going clockwise from the Pacific end of the 49th parallel. The southern edge
  // follows the US border (through the Great Lakes by their middle), the rest is a loose coastline that errs toward
  // including water. Only used to auto-pick the Canadian source, which needs all four corners of the region inside;
  // near a coast or the border the choice falls back to the global source, and the user can pick Canada by hand.
  const CANADA_OUTLINE = [
    [-123.3, 49.0], [-123.0, 48.6], [-123.4, 48.3], [-124.8, 48.4], [-128.5, 50.5], [-131.2, 53.5], [-130.0, 54.7],
    [-130.0, 55.9], [-131.0, 56.7], [-133.0, 58.2], [-135.0, 59.7], [-137.5, 59.0], [-139.0, 60.3], [-141.0, 60.3],
    [-141.0, 83.0], [-60.0, 83.0], [-60.0, 67.0], [-55.5, 53.5], [-52.5, 52.0], [-52.5, 47.5], [-53.0, 46.6],
    [-56.0, 46.6], [-59.5, 45.8], [-60.2, 45.2], [-61.5, 45.0], [-63.5, 44.5], [-66.0, 43.5], [-66.3, 44.4],
    [-67.0, 44.9], [-67.4, 45.2], [-67.8, 45.7], [-67.8, 47.07], [-68.3, 47.35], [-69.2, 47.45], [-70.0, 46.7],
    [-70.3, 45.9], [-71.1, 45.3], [-71.5, 45.0], [-74.7, 45.0], [-75.3, 44.85], [-76.3, 44.1], [-76.5, 43.6],
    [-79.0, 43.3], [-78.9, 42.9], [-79.0, 42.8], [-81.0, 42.2], [-82.5, 41.7], [-83.1, 42.0], [-83.1, 42.3],
    [-82.8, 42.4], [-82.4, 43.0], [-82.5, 44.0], [-82.4, 45.2], [-83.5, 45.9], [-84.0, 46.0], [-84.4, 46.5],
    [-85.0, 47.1], [-88.0, 48.3], [-89.6, 48.0], [-90.8, 48.2], [-91.5, 48.05], [-92.0, 48.3], [-93.0, 48.6],
    [-94.3, 48.7], [-95.15, 49.0],
  ];

  function normalizeBounds(a, b) {
    return {
      south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
      west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    };
  }

  /** Ground size of the box in metres, using the mid-latitude for longitude shrinkage. */
  function groundSize(b) {
    const midLat = (b.south + b.north) / 2;
    return {
      midLat,
      widthM: (b.east - b.west) * M_PER_DEG_LON_EQ * Math.cos(midLat * DEG),
      heightM: (b.north - b.south) * M_PER_DEG_LAT,
    };
  }

  function insideBox(b, box) {
    return b.south >= box.south && b.north <= box.north && b.west >= box.west && b.east <= box.east;
  }

  /** Name of the 3DEP coverage box that fully contains the region, or null. */
  function us3depRegion(b) {
    for (const box of US_3DEP_BOXES) if (insideBox(b, box)) return box.name;
    return null;
  }

  function insideOutline(lon, lat, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /**
   * How the region sits against the (rough) Canadian outline: 'in' (all four corners inside), 'out' (none), or
   * 'edge' (some of each: it crosses the border or a coast).
   */
  function canadaRegion(b) {
    let n = 0;
    for (const [lon, lat] of [[b.west, b.south], [b.west, b.north], [b.east, b.south], [b.east, b.north]]) if (insideOutline(lon, lat, CANADA_OUTLINE)) n++;
    return n === 4 ? 'in' : n === 0 ? 'out' : 'edge';
  }

  /** Metres per Web Mercator pixel (256 px tiles) at a latitude and zoom. */
  function terrariumPixelM(latDeg, z) {
    return (EARTH_CIRC * Math.cos(latDeg * DEG)) / (256 * Math.pow(2, z));
  }

  function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
  function latToTileY(lat, z) {
    const r = lat * DEG;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z);
  }

  /** Inclusive integer tile range covering the box at zoom z. */
  function tileRange(b, z) {
    const n = Math.pow(2, z);
    const clamp = (v) => Math.max(0, Math.min(n - 1, Math.floor(v)));
    const x0 = clamp(lonToTileX(b.west, z)), x1 = clamp(lonToTileX(b.east, z));
    const y0 = clamp(latToTileY(b.north, z)), y1 = clamp(latToTileY(b.south, z));
    return { z, x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }

  /** Output grid for a given ground pixel size (metres per sample). */
  function gridFor(b, resM) {
    const g = groundSize(b);
    return { width: Math.max(1, Math.round(g.widthM / resM)), height: Math.max(1, Math.round(g.heightM / resM)), resM };
  }

  function overCap(grid) {
    return grid.width > LIMITS.maxSide || grid.height > LIMITS.maxSide || grid.width * grid.height > LIMITS.maxSamples;
  }

  // ---- output resolution ---------------------------------------------------------------------
  // The output grid's pixel size is chosen by the user and is independent of the source's true resolution. Upscaling
  // adds no real detail, but it gives CAM software a smooth surface (and a smoothly rasterized route) instead of a
  // visibly stair-stepped one. The source is always sampled with a smooth (cubic) filter when upscaling.

  const AUTO_MIN_PX = 2048;               // Auto: long side is at least this many pixels
  const TERRARIUM_NATIVE_RES_M = 30;      // honest data resolution for "scale x source" (SRTM-class); tiles are finer

  // The Canadian mosaic is 1 to 2 m where lidar exists and 20 to 30 m elsewhere, and the service does not say which, so the
  // 10 m used here is a middle value, enough for the resolution advice to be sensible either way.
  const CANADA_NOMINAL_RES_M = 10;

  function nativeResM(id) { return id === '3dep' ? DEP_NOMINAL_RES_M : id === 'canada' ? CANADA_NOMINAL_RES_M : TERRARIUM_NATIVE_RES_M; }

  /**
   * Metres per output pixel for a resolution spec { mode, value }:
   *   auto   : long side >= AUTO_MIN_PX, never coarser than the source; relaxed to fit the size cap
   *   scale  : value x finer than the source (4 = 4 times as many pixels per side as source samples)
   *   pixels : value pixels on the long side
   *   mpp    : value metres per pixel
   */
  function chooseResM(b, nativeRes, spec) {
    const g = groundSize(b), longM = Math.max(g.widthM, g.heightM);
    const mode = (spec && spec.mode) || 'auto', v = Number(spec && spec.value);
    if (mode === 'scale') return v > 0 ? nativeRes / v : nativeRes;
    if (mode === 'pixels') return v > 0 ? longM / v : nativeRes;
    if (mode === 'mpp') return v > 0 ? v : nativeRes;
    const target = Math.max(longM / nativeRes, AUTO_MIN_PX);
    return Math.max(longM / target, longM / LIMITS.maxSide);   // a region too large for the cap is coarsened, not refused
  }

  /** Terrarium zoom whose tile pixels are at least as fine as resM (so tiles are upsampled, never stretched). */
  function zoomForRes(latDeg, resM) {
    const z = Math.ceil(Math.log2((EARTH_CIRC * Math.cos(latDeg * DEG)) / (256 * resM)));
    return Math.max(0, Math.min(LIMITS.maxTerrariumZoom, z));
  }

  /**
   * Choose a source and output grid. `pref` is 'auto' | '3dep' | 'canada' | 'terrarium'; `spec` is the resolution spec above.
   * Auto: Canada when the region is inside the outline, otherwise 3DEP inside its US boxes (and not across the border:
   * a region that crosses the Canadian outline has no single high-resolution source, so it gets the global one).
   * Returns { id, label, resolutionM (source), outputResM, resolutionNote, grid, interpolation?, zoom?, tiles?, tooLarge? }.
   */
  function planSource(b, pref, spec) {
    const ca = canadaRegion(b);
    const region = us3depRegion(b);
    const id = pref === 'auto' ? (ca === 'in' ? 'canada' : ca === 'edge' ? 'terrarium' : region ? '3dep' : 'terrarium') : pref;
    const native = nativeResM(id);
    const outRes = chooseResM(b, native, spec);
    const grid = gridFor(b, outRes);
    const up = native / outRes;                                  // >1 means finer than the source
    const factor = up > 1.05 ? ', output ' + up.toFixed(1) + '× finer (smooth cubic upscale)' : up < 0.95 ? ', output coarser than source' : '';

    if (id === '3dep') {
      return {
        id, region, label: 'USGS 3DEP', resolutionM: native, outputResM: outRes, grid,
        interpolation: up > 1.05 ? 'cubic' : 'bilinear',
        resolutionNote: (region ? '~10 m (1/3 arc-second)' : '~10 m where covered (outside CONUS/Hawaii, expect NoData)') + factor,
      };
    }
    if (id === 'canada') {
      return {
        id, region: ca === 'in' ? 'Canada' : null, label: 'NRCan High Resolution DEM', resolutionM: native, outputResM: outRes, grid,
        resolutionNote: '1 to 2 m where lidar exists, 20 to 30 m elsewhere (varies; shown as ~10 m)' + (ca === 'in' ? '' : '; the region may reach past Canadian coverage, expect NoData') + (up > 1.05 ? ', output ' + up.toFixed(1) + '× finer than the assumed source (the service does the upscaling)' : up < 0.95 ? ', output coarser than source' : ''),
      };
    }
    const mid = (b.south + b.north) / 2;
    let z = zoomForRes(mid, outRes), tiles = tileRange(b, z);
    while (tiles.count > LIMITS.maxTiles && z > 0) { z--; tiles = tileRange(b, z); }
    if (tiles.count > LIMITS.maxTiles) {
      return { id, region, label: 'AWS Terrain Tiles', resolutionM: native, outputResM: outRes, grid, resolutionNote: 'region too large', tooLarge: true };
    }
    return {
      id, region, label: 'AWS Terrain Tiles (Terrarium)', resolutionM: native, outputResM: outRes, grid, zoom: z, tiles,
      resolutionNote: 'zoom ' + z + ' tiles (' + terrariumPixelM(mid, z).toFixed(0) + ' m pixels; data is often ~30 m)' + factor,
    };
  }

  // ---- rectangle editing (aspect lock, move) -------------------------------------------------
  // Ratios are GROUND ratios, east-west metres : north-south metres, i.e. what is physically carved, not map
  // pixels (Web Mercator stretches east-west with latitude). All results keep the same ground-size convention as
  // groundSize(): longitude shrinks with cos(latitude at the rectangle's centre).

  const MAX_LAT = 85;
  const clampLat = (v) => Math.max(-MAX_LAT, Math.min(MAX_LAT, v));

  /** East-west : north-south ground ratio of a box. */
  function groundRatio(b) {
    const g = groundSize(b);
    return g.widthM / g.heightM;
  }

  /** Box of the given ground size centred on `c` ({lat, lng}); latitude is kept inside +/-85 degrees. */
  function boxAround(c, widthM, heightM) {
    const dLat = heightM / M_PER_DEG_LAT;
    const lat = Math.max(-MAX_LAT + dLat / 2, Math.min(MAX_LAT - dLat / 2, c.lat));
    const dLon = widthM / (M_PER_DEG_LON_EQ * Math.cos(lat * DEG));
    return { south: lat - dLat / 2, north: lat + dLat / 2, west: c.lng - dLon / 2, east: c.lng + dLon / 2 };
  }

  function centreOf(b) { return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 }; }

  /**
   * Corner opposite `anchor`, dragged toward `point`, forced to ground ratio `ratio` (w/h). The box always
   * reaches at least as far as the pointer on both axes (so the corner stays under the finger and the box grows
   * with the drag rather than lagging behind it).
   */
  function constrainCorner(anchor, point, ratio) {
    const sx = point.lng >= anchor.lng ? 1 : -1, sy = point.lat >= anchor.lat ? 1 : -1;
    const dLonDeg = Math.abs(point.lng - anchor.lng), dy = Math.abs(point.lat - anchor.lat) * M_PER_DEG_LAT;
    let cosLat = Math.cos(anchor.lat * DEG), w = 0, h = 0;
    for (let i = 0; i < 3; i++) {                    // cos(lat) depends on the box's own mid-latitude; settle it
      w = Math.max(dLonDeg * M_PER_DEG_LON_EQ * cosLat, dy * ratio);
      h = w / ratio;
      cosLat = Math.cos((anchor.lat + (sy * h) / M_PER_DEG_LAT / 2) * DEG);
    }
    return { lat: clampLat(anchor.lat + (sy * h) / M_PER_DEG_LAT), lng: anchor.lng + (sx * w) / (M_PER_DEG_LON_EQ * cosLat) };
  }

  /**
   * Box centred on `c` whose corner is dragged to `point` (resize from the centre): the opposite corner mirrors, so the
   * centre never moves. With a ratio, the box is forced to that ground ratio and still reaches the pointer on both axes.
   * Half-extents use cos(latitude of the centre), which is also the box's mid-latitude, so the ground ratio is exact.
   */
  function centredBounds(c, point, ratio) {
    const cosLat = Math.cos(c.lat * DEG);
    let halfLon = Math.abs(point.lng - c.lng), halfLat = Math.abs(point.lat - c.lat);
    if (ratio) {
      const w = Math.max(halfLon * M_PER_DEG_LON_EQ * cosLat, halfLat * M_PER_DEG_LAT * ratio);   // half-width in metres
      halfLon = w / (M_PER_DEG_LON_EQ * cosLat);
      halfLat = w / ratio / M_PER_DEG_LAT;
    }
    halfLat = Math.min(halfLat, MAX_LAT - Math.abs(c.lat));       // stay inside +/-85 degrees latitude
    return { south: c.lat - halfLat, north: c.lat + halfLat, west: c.lng - halfLon, east: c.lng + halfLon };
  }

  /**
   * Re-shape a box to a ground ratio about its centre. mode 'inside' shrinks one side to fit within the old box;
   * 'outside' grows one side so the old box fits within the new one (used when the box must keep containing a
   * route); 'area' keeps the ground area (same size, new shape; used when the ratio changes or is swapped).
   */
  function reshapeBounds(b, ratio, mode) {
    const g = groundSize(b);
    let w;
    if (mode === 'outside') w = Math.max(g.widthM, g.heightM * ratio);
    else if (mode === 'area') w = Math.sqrt(g.widthM * g.heightM * ratio);
    else w = Math.min(g.widthM, g.heightM * ratio);
    return boxAround(centreOf(b), w, w / ratio);
  }

  /** Same ground size, new centre. Moving north or south must not change what is carved. */
  function moveBounds(b, centre) {
    const g = groundSize(b);
    return boxAround(centre, g.widthM, g.heightM);
  }

  /** Parse "w:h" or numbers into a ratio, or null for free. */
  function parseRatio(w, h) {
    const a = Number(w), c = Number(h);
    return a > 0 && c > 0 && Number.isFinite(a) && Number.isFinite(c) ? a / c : null;
  }

  const api = { centredBounds, groundRatio, boxAround, centreOf, constrainCorner, reshapeBounds, moveBounds, parseRatio, LIMITS, lonToTileX, latToTileY, setMaxSide, memoryEstimateMB, DEP_NOMINAL_RES_M, normalizeBounds, groundSize, us3depRegion, canadaRegion, CANADA_OUTLINE, terrariumPixelM, tileRange, gridFor, overCap, chooseResM, zoomForRes, nativeResM, AUTO_MIN_PX, planSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCGeo = api;
})(typeof self !== 'undefined' ? self : this);
