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
