const T = require('../js/track.js'), V = require('../js/vector.js'), G = require('../js/geo.js'), fs = require('fs');
const txt = fs.readFileSync(__dirname + '/../samples/sierra-buttes-fire-lookout.gpx', 'utf8');
const pts = [...txt.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(m => ({ lat: +m[1], lon: +m[2] }));
const track = T.makeTrack('Sierra', [pts.slice(0, 2000), pts.slice(2000)]);          // two segments
const bounds = T.padBounds(T.trackBounds(track), 0.15), g = G.groundSize(bounds);
const grid = G.gridFor(bounds, g.heightM / 2048);                                     // 2048 px on the long side
const mmPerPx = 304.8 / Math.max(grid.width, grid.height);                            // 12 in carve
const o = { mmPerPx, lineWidth: 0.5, border: true, title: 'Sierra <test> & "quotes"' };
fs.writeFileSync(require('./lib.js').OUT + '/route.svg', V.toSvg(track, bounds, grid.width, grid.height, o));
fs.writeFileSync(require('./lib.js').OUT + '/route.dxf', V.toDxf(track, bounds, grid.width, grid.height, o));
fs.writeFileSync(require('./lib.js').OUT + '/route_px.dxf', V.toDxf(track, bounds, grid.width, grid.height, {}));
fs.writeFileSync(require('./lib.js').OUT + '/vecinfo.json', JSON.stringify({ W: grid.width, H: grid.height, mmPerPx, segs: V.polylines(track, bounds, grid.width, grid.height, mmPerPx).map(s => s.map(p => [p.x, p.y])) }));
console.log('grid', grid.width, 'x', grid.height, 'mm/px', mmPerPx.toFixed(4));
