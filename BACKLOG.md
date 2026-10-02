# Backlog and ideas

Things we may do, not things we are doing. Move an item to **Next** when it is about to be worked on, and delete it when it ships (the README and PLAN.md carry what exists). Keep entries short: what, and why it might be worth it.

## Next

Soon, in rough priority order.

- **Lake flatten in the heightmap.** Optional: pool lakes to a flat level using the OSM lake outlines (the outlines already export as vectors). Decided: flat water only, no carved depth. Level per lake = median of the DEM inside its outline (lakes in one region differ by hundreds of metres, so never a global level); skip lakes whose DEM is already flat. Case study (Sierra Buttes sample, 3DEP): the big lakes are already hydro-flattened (SD 0.00 m), only small ponds and wet meadows are noisy (0.3 to 0.7 m), so the gain is small on 3DEP. Measure the Terrarium fallback before building; it is likely where this matters.

## Later

Worth doing, no date.

- **Test the exports in real CAM.** DXF, SVG and the route PNG have not been imported into Vectric VCarve or Carbide Create. Do that before promising anything about them. The border and corner-mark scaling workflow in particular is untried.
- **Make the heightmap export streaming.** The route PNG already streams in bands; the main heightmap does not, which caps very large sizes.
- **Mobile / touch pass.** Selection handles, the point editor and the collapsible sidebar have only been checked with mouse input.
- **Verify very large 3DEP requests.** A 12-chunk 7000 px fetch still failed in the sandbox (proxy drops). Try it from a normal network.

## Ideas


Unsorted, unevaluated.

- STL / mesh export.
- Georeferencing sidecar (world file or JSON with bounds and Z range) so the heightmap can be placed back on a map.
- Cross-section / profile view along the route.
- Sea-level clamp (flatten below 0 m so water is a flat pool). For islands, consider optional bathymetry depth (carve the sea below the waterline), which is wanted for the ocean even though lakes stay flat.
- Read the heightmapper and unrealheightmap projects for ideas and pitfalls.
- **Spline polish.** The spline fit is built (step 2). Possible follow-ups: show the control points' polyline faintly under the curve, a smoothing-spline mode that does not pass through noisy points exactly.
