# MapNC

Select a region on a map, get a **16-bit greyscale heightmap PNG**, and optionally export a hike track as separate route layers (PNG, SVG, DXF) to line up with it. Built for CNC relief carving.

Everything runs in your browser. Nothing is uploaded: elevation data comes straight from the public sources below, and your GPX/TCX file is read locally.

Static site, no build step: plain HTML, CSS and JavaScript.

## Use it

The sidebar is a set of collapsible panes (opening one closes the others, and which is open is remembered). A strip at the top always shows what the elevation data is doing.

1. **Route & region.** A sample route is loaded to start (**Clear route** removes it). Load your own **GPX/TCX** file and the region fits to the track plus a margin, or **draw a rectangle**. Drag a corner to resize (hold Shift, Ctrl/⌘ or Alt/Option to resize from the centre), or the arrows handle in the middle to move it (moving keeps the ground size). Optionally lock an **aspect ratio** (presets, custom, or "lock current shape", with a swap button for portrait/landscape). The ratio is measured on the ground, so it is what you carve.
2. **Clean up & edit route** (appears when a route is loaded). For noisy trackers: remove GPS spikes and collapse standing-still jitter (minimum point spacing), each optional and in metres. Stray points you remove by hand (see below), then optionally **fit a smooth spline** through what is left (passes through every point; applies to the map, the preview and every export, and is not affected by the edit lock). The original shows as a dashed grey line under the cleaned red one, with point count, length and the largest shift reported. Your file is never modified.
   **Edit points on the map…** switches the sidebar into a dedicated editing view, so you can fix what the clean-up cannot while looking at satellite imagery: drag a point to move it, drag the line to add a point, click to select (Shift+click for a stretch) and Delete (or right-click) to remove, with undo/redo. The view has a Street / Satellite / Topo switcher, a thin-line option and a toggle for the dashed original. Edits flow into the heightmap, the PNG route layer and the SVG/DXF. Clean-up settings lock while you have manual edits (Discard unlocks them). Handles appear when fewer than 1500 points are in view, so zoom in on the part you are fixing. Works with mouse and touch.
3. **Output size.** Auto (at least 2048 px on the long side, never below the source), a scale factor over the source, a long-side pixel count, or metres per pixel. Output finer than the source is smoothly (cubic) interpolated: no new terrain detail, but a smooth surface and route line in CAD/CAM software. Optionally enter your carve size (and your finishing stepover) to see mm per pixel and get advice on whether the resolution is enough: too coarse, fine, or finer than the source data can justify. The carve size is also stored in the PNG as its physical size.
4. **Heightmap.** Elevation data loads **automatically** about 0.7 s after you stop changing the region, resolution or source (and never while you are mid-drag). Large outputs (over about 4 million samples) wait for a **Load elevation data** click instead. Choose the elevation range (auto or manual), a **height curve** (linear, or emphasise valleys or peaks, for more grey levels in low or high ground), and invert. The route is never burned into the heightmap; it exports as separate layers (step 5). The preview can show it as a guide line.
5. **Export.** 16-bit greyscale PNG (default) or 8-bit. With a route loaded there is also a **Route export** block, which needs only the region and the route (not the elevation data):
   - **Route layer (PNG):** the line alone, at the **line width** you set (metres on the ground), on a transparent RGBA canvas, framed exactly like the heightmap. Choose the same size, 2×, 4×, 8×, or a long side up to 16384 px. It is drawn and compressed a strip at a time, so even a very large layer uses little memory and is a small file (an 11281 × 16384 layer was about 1 MB), though the program you open it in must hold the whole bitmap. Cancel any time.
   - **SVG and DXF:** the route as vector polylines, in millimetres of the finished carve once you enter a carve size (otherwise heightmap pixels), in the same frame as the heightmap. SVG has its origin top-left; DXF (AutoCAD R12) bottom-left, Y up. An optional job-border rectangle and four corner marks (L brackets, on their own layer) span exactly the heightmap's extent: select them with the route, scale the group to the heightmap size with the aspect ratio locked, then delete them. DXF is usually the safer choice for Vectric or Carbide Create; check the size on import. These use the cleaned route, so cleaning first gives a much lighter file.

**Advanced** (collapsed): the elevation source (Auto picks USGS 3DEP inside the US, AWS Terrain Tiles elsewhere), the max output size, and a reload button.

The preview is 8-bit for display only; the export keeps the bit depth you pick. Settings are also written into the PNG as text chunks (source, bounds, elevation window, metres per grey level, height curve).

The map has a layer switcher (street, topographic, satellite, USGS topo) and a **Theme** button (Auto / Light / Dark). In dark mode, drawn maps are inverted and satellite imagery is only dimmed.

Size is capped at 4096 px per side by default (Advanced menu to change). Larger caps use a lot of memory.

Add `?sample=off` to the address to start without the sample route.

## Deploy to GitHub Pages

The repo includes `.github/workflows/pages.yml`, which publishes the site on every push to `main`.

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Run the workflow (**Actions → Deploy to GitHub Pages → Run workflow**) or push to `main`.
4. The site appears at `https://<user>.github.io/<repo>/`.

To run it locally, serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000`. (Opening `index.html` directly from disk will not work in most browsers.)

## Developing

No build step: edit the files and reload. Serve the folder (`python3 -m http.server`, or `npm run serve`) and open <http://localhost:8000>.

- **Tests:** `npm install && npx playwright install chromium && npm test`. See [`tests/README.md`](tests/README.md): what each script covers, how the 3DEP service is mocked, and the live-service checks.
- **Backlog:** [`BACKLOG.md`](BACKLOG.md) holds deferred ideas and what to do soon.
- **Design notes:** [`PLAN.md`](PLAN.md) records the decisions, what was checked against the real services, and the open risks. Read it before changing the elevation fetching or the route clean-up.
- **Vendored libraries:** Leaflet 1.9.4 and geotiff.js 2.1.3 are copied into `vendor/` from the npm packages (`npm pack leaflet@1.9.4 geotiff@2.1.3`; take `dist/leaflet.js`, `dist/leaflet.css`, `dist/images/`, and geotiff's `dist-browser/geotiff.js`), so the site works with no CDN. Leaflet's internals are patched at runtime in `js/app.js` (the `L.Draggable.prototype._onDown` patch that lets Shift-drag work on markers), so re-run the tests, `aspect.js` and `edit.js` in particular, after upgrading it.
- **Deploying:** every push to `main` deploys (see above); a fork needs only the Pages setting.

## Files

| File | Role |
|------|------|
| `index.html`, `css/style.css` | Page and styles |
| `js/geo.js` | Region maths: ground size, source choice, Terrarium zoom, size cap |
| `js/sources.js` | 3DEP and Terrarium fetchers, stitching, resampling to a ground-correct grid |
| `js/heightmap.js` | Elevation to grey mapping, height curve, PNG encoders (in-memory 16/8-bit and RGBA, and a streaming one) |
| `js/track.js` | GPX/TCX parsing, route clean-up, point-edit operations, route rasterizing (whole image or a strip at a time) |
| `js/vector.js` | SVG and DXF export of the route |
| `js/app.js` | Map, UI wiring |
| `js/theme.js` | Light / dark / auto theme (loaded in `<head>` to avoid a flash) |
| `samples/` | Sample GPX route |
| `vendor/` | Leaflet and geotiff.js (vendored) |
| `PLAN.md` | Build plan, decisions and open risks |
| `BACKLOG.md` | Deferred ideas and upcoming work |
| `tests/` | Test scripts (Playwright and Node) and their README |
| `LICENSE` | PolyForm Noncommercial 1.0.0 |

## Known limits

- FIT files are not supported; convert to GPX or TCX.
- Terrarium's pixel size is not the true data resolution; in many places the underlying data is about 30 m.
- The 3DEP path requests up to 2000 px per call. The service advertises 8000 px, but larger requests fail in practice, so the smaller size is deliberate.
- Touch use has not been verified on real devices.
- Importing the DXF, SVG or route PNG into Vectric or Carbide Create has not been tried.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE), copyright 2026 Winston Moy. You are free to use, copy, modify and share MapNC for any noncommercial purpose, including personal projects, hobby carving, research, education and non-profit use. Commercial use, such as selling the software or offering it as a paid service, is not permitted without separate permission from the copyright holder. This is a source-available licence, not an OSI-approved open-source one.

This covers MapNC's own code. The libraries in `vendor/` keep their own licences (Leaflet: BSD-2-Clause, geotiff.js: MIT; see `vendor/LEAFLET-LICENSE` and `vendor/GEOTIFF-LICENSE`), and the elevation data and map tiles are subject to their providers' terms (below).

## Data attribution

- **USGS 3D Elevation Program (3DEP)**, via The National Map ImageServer (`elevation.nationalmap.gov`). Courtesy of the U.S. Geological Survey. U.S. Government work, public domain; please credit USGS.
- **AWS Terrain Tiles** (Terrarium format), from the Registry of Open Data on AWS (`elevation-tiles-prod`). The tiles combine several public datasets, including SRTM, USGS NED/3DEP, GMTED2010, ETOPO1, ArcticDEM, NRCan CDEM, EU-DEM and GEBCO bathymetry, among others. The full, authoritative list and licence terms are in the Tilezen attribution notes: <https://github.com/tilezen/joerd/blob/master/docs/attribution.md>. Please check it before redistributing derived data.
- **Map tiles** (display only; none of this is used for the heightmap):
  - Street: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). The OSM tile server is meant for light use; see its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
  - Topographic: [OpenTopoMap](https://opentopomap.org) (CC-BY-SA), map data © OpenStreetMap contributors, SRTM. Also a community service for light use.
  - Satellite: Esri World Imagery. Tiles © Esri, Maxar, Earthstar Geographics, and the GIS User Community. Subject to [Esri's terms](https://www.esri.com/en-us/legal/terms/full-master-agreement); check them before commercial or heavy use.
  - USGS Topo: tiles courtesy of the U.S. Geological Survey (US only).
  - For wider sharing, replace these free public tile servers with a provider you have an agreement with.
- **Sample route**: a recording of a hike to the Sierra Buttes Fire Lookout, supplied by the project owner. Timestamps and sensor data were removed; only positions and elevation remain.
- Libraries: [Leaflet](https://leafletjs.com) (BSD-2-Clause), [geotiff.js](https://geotiffjs.github.io) (MIT). Licences are in `vendor/`.
