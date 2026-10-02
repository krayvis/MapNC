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

  const LIMITS = {
    maxSide: 4096,                   // samples per side
    maxSamples: 4096 * 4096,         // Float32 elevation grid = 64 MB at the cap
    maxTiles: 144,                   // Terrarium tiles fetched per region
    maxTerrariumZoom: 15,            // top of the Terrarium pyramid
  };

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

  const api = { LIMITS, normalizeBounds, groundSize, us3depRegion, terrariumPixelM, tileRange, gridFor, overCap, pickTerrariumZoom, planSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCGeo = api;
})(typeof self !== 'undefined' ? self : this);
