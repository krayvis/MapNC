# MapNC

Select a region on a map, get a **16-bit greyscale heightmap PNG**, and optionally burn a hike track into it. Built for CNC relief carving.

Everything runs in your browser. Nothing is uploaded: elevation data comes straight from the public sources below, and your GPX/TCX file is read locally.

Static site, no build step: plain HTML, CSS and JavaScript.

## Use it

1. **Draw a rectangle** on the map (drag a corner to resize), or load a **GPX/TCX** route, which fits the region to the track plus a margin.
2. Pick an **elevation source** or leave it on Auto: USGS 3DEP inside the US (about 10 m), AWS Terrain Tiles elsewhere. The panel shows the active source and its approximate resolution.
3. **Fetch elevation**, then choose the elevation range (auto or manual), vertical exaggeration, and 16-bit (default) or 8-bit output. The panel shows the range and the metres per grey level.
4. With a route loaded, set the **line width** (metres on the ground), **raise/lower** amount (% of the grey range) and **profile** (rounded, uniform or V), then **Export PNG**. **Export route layer** saves the line alone as a transparent RGBA PNG on the same pixel grid.

The preview is 8-bit for display only; the export keeps the bit depth you pick. Settings are also written into the PNG as text chunks (source, bounds, elevation window, metres per grey level, route settings).

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
- **Map tiles**: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). The default OSM tile server is meant for light use; see the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and switch provider before wider sharing.
- Libraries: [Leaflet](https://leafletjs.com) (BSD-2-Clause), [geotiff.js](https://geotiffjs.github.io) (MIT). Licences are in `vendor/`.
