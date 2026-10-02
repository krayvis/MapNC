# Backlog and ideas

Things we may do, not things we are doing. Move an item to **Next** when it is about to be worked on, and delete it when it ships (the README and PLAN.md carry what exists). Keep entries short: what, and why it might be worth it.

## Next

Soon, in rough priority order.

- **Contour-line vector export.** Export elevation contours at a chosen interval as DXF and SVG polylines, for engraving or V-carving topo lines instead of (or on top of) the relief. Reuse the existing SVG/DXF writers (DXF is AC1009). Needs a marching-squares pass over the fetched grid, a smoothing/simplification step so toolpaths are not jagged, and an interval control. Index contours (every 5th) on a separate layer.
- **Vector layers: water and roads (and lakes).** Rivers, lakes and roads as polylines/polygons in the same frame as the route, from OpenStreetMap through the Overpass API (works from a browser; needs ODbL attribution, a size limit on the query area, and a polite request rate). Lakes also have a use in the heightmap itself (flatten to a pool). Open question: Overpass availability, and how heavy a dense road network gets, so it needs simplification and a feature filter (main roads only, say).

**Where these go (decided, not built):** contours, water and roads are export-only and do not change the heightmap, so they belong in step 5 (Export) as one "Vector layers" group, not a new step 6. Route, contours, water and roads each get a checkbox and share the SVG/DXF buttons and the corner marks, so one file carries everything on separate layers, all in the heightmap's frame. Contour interval and the road/water filters sit under their checkboxes. The vector tab of the route export (PNG / Vector tabs) is the natural home; it would be renamed "Vector layers" when the first of these lands.

## Later

Worth doing, no date.

- **Test the exports in real CAM.** DXF, SVG and the route PNG have not been imported into Vectric VCarve or Carbide Create. Do that before promising anything about them. The border and corner-mark scaling workflow in particular is untried.
- **Make the heightmap export streaming.** The route PNG already streams in bands; the main heightmap does not, which caps very large sizes.
- **Mobile / touch pass.** Selection handles, the point editor and the collapsible sidebar have only been checked with mouse input.
- **Verify very large 3DEP requests.** A 12-chunk 7000 px fetch still failed in the sandbox (proxy drops). Try it from a normal network.

## Ideas

- **Main-window heightmap view at step 4, then a 3D terrain view.** Once the region is fixed, show the heightmap (route drawn over it) in the main window and drop the small sidebar preview, with a way back to the map. A Map / Heightmap / 3D switch would also hold a WebGL terrain mesh with the route draped on it, to check a trail against a switchback or ridge.

Unsorted, unevaluated.

- STL / mesh export.
- Georeferencing sidecar (world file or JSON with bounds and Z range) so the heightmap can be placed back on a map.
- Cross-section / profile view along the route.
- Sea-level clamp (flatten below 0 m so water is a flat pool).
- Read the heightmapper and unrealheightmap projects for ideas and pitfalls.
- **Spline view of the GPX route.** A button to show the route as a smooth spline (e.g. Catmull-Rom through the points) instead of straight segments. Open question: map-only display, or also what gets burned into the route PNG and exported to SVG/DXF? Needs the user's intent pinned down.
