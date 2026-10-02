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

  /** Highest Terrarium zoom whose grid fits the cap and tile budget. Returns null if even z0..z8 fail. */
  function pickTerrariumZoom(b) {
    const mid = (b.south + b.north) / 2;
    for (let z = LIMITS.maxTerrariumZoom; z >= 0; z--) {
      const grid = gridFor(b, terrariumPixelM(mid, z));
      const tiles = tileRange(b, z);
      if (!overCap(grid) && tiles.count <= LIMITS.maxTiles) return { z, grid, tiles };
    }
    return null;
  }

  /**
   * Choose a source. `pref` is 'auto' | '3dep' | 'terrarium'.
   * Returns { id, label, resolutionM, resolutionNote, grid, zoom?, tiles?, fellBack? }.
   */
  function planSource(b, pref) {
    const region = us3depRegion(b);
    let id = pref;
    let fellBack = false;
    if (pref === 'auto') id = region ? '3dep' : 'terrarium';

    if (id === '3dep') {
      const grid = gridFor(b, DEP_NOMINAL_RES_M);
      return {
        id, fellBack, region,
        label: 'USGS 3DEP',
        resolutionM: DEP_NOMINAL_RES_M,
        resolutionNote: region ? '~10 m (1/3 arc-second)' : '~10 m where covered (outside CONUS/Hawaii, expect NoData)',
        grid,
      };
    }
    const pick = pickTerrariumZoom(b);
    if (!pick) {
      return { id: 'terrarium', fellBack, label: 'AWS Terrain Tiles', resolutionM: null, resolutionNote: 'region too large', grid: gridFor(b, 1), tooLarge: true };
    }
    return {
      id: 'terrarium', fellBack,
      label: 'AWS Terrain Tiles (Terrarium)',
      resolutionM: pick.grid.resM,
      resolutionNote: '~' + pick.grid.resM.toFixed(0) + ' m tile pixels (zoom ' + pick.z + '; source data is often coarser)',
      grid: pick.grid, zoom: pick.z, tiles: pick.tiles,
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

  const api = { groundRatio, boxAround, centreOf, constrainCorner, reshapeBounds, moveBounds, parseRatio, LIMITS, lonToTileX, latToTileY, setMaxSide, memoryEstimateMB, DEP_NOMINAL_RES_M, normalizeBounds, groundSize, us3depRegion, terrariumPixelM, tileRange, gridFor, overCap, pickTerrariumZoom, planSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCGeo = api;
})(typeof self !== 'undefined' ? self : this);
