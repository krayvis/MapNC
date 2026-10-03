// Corner marks in the vector export: they must span exactly the heightmap extent, in both SVG and DXF.
const Vec = require('../js/vector.js'), Track = require('../js/track.js');
let fails = 0; const check = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + (d || ''))); if (!ok) fails++; };
const track = { name: 't', segments: [[{ lat: 0.5, lon: 0.5 }, { lat: 0.6, lon: 0.6 }]] };
const bounds = { west: 0, east: 1, south: 0, north: 1 }, W = 100, H = 80, mmPerPx = 2;
const marks = Vec.cornerMarks(W * mmPerPx, H * mmPerPx);
const xs = marks.flat().map((p) => p.x), ys = marks.flat().map((p) => p.y);
check('two brackets, on opposite corners', marks.length === 2 && marks[0][1].x === 0 && marks[0][1].y === 0 && marks[1][1].x === 200 && marks[1][1].y === 160);
check('bounding box is the full extent', Math.min(...xs) === 0 && Math.max(...xs) === 200 && Math.min(...ys) === 0 && Math.max(...ys) === 160, JSON.stringify([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]));
const svg = Vec.toSvg(track, bounds, W, H, { mmPerPx, marks: true });
check('svg has marks group with 2 polylines', /id="corner-marks"/.test(svg) && (svg.split('id="corner-marks"')[1].split('</g>')[0].match(/<polyline/g) || []).length === 2);
check('svg without marks has none', !/corner-marks/.test(Vec.toSvg(track, bounds, W, H, { mmPerPx })));
const dxf = Vec.toDxf(track, bounds, W, H, { mmPerPx, marks: true });
check('dxf has CORNER_MARKS layer and 2 polylines on it', /\nCORNER_MARKS\n/.test(dxf) && (dxf.match(/POLYLINE\n8\nCORNER_MARKS/g) || []).length === 2);
check('dxf layer count matches', /2\nLAYER\n70\n2\n/.test(dxf));
check('dxf without marks has none', !/CORNER_MARKS/.test(Vec.toDxf(track, bounds, W, H, { mmPerPx })));
process.exit(fails ? 1 : 0);
