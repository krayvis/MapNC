const S = require('../js/stl.js');
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
// A tilted plane on 5 x 4 points: closed solid, outward winding, exact volume.
const W = 5, H = 4, t = new Float32Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) t[j * W + i] = i / (W - 1);   // 0 at west, 1 at east
const o = { widthMm: 40, heightMm: 30, reliefMm: 10, baseMm: 2 };
const buf = S.buildStl(t, W, H, o), dv = new DataView(buf);
check('triangle count matches the header and size', dv.getUint32(80, true) === S.triangleCount(W, H) && buf.byteLength === 84 + 50 * S.triangleCount(W, H));
const key = (x, y, z) => [x, y, z].map((v) => v.toFixed(4)).join(',');
const edges = new Map(); let vol = 0, up = 0, bad = 0;
for (let k = 0; k < dv.getUint32(80, true); k++) {
  const b = 84 + k * 50, f = (i) => dv.getFloat32(b + 4 * i, true);
  const nrm = [f(0), f(1), f(2)], v = [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]];
  for (let e = 0; e < 3; e++) { const a = key(...v[e]), c = key(...v[(e + 1) % 3]); edges.set(a + '>' + c, (edges.get(a + '>' + c) || 0) + 1); }
  vol += (v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0])) / 6;
  const cx = (v[1][1] - v[0][1]) * (v[2][2] - v[0][2]) - (v[1][2] - v[0][2]) * (v[2][1] - v[0][1]);
  const cy = (v[1][2] - v[0][2]) * (v[2][0] - v[0][0]) - (v[1][0] - v[0][0]) * (v[2][2] - v[0][2]);
  const cz = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
  if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] <= 0) bad++;
  if (nrm[2] > 0.5) up++;
}
let open = 0; for (const [e, c] of edges) { const [a, b] = e.split('>'); if (c !== 1 || edges.get(b + '>' + a) !== 1) open++; }
check('every edge is shared by exactly two triangles, opposite ways (watertight)', open === 0, open + ' open edges');
check('stored normals agree with the winding', bad === 0, bad + ' disagree');
const expect = 40 * 30 * (2 + 10 / 2);
check('volume is base plus half the relief (a ramp)', Math.abs(vol - expect) < 1e-3 * expect && vol > 0, vol + ' vs ' + expect);
check('top faces point up', up === 2 * (W - 1) * (H - 1));
const r = S.resample(t, W, H, 9, 7);
check('resample keeps the corners and the ramp', r[0] === 0 && Math.abs(r[8] - 1) < 1e-6 && Math.abs(r[4] - 0.5) < 1e-6);
check('NaN is treated as zero height', (() => { const n = new Float32Array(4).fill(NaN); return new DataView(S.buildStl(n, 2, 2, o)).getUint32(80, true) === S.triangleCount(2, 2); })());

// ---- faceted mesh ----
const watertight = (buf) => {
  const dv = new DataView(buf), edges = new Map(); let vol = 0, bad = 0;
  for (let k = 0; k < dv.getUint32(80, true); k++) {
    const b = 84 + k * 50, f = (i) => dv.getFloat32(b + 4 * i, true);
    const nrm = [f(0), f(1), f(2)], v = [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]];
    for (let e = 0; e < 3; e++) { const a = key(...v[e]), c = key(...v[(e + 1) % 3]); edges.set(a + '>' + c, (edges.get(a + '>' + c) || 0) + 1); }
    vol += (v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0])) / 6;
    const cz = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
    const cx = (v[1][1] - v[0][1]) * (v[2][2] - v[0][2]) - (v[1][2] - v[0][2]) * (v[2][1] - v[0][1]);
    const cy = (v[1][2] - v[0][2]) * (v[2][0] - v[0][0]) - (v[1][0] - v[0][0]) * (v[2][2] - v[0][2]);
    if (cx * nrm[0] + cy * nrm[1] + cz * nrm[2] <= 0) bad++;
  }
  let open = 0; for (const [e, c] of edges) { const [a, b] = e.split('>'); if (c !== 1 || edges.get(b + '>' + a) !== 1) open++; }
  return { open, vol, bad };
};
{
  // Two cones on a 120 x 90 grid: the facets should find both summits.
  const w = 120, h = 90, d = new Float32Array(w * h);
  const cone = (i, j, ci, cj, r, ht) => Math.max(0, ht * (1 - Math.hypot(i - ci, j - cj) / r));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) d[j * w + i] = Math.max(cone(i, j, 30, 40, 25, 1), cone(i, j, 90, 50, 20, 0.7)) + 0.0004 * ((i * 7 + j * 13) % 5);
  const op = { widthMm: 120, heightMm: 90, reliefMm: 20, baseMm: 3, target: 400, maxGrid: 700 };
  const small = S.buildFacetedStl(d, w, h, op), big = S.buildFacetedStl(d, w, h, Object.assign({}, op, { target: 3000 }));
  const ws = watertight(small.buf), wb = watertight(big.buf);
  check('faceted solid is watertight (small and large)', ws.open === 0 && wb.open === 0, ws.open + ' / ' + wb.open + ' open edges');
  check('faceted normals agree with winding and volume is positive', ws.bad === 0 && wb.bad === 0 && ws.vol > 0 && wb.vol > 0);
  check('more facets give a closer fit', big.maxErrMm < small.maxErrMm * 0.6, small.maxErrMm.toFixed(3) + ' -> ' + big.maxErrMm.toFixed(3) + ' mm');
  check('facet count is near the target', small.triangles > 300 && small.triangles < 900 && big.triangles > 2500 && big.triangles < 4500, small.triangles + ' / ' + big.triangles);
  const m = S.facetedMesh(d, w, h, { target: 400 });
  const near = (ci, cj) => m.points.some((p) => Math.hypot(p.i - ci, p.j - cj) <= 2);
  check('summits become vertices', near(30, 40) && near(90, 50));
  check('far fewer triangles than the full grid', small.triangles < 2 * (w - 1) * (h - 1) / 10, String(2 * (w - 1) * (h - 1)));
  const flat = S.buildFacetedStl(new Float32Array(50 * 40).fill(0.5), 50, 40, Object.assign({}, op, { target: 400 }));
  check('flat ground stays a handful of triangles', flat.triangles < 40 && watertight(flat.buf).open === 0, String(flat.triangles));
}
