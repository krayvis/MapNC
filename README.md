# MapNC

Select a region on a map, get a **16-bit greyscale heightmap PNG**, and optionally burn a hike track into it. Built for CNC relief carving.

Everything runs in your browser. Nothing is uploaded: elevation data comes straight from the public sources below, and your GPX/TCX file is read locally.

Static site, no build step: plain HTML, CSS and JavaScript.

## Use it

1. **Draw a rectangle** on the map. Drag a corner to resize (hold Shift, Ctrl/⌘ or Alt/Option to resize from the centre), or the arrows handle in the middle to move it (moving keeps the ground size). Optionally lock an **aspect ratio** (presets, custom, or "lock current shape", with a swap button for portrait/landscape). The ratio is measured on the ground, so it is what you carve. Or load a **GPX/TCX** route, which fits the region to the track plus a margin (grown to the locked ratio if you set one).
2. Pick an **elevation source** or leave it on Auto: USGS 3DEP inside the US (about 10 m), AWS Terrain Tiles elsewhere. The panel shows the active source and its approximate resolution.
3. Choose the **output resolution**: Auto (at least 2048 px on the long side, never below the source), a scale factor over the source, a long-side pixel count, or metres per pixel. Output finer than the source is smoothly (cubic) interpolated: no new terrain detail, but a smooth surface and route line in CAD/CAM software. Optionally enter your carve size to see mm per pixel; it is also stored in the PNG as its physical size.
4. **Fetch elevation**, then choose the elevation range (auto or manual), vertical exaggeration, and 16-bit (default) or 8-bit output. The panel shows the range and the metres per grey level.
5. With a route loaded, set the **line width** (metres on the ground), **raise/lower** amount (% of the grey range) and **profile** (rounded, uniform or V), then **Export PNG**. **Export route layer** saves the line alone as a transparent RGBA PNG on the same pixel grid.

The **Theme** button at the top cycles Auto (follows your system), Light and Dark; dark mode also darkens the map tiles with a CSS filter.

The preview is 8-bit for display only; the export keeps the bit depth you pick. Settings are also written into the PNG as text chunks (source, bounds, elevation window, metres per grey level, route settings).

**Try it:** the **Load sample route** button loads a hike to the Sierra Buttes Fire Lookout (California), included in `samples/`.

The map has a layer switcher (street, topographic, satellite, USGS topo). In dark mode, drawn maps are inverted and satellite imagery is only dimmed.

Size is capped at 4096 px per side by default (Advanced menu to change). Larger caps use a lot of memory.

## Deploy to GitHub Pages

The repo includes `.github/workflows/pages.yml`, which publishes the site on every push to `main`.

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Run the workflow (**Actions → Deploy to GitHub Pages → Run workflow**) or push to `main`.
4. The site appears at `https://<user>.github.io/<repo>/`.

To run it locally, serve the folder with any static server, for example `python3 -m http.server`, and open `http://localhost:8000`. (Opening `index.html` directly from disk will not work in most browsers.)

## Files

| File | Role |
|------|------|
| `index.html`, `css/style.css` | Page and styles |
| `js/geo.js` | Region maths: ground size, source choice, Terrarium zoom, size cap |
| `js/sources.js` | 3DEP and Terrarium fetchers, stitching, resampling to a ground-correct grid |
| `js/heightmap.js` | Elevation to grey mapping, route burn, PNG encoder (16/8-bit and RGBA) |
| `js/track.js` | GPX/TCX parsing and route rasterizing |
| `js/app.js` | Map, UI wiring |
| `js/theme.js` | Light / dark / auto theme (loaded in `<head>` to avoid a flash) |
| `samples/` | Sample GPX route |
| `vendor/` | Leaflet and geotiff.js (vendored) |
| `PLAN.md` | Build plan, decisions and open risks |

## Known limits

- FIT files are not supported; convert to GPX or TCX.
- Terrarium's pixel size is not the true data resolution; in many places the underlying data is about 30 m.
- The 3DEP path requests up to 2000 px per call; the service's real limit has not been read at runtime.
- Touch use has not been verified on real devices.

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
