# MapNC build plan

Static, client-side proof of concept. No backend, no build step. Everything runs in the browser.

## Files

| File | Role |
|------|------|
| `index.html` | Page shell, controls, script tags |
| `css/style.css` | Layout |
| `js/geo.js` | Pure geometry: ground size, US detection, source choice, Terrarium zoom/tile maths, size cap (no DOM, unit-testable in Node) |
| `js/app.js` | Leaflet map, rectangle drawing/editing, status panel |
| `js/sources.js` | 3DEP + Terrarium fetchers, stitching, resampling to a ground-correct grid |
| `js/heightmap.js` | Elevation → grey mapping, 16/8-bit PNG encoding (own encoder + `CompressionStream`) |
| `js/track.js` | GPX (TCX/FIT if easy) parsing, route overlay, transparent route PNG |
| `vendor/` | Leaflet 1.9.4 (vendored, so no CDN dependency) |

## Phases

1. **Map + region selection** *(done)*: Leaflet map, draw/resize a rectangle, ground-size and output-grid estimate, size cap, source auto-detect and resolution readout.
2. **Elevation fetch + stitch** *(done; tested with real Terrarium data and a mocked 3DEP service)*: Terrarium tiles → decode; 3DEP `exportImage` (float32 GeoTIFF via geotiff.js), split into sub-requests; resample to an equirectangular grid corrected by cos(lat) so aspect is ground-true.
3. **Heightmap + export** *(done; PNG encoder verified bit-exact with Pillow, `js/heightmap.js` uses the browser's CompressionStream instead of UPNG.js, so no dependency)*: auto / manual range, vertical exaggeration, 8-bit canvas preview, 16-bit PNG from `Uint16Array`, optional 8-bit, elevation range and metres per grey level.
4. **Track overlay** *(done; burn-in verified against independent numpy maths for all three profiles; TCX supported, FIT not)*: GPX parse, fit region to track bbox + margin, draw route over the preview, export transparent route PNG.
5. **README + Pages deploy** *(README and workflow written; Pages source must be set to GitHub Actions once in repo Settings)*, attributions (USGS 3DEP, AWS Terrain Tiles and its underlying datasets, map tile provider).

## Decisions and open risks

- **Carve sizes** (owner, 2026-10-02): 3×3 in up to 16×16 in. At 4096 px that is about 0.02–0.1 mm per pixel, far finer than a bit's stepover, so the cap is rarely the limit; source resolution is. Size/resolution/file-size limits to be refined later.
- **Cap**: native grid at most 4096 px per side and 16.7 M samples total (Float32 = 64 MB). Over the cap, the rectangle turns red and export is blocked. Phase 2 may offer coarser resampling instead.
- **Aspect**: Mercator is locally conformal, but scale varies with latitude across the box. The output grid is built from ground distance (`Δlon · cos(midLat)` by `Δlat`), not from raw tile pixels.
- **Auto-detect**: 3DEP only when the whole rectangle lies inside rough CONUS or Hawaii bounds. Alaska coverage is patchy, so it falls back to Terrarium unless the user forces 3DEP. Rough boxes include some ocean and Canada/Mexico; the ImageServer returns NoData there, which phase 2 must handle.
- **CORS** (2026-10-02): AWS Terrarium returns `Access-Control-Allow-Origin: *`. 3DEP: the dev sandbox blocks `elevation.nationalmap.gov`; the project owner confirmed from a browser that it works. Requests are split into chunks of at most 2000 px per side. Reading `maxImageWidth/Height` from the service JSON at runtime is still open (the 2000 px chunk is a conservative guess). The 3DEP code path has only been tested against a mock; a real-service run is still needed.
- **Cap**: adjustable in Advanced (2048 to 16384 px per side). 16384 needs roughly 1.5 GB for a Terrarium fetch and may crash the tab.
- **Terrarium resolution** is a tile-pixel size. Underlying data is far coarser in many places (about 30 m globally), so the UI shows tile pixel size and says so.
- **Map tiles**: OpenStreetMap standard tiles are fine for a low-traffic PoC but not for heavy use (tile usage policy). Swap the provider before wider sharing.
- **Output resolution** (owner feedback, 2026-10-02): a 2.4 × 3 km region at 10 m is only ~240 × 300 px, which looks jagged in Vectric / Carbide Create, especially the route. Output size is now independent of source resolution (Auto = at least 2048 px long side; scale; long-side pixels; metres per pixel). Upscaling is cubic (Catmull-Rom for Terrarium, `RSP_CubicConvolution` for 3DEP), and the route is rasterized at output resolution. The "native" resolution used for the scale factor is 10 m for 3DEP and 30 m for Terrarium. 3DEP may serve its higher-resolution lidar DEMs when asked for finer pixels; this has not been checked against the real service.
- **Route layer at very high resolution** (open): PNG compresses blank (transparent) areas ~1000:1, so file size is not the limit, but the encoder builds the whole image in memory (~12 bytes per pixel including the coverage buffer). 8192² took ~6 s and ~0.9 GB in a Node test; 16384² would not be safe in a browser tab. Options: stream the encoder row-band by row-band, and/or export the route as vector (SVG/DXF in carve millimetres).
