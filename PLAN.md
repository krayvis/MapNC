# MapNC build plan

Static, client-side proof of concept. No backend, no build step. Everything runs in the browser.

## Files

| File | Role |
|------|------|
| `index.html` | Page shell, controls, script tags |
| `css/style.css` | Layout |
| `js/geo.js` | Pure geometry: ground size, US detection, source choice, Terrarium zoom/tile maths, size cap (no DOM, unit-testable in Node) |
| `js/app.js` | Leaflet map, rectangle drawing/editing, status panel |
| `js/sources.js` *(phase 2)* | 3DEP + Terrarium fetchers, stitching, resampling to a ground-correct grid |
| `js/heightmap.js` *(phase 3)* | Elevation → grey mapping, 16/8-bit PNG encoding (UPNG.js) |
| `js/track.js` *(phase 4)* | GPX (TCX/FIT if easy) parsing, route overlay, transparent route PNG |
| `vendor/` | Leaflet 1.9.4 (vendored, so no CDN dependency) |

## Phases

1. **Map + region selection** *(this check-in)*: Leaflet map, draw/resize a rectangle, ground-size and output-grid estimate, size cap, source auto-detect and resolution readout.
2. **Elevation fetch + stitch**: Terrarium tiles → decode; 3DEP `exportImage` (float32 GeoTIFF via geotiff.js), split into sub-requests; resample to an equirectangular grid corrected by cos(lat) so aspect is ground-true.
3. **Heightmap + export**: auto / manual range, vertical exaggeration, 8-bit canvas preview, 16-bit PNG from `Uint16Array`, optional 8-bit, elevation range and metres per grey level.
4. **Track overlay** *(after check-in)*: GPX parse, fit region to track bbox + margin, draw route over the preview, export transparent route PNG.
5. **README + Pages deploy**, attributions (USGS 3DEP, AWS Terrain Tiles and its underlying datasets, map tile provider).

## Decisions and open risks

- **Cap**: native grid at most 4096 px per side and 16.7 M samples total (Float32 = 64 MB). Over the cap, the rectangle turns red and export is blocked. Phase 2 may offer coarser resampling instead.
- **Aspect**: Mercator is locally conformal, but scale varies with latitude across the box. The output grid is built from ground distance (`Δlon · cos(midLat)` by `Δlat`), not from raw tile pixels.
- **Auto-detect**: 3DEP only when the whole rectangle lies inside rough CONUS or Hawaii bounds. Alaska coverage is patchy, so it falls back to Terrarium unless the user forces 3DEP. Rough boxes include some ocean and Canada/Mexico; the ImageServer returns NoData there, which phase 2 must handle.
- **CORS** (checked 2026-10-02): AWS Terrarium returns `Access-Control-Allow-Origin: *`. **3DEP is not yet verified**: the dev sandbox blocks `elevation.nationalmap.gov`, so CORS and the real max request size must be checked from a browser. Phase 2 will use conservative sub-requests (about 2000 px per side) and read `maxImageWidth/Height` from the service JSON at runtime.
- **Terrarium resolution** is a tile-pixel size. Underlying data is far coarser in many places (about 30 m globally), so the UI shows tile pixel size and says so.
- **Map tiles**: OpenStreetMap standard tiles are fine for a low-traffic PoC but not for heavy use (tile usage policy). Swap the provider before wider sharing.
