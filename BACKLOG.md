# Backlog and ideas

Things we may do, not things we are doing. Move an item to **Next** when it is about to be worked on, and delete it when it ships (the README and PLAN.md carry what exists). Keep entries short: what, and why it might be worth it.

## Next

Soon, in rough priority order.

- **Ocean: flat sea level, then bathymetry.** Planned in PLAN.md ("Ocean plan"). Flat sea with a flood fill from the border, a sea band in the grey mapping, a NOAA bathymetry merge for 3DEP regions, then 3D and contour touches. The "Raise everything below" option already gives a plain flat sea at a chosen level; the flood fill is the careful version that spares land below sea level. Waiting on the owner's answers to the open questions in the plan.
- **Scale bar and map markers in the extra toppings (step 6).** Vector layers on the same pixel frame as the route: a scale bar (a round length, with end ticks and a label), a north arrow, and markers for GPX waypoints (summits, camps; MapNC reads none today) and for named points the user adds. Lat/lon ticks along the edge are a possible extra.

## Later

- **Tiling beyond the grid: per-tile detail.** Tiling (built) cuts tiles from one grid, so it cannot add pixels. A carve whose stepover needs more pixels than the size cap allows would need each tile fetched or resampled on its own at the pixel size required, with the fixes, lakes, border offset and a shared elevation window applied per tile, and a check that neighbouring tiles agree in the overlap. Only worth it where the source really has the detail (1 to 3 m lidar), since a 10 m source just gets smoother. Also not tiled yet: the SVG route export, the STL, the layered map, and a registration mark scheme beyond the overlap (the DXF tiles already carry corner marks).
- **Canada: fill the lidar gaps from a national model.** The NRCan source only covers where lidar exists, so Auto falls back to Terrarium (~30 m) when coverage is poor. A better answer would be a merge: HRDEM where it has data, the 30 m national model (MRDEM-30, a cloud-optimised GeoTIFF on public S3, in Canada Lambert so it needs reprojection) elsewhere, with a check for a step at the seam (vertical datums differ). Also the coverage outline for Auto is rough (see geo.js), and the resolution is an assumed 10 m; a cheap probe of the service's own metadata might replace both.

Worth doing, no date.

- **Downsample the heightmap preview for huge grids.** The export now streams, but the preview canvas is still full size: at the 16384 px cap that is a 1 GB `ImageData` plus the canvas, on top of the Float32 elevation (1 GB) and the grey array (0.5 GB). A preview capped near 4096 px would lift the real memory limit. The hover readout, route guide and 3D view all use grid coordinates, so each needs the scale. Tiling would reduce the pressure but not remove it.
- **Check lake flattening against real OpenStreetMap data.** It is tested with mocked Overpass responses only (the live service answered 429 when tried). Try the Sierra Buttes sample and a lake with an island (a relation with an inner ring).
- **Import-settings readout for Carbide Create.** Given a relief height in mm, print what to enter in the import dialog (depth and XY scale) and the metres per grey level.
- **Tool-reach advisory.** Enter the bit's flute length and the stock thickness; warn when the relief is deeper than the bit can cut.
- **Edge border in the 3D view.** The border is baked into the heightmap and the STL; the 3D view draws the real terrain without it.

## Ideas

Unsorted, unevaluated.

- Georeferencing sidecar (world file or JSON with bounds and Z range) so the heightmap can be placed back on a map.
- Read the heightmapper and unrealheightmap projects for ideas and pitfalls.
- **Spline polish.** The spline fit is built (step 2). Possible follow-ups: show the control points' polyline faintly under the curve, a smoothing-spline mode that does not pass through noisy points exactly.
- A mirrored "mold mode" for casting or vacuum forming.
- GPX trim, split, merge and reverse.
- A fill limit for gaps that the user can set (today: gaps up to 2% of the grid are filled, bigger ones are left).
