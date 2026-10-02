const C = require('../js/contours.js'), V = require('../js/vector.js');
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
// A cone: height = 100 - distance from the centre (m), on a 201 x 201 grid, so level L is a circle of radius 100 - L.
const W = 201, H = 201, cx = 100.5, cy = 100.5, data = new Float32Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) data[j * W + i] = 100 - Math.hypot(i + 0.5 - cx, j + 0.5 - cy);
const r = C.contourLines(data, W, H, 10);
const lv = (n) => r.levels.find((l) => l.n === n);
check('levels every 10 m (corners drop below zero)', r.levels.map((l) => l.z).join() === '-30,-20,-10,0,10,20,30,40,50,60,70,80,90', r.levels.map((l) => l.z).join());
const l50 = lv(5).lines;
check('one closed ring per level', l50.length === 1 && l50[0][0].x === l50[0][l50[0].length - 1].x && l50[0][0].y === l50[0][l50[0].length - 1].y);
const rad = l50[0].map((p) => Math.hypot(p.x - cx, p.y - cy)), mean = rad.reduce((a, b) => a + b) / rad.length;
check('level 50 is a circle of radius 50', Math.abs(mean - 50) < 0.1 && Math.max(...rad) - Math.min(...rad) < 0.4, 'mean ' + mean.toFixed(3) + ' spread ' + (Math.max(...rad) - Math.min(...rad)).toFixed(3));
check('thinning keeps the ring far under the raw vertex count', l50[0].length < 200, l50[0].length + ' points');
check('index contours are every 5th level', r.levels.filter((l) => l.index).map((l) => l.n).join() === '0,5', r.levels.filter((l) => l.index).map((l) => l.n).join());
// A plane: elevation rises with x, so each level is one vertical straight line at x = L.
const P = new Float32Array(W * H); for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) P[j * W + i] = i + 0.5;
const rp = C.contourLines(P, W, H, 50);
check('plane gives straight vertical lines of 2 points', rp.levels.length === 4 && rp.levels.every((l) => l.lines.length === 1 && l.lines[0].length === 2 && Math.abs(l.lines[0][0].x - l.z) < 1e-6), JSON.stringify(rp.levels.map((l) => [l.z, l.lines[0].length])));
// No-data holes stop the line instead of drawing through them.
const D = Float32Array.from(P); for (let j = 90; j < 110; j++) for (let i = 0; i < W; i++) D[j * W + i] = NaN;
const rd = C.contourLines(D, W, H, 50);
check('no-data band splits each line in two', rd.levels.length === 4 && rd.levels.every((l) => l.lines.length === 2), JSON.stringify(rd.levels.map((l) => l.lines.length)));
// Saddle: two peaks on a diagonal must not cross.
const S = new Float32Array(9 * 9); for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) S[j * 9 + i] = (i - 4) * (j - 4);
const rs = C.contourLines(S, 9, 9, 4, { minLen: 0, smooth: 0 });
check('saddle contours do not blow up', rs.levels.length > 0 && rs.levels.every((l) => l.lines.every((ln) => ln.length >= 2)));
check('a flat grid has no contours', C.contourLines(new Float32Array(100).fill(5), 10, 10, 1).levels.length === 0);
check('interval must be positive', (() => { try { C.contourLines(data, W, H, 0); } catch (e) { return true; } return false; })());
check('niceInterval', C.niceInterval(300, 15) === 20 && C.niceInterval(1000, 15) === 100 && C.niceInterval(40, 15) === 5 && C.niceInterval(2, 15) === 0.5, [C.niceInterval(300, 15), C.niceInterval(1000, 15), C.niceInterval(40, 15), C.niceInterval(2, 15)].join());
// Vector output: layers in SVG and DXF, with and without a route.
const layers = [{ name: 'contours', color: '#8b5e34', aci: 30, width: 0.5, lines: lv(5).lines }, { name: 'contours_index', color: '#5a3a1a', aci: 32, width: 1, lines: lv(5).lines.slice(0, 1) }];
const svg = V.toSvg(null, null, W, H, { mmPerPx: 0.5, layers, border: true }), dxf = V.toDxf(null, null, W, H, { mmPerPx: 0.5, layers, border: true });
check('SVG has contour groups and no route', /<g id="contours"/.test(svg) && /<g id="contours_index"/.test(svg) && !/id="route"/.test(svg));
check('DXF has contour layers and no ROUTE layer', /\nCONTOURS\n/.test(dxf) && /\nCONTOURS_INDEX\n/.test(dxf) && !/\nROUTE\n/.test(dxf));
check('DXF layer count is right', /\nLAYER\n70\n3\n/.test(dxf), dxf.match(/LAYER\n70\n\d+/)[0].replace(/\n/g, ' '));
const x = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((m) => m[1].split(' ').map((p) => +p.split(',')[0]));
check('SVG coordinates are scaled to mm', Math.max(...x) < W * 0.5 + 1e-6 && Math.max(...x) > 30);
// Layered-map outlines: a cone gives nested rings clipped square to the extent.
{
  const w = 100, h = 60, d = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[j * w + i] = 100 - Math.hypot(i + 0.5 - 50, j + 0.5 - 30);
  const lo = C.layerOutlines(d, w, h, [0, 50, 90, 200]);
  const box = (l) => { const xs = l.rings.flatMap((g) => g.map((p) => p.x)), ys = l.rings.flatMap((g) => g.map((p) => p.y)); return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; };
  check('lowest layer is exactly the whole rectangle', lo[0].rings.length === 1 && box(lo[0]).join() === '0,100,0,60', box(lo[0]).join());
  check('a layer cut by the edge follows the extent', box(lo[1]).join() === '0,100,0,60');
  const b = box(lo[2]);
  check('a peak layer is a small closed ring', lo[2].rings.length === 1 && b[0] > 39.9 && b[1] < 60.1 && b[2] > 19.9 && b[3] < 40.1, b.join());
  check('a level above the terrain has no ring', lo[3].rings.length === 0);
  const vv = V.toLayersSvg(lo.slice(0, 3), w, h, { mmPerPx: 0.5 }), vd = V.toLayersDxf(lo.slice(0, 3), w, h, { mmPerPx: 0.5 });
  check('layers SVG has one numbered group per layer', (vv.match(/<g id="layer-0\d"/g) || []).length === 3 && /class="label"[^>]*>3</.test(vv));
  check('layers DXF has CUT and LABELS layers', /\nCUT\n/.test(vd) && /\nLABELS\n/.test(vd) && (vd.match(/\nTEXT\n/g) || []).length === 3);
  const lay = V.layout(lo.slice(0, 3), w, h, { mmPerPx: 0.5, gap: 5 });
  check('sheet tiles do not overlap', lay.tiles[1].x >= lay.w + 5 - 1e-9 || lay.tiles[1].y >= lay.h + 5 - 1e-9, JSON.stringify(lay.tiles.map((t) => [t.x, t.y])));
}
