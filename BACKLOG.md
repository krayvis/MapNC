# Backlog and ideas

Things we may do, not things we are doing. Move an item to **Next** when it is about to be worked on, and delete it when it ships (the README and PLAN.md carry what exists). Keep entries short: what, and why it might be worth it.

## Next

Soon, in rough priority order.

- **Contour-line vector export.** Export elevation contours at a chosen interval as DXF and SVG polylines, for engraving or V-carving topo lines instead of (or on top of) the relief. Reuse the existing SVG/DXF writers (DXF is AC1009). Needs a marching-squares pass over the fetched grid, a smoothing/simplification step so toolpaths are not jagged, and an interval control in the sidebar. Index contours (every 5th) could go on a separate layer.

## Later

Worth doing, no date.

- **Test the exports in real CAM.** DXF, SVG and the route PNG have not been imported into Vectric VCarve or Carbide Create. Do that before promising anything about them.
- **Make the heightmap export streaming.** The route PNG already streams in bands; the main heightmap does not, which caps very large sizes.
- **Mobile / touch pass.** Selection handles, the point editor and the collapsible sidebar have only been checked with mouse input.
- **Verify very large 3DEP requests.** A 12-chunk 7000 px fetch still failed in the sandbox (proxy drops). Try it from a normal network.

## Ideas

Unsorted, unevaluated.

- STL / mesh export.
- Georeferencing sidecar (world file or JSON with bounds and Z range) so the heightmap can be placed back on a map.
- Cross-section / profile view along the route.
- Sea-level clamp (flatten below 0 m so water is a flat pool).
- Read the heightmapper and unrealheightmap projects for ideas and pitfalls.
