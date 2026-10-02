# Tests

Plain Node scripts; no test framework. Each prints `PASS`/`FAIL` lines and exits non-zero on failure.

```
npm install                       # installs Playwright (dev only; the app has no dependencies)
npx playwright install chromium   # skip if you already have a Chromium (set CHROMIUM_PATH to it)
npm test                          # runs every suite below, ~2 minutes
node tests/edit.js                # or just one
```

Output files (PNG, DXF, SVG, screenshots) go to a fresh temp folder; set `MAPNC_TEST_OUT=/some/dir` to keep them somewhere you can look.

## What each script covers

| Script | Covers |
|---|---|
| `clean.js` | Route clean-up maths against a synthetic path with known ground truth (no browser) |
| `pngtest.js`, `vec.js`, `stream.js` | PNG encoder, SVG/DXF export and the streaming PNG writer (no browser). They write files and check little themselves; `verify.py` checks the output |
| `hid.js`, `theme.js` | The `hidden` attribute rule and light/dark/auto theming |
| `default.js` | Sample route loaded at start, zoom to it, Clear route |
| `aspect.js` | Aspect-ratio lock, moving and resizing the rectangle, centre-resize modifiers |
| `auto.js` | Automatic background loading, cancellation, resolution modes, exports (16-bit and 8-bit PNG) |
| `cleanui.js` | Clean-up controls in the sidebar |
| `contours.js` | Contour tracing (cone, plane, no-data holes, saddles) and the extra SVG/DXF layers (no browser) |
| `terrain3d.js` | 3D terrain view: grid reduction, WebGL mesh and route in software GL, orbit / pan / zoom / pinch, exaggeration |
| `osm.js` | OpenStreetMap layers: parsing, clipping, mocked Overpass (fallback, cache, errors), UI, exports and credit |
| `dep.js` | 3DEP framing: a server that re-frames mismatched-aspect requests (as the real one does) must still land samples at their true lon/lat |
| `hmview.js` | Map / Heightmap switch: canvas, route, hover readout, editing interplay |
| `contourui.js` | Contour controls and files in the browser, with and without a route |
| `edit.js` | The point editor: dragging, adding, deleting, undo/redo, touch, the editing view |
| `exports.js` | Route layer PNG, SVG and DXF |
| `smoke5.js` | End-to-end smoke test of the whole page |
| `verify.py` | Independent checks with Pillow and ezdxf (`pip install pillow numpy ezdxf`): PNGs decode bit-exact, DXFs pass an audit |

## How the browser tests stay offline

The tests start a tiny static server for the repo, serve a stub for map tiles (`fixtures/tile.png`), and **mock the 3DEP service** with hand-built float32 TIFFs (`mktiff.js`). So they need no network and don't touch the real services.

## Against the real services (not part of `npm test`)

- `node tests/live-3dep.js`: requests real 3DEP at several sizes and prints the timings and elevation range.
- `node tests/live-app.js [auto|3dep|terrarium]`: loads the sample route in the real app against the real service and exports a PNG.

These need network access to `elevation.nationalmap.gov` and `s3.amazonaws.com`. Behind an intercepting proxy the scripts already ignore certificate errors. Findings from the real service (the 2000 px request limit and so on) are in `PLAN.md`.

## Notes

- Chromium-only. Touch is exercised with synthetic pointer events, not a real device.
- The scripts are plain, so a failure usually needs reading the test and the app code together.
