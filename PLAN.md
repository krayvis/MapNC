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
3. **Heightmap + export** *(done; PNG encoder verified bit-exact with Pillow, `js/heightmap.js` uses the browser's CompressionStream instead of UPNG.js, so no dependency)*: auto / manual range, height curve (gamma; replaced the linear vertical exaggeration, which CAM software does better), 8-bit canvas preview, 16-bit PNG from `Uint16Array`, optional 8-bit, elevation range and metres per grey level.
4. **Track overlay** *(done; burn-in verified against independent numpy maths for all three profiles; TCX supported, FIT not)*: GPX parse, fit region to track bbox + margin, draw route over the preview, export transparent route PNG.
5. **README + Pages deploy** *(README and workflow written; Pages source must be set to GitHub Actions once in repo Settings)*, attributions (USGS 3DEP, AWS Terrain Tiles and its underlying datasets, map tile provider).

## Decisions and open risks

- **Carve sizes** (owner, 2026-10-02): 3×3 in up to 16×16 in. At 4096 px that is about 0.02–0.1 mm per pixel, far finer than a bit's stepover, so the cap is rarely the limit; source resolution is. Size/resolution/file-size limits to be refined later.
- **Cap**: native grid at most 4096 px per side and 16.7 M samples total (Float32 = 64 MB). Over the cap, the rectangle turns red and export is blocked. Phase 2 may offer coarser resampling instead.
- **Aspect**: Mercator is locally conformal, but scale varies with latitude across the box. The output grid is built from ground distance (`Δlon · cos(midLat)` by `Δlat`), not from raw tile pixels.
- **Auto-detect**: 3DEP only when the whole rectangle lies inside rough CONUS or Hawaii bounds. Alaska coverage is patchy, so it falls back to Terrarium unless the user forces 3DEP. Rough boxes include some ocean and Canada/Mexico; the ImageServer returns NoData there, which phase 2 must handle.
- **CORS** (2026-10-02): AWS Terrarium returns `Access-Control-Allow-Origin: *`. 3DEP: the dev sandbox blocks `elevation.nationalmap.gov`; the project owner confirmed from a browser that it works. Requests are split into chunks of at most 2000 px per side. **Checked against the real 3DEP service (2026-10-02)**: a float32 TIFF comes back with `Access-Control-Allow-Origin: *`; requests of 2000 x 2000 px work (about 16 MB, 4-5 s), but 3000 x 3000 and 4000 x 2000 fail with HTTP 500 after ~20 s even though the service JSON advertises `maxImageWidth/Height` of 8000, so the 2000 px chunk stays and the JSON limits are NOT trusted. Eight parallel 2000 px requests succeeded. The full app flow (sample route, auto load, 1410 x 2048 px 16-bit export, ~11 s) works. Requests finer than 10 m are served from finer source data where it exists (1.7 m and 1 m requests over the Sierra Buttes returned lidar-like detail), so the "10 m native" figure used for the scale factor is a lower bound there. Requests and tiles are retried twice on a network error or HTTP 5xx. Cross-check against Terrarium over the same box: correlation 0.92 at 10 m cells, no sign of a georeference offset (the best shift barely improves the match); Terrarium is smoother on steep ground.
- **Cap**: adjustable in Advanced (2048 to 16384 px per side). 16384 needs roughly 1.5 GB for a Terrarium fetch and may crash the tab.
- **Terrarium resolution** is a tile-pixel size. Underlying data is far coarser in many places (about 30 m globally), so the UI shows tile pixel size and says so.
- **Map tiles**: OpenStreetMap standard tiles are fine for a low-traffic PoC but not for heavy use (tile usage policy). Swap the provider before wider sharing.
- **Output resolution** (owner feedback, 2026-10-02): a 2.4 × 3 km region at 10 m is only ~240 × 300 px, which looks jagged in Vectric / Carbide Create, especially the route. Output size is now independent of source resolution (Auto = at least 2048 px long side; scale; long-side pixels; metres per pixel). Upscaling is cubic (Catmull-Rom for Terrarium, `RSP_CubicConvolution` for 3DEP), and the route is rasterized at output resolution. The "native" resolution used for the scale factor is 10 m for 3DEP and 30 m for Terrarium. 3DEP may serve its higher-resolution lidar DEMs when asked for finer pixels; this has not been checked against the real service.
- **Route layer at very high resolution** (done, 2026-10-02): PNG compresses blank areas ~1000:1, so file size was never the limit; memory was. The route layer is now drawn and compressed a band of rows at a time (`createBandRasterizer` + `encodePngStream`), verified identical to the whole-image path. An 11281 × 16384 layer (705 MB raw) took ~9.5 s, added ~33 MB of memory in Node and produced a ~1.1 MB file. Capped at 16384 px on the long side because the program opening it must hold the whole bitmap (and wide lines make drawing slow). The route is also exported as SVG/DXF (`js/vector.js`), checked with ezdxf's auditor.
- **Sidebar and loading** (owner feedback, 2026-10-02): the sidebar became collapsible panes plus an always-visible data strip. The separate "Fetch" step is gone: elevation loads automatically 700 ms after the region/resolution/source stops changing, is cancelled by any change, and never runs mid-drag. Outputs over ~4.2 M samples wait for a click (a download of tens of MB per tweak is not acceptable). The elevation source moved under Advanced. Fetch-on-export was rejected because the live preview (grooves, range, clipping) needs the data.
- **Route clean-up** (owner idea, 2026-10-02): geometric only, no timestamps needed. Order: spike removal, minimum spacing, Gaussian smoothing along arc length (resampled evenly so density does not bias it; ends fixed), Ramer-Douglas-Peucker simplification. Spike detection ignores tracks sampled more sparsely than the threshold (a real turnaround is indistinguishable from a spike there). Checked against a synthetic path with known ground truth. Not yet tried on a real noisy tracker file beyond the sample plus injected noise.
- **Manual route editing** (owner request, 2026-10-02): pipeline is original -> automatic clean-up -> manual edits. Edits live in the editing view of the sidebar (a separate view rather than inline panes, per owner feedback). Clean-up settings lock while edits exist, because changing them would silently discard hand work; Discard unlocks. Undo is a stack of compact typed-array snapshots (100 deep). Handles use pointer events with pointer capture and the app's own hit-testing (touch radius larger than mouse); a second pointer is ignored mid-drag and pointercancel ends the gesture. Handles are limited to 1500 in view. Shift+drag needed a patch to Leaflet's Draggable (vendored at a fixed version) and box-zoom turned off. The heightmap recomputes on drop, not on every pixel of a drag. Not yet tried on real touch hardware (synthetic pointer events only).

