// Elevation fixes: gap filling and the elevation floor (pure, no browser).
global.self = global;
const F = require('../js/fixes.js');
const L = require('../js/lakes.js');
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

const W = 30, H = 30;
const plane = () => { const d = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = 100 + 2 * x + 3 * y; return d; };
const hole = (d, x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[y * W + x] = NaN; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// fillGaps
{
  const orig = plane(), d = plane();
  hole(d, 10, 10, 14, 14);
  const r = F.fillGaps(d, W, H);
  check('a small hole is filled completely', d.every((v) => v === v) && r.summary.filled === 16 && r.summary.gaps === 1 && r.summary.left === 0, JSON.stringify(r.summary));
  let worst = 0; for (let i = 0; i < d.length; i++) worst = Math.max(worst, Math.abs(d[i] - orig[i]));
  check('a hole in a plane is filled close to the plane', worst < 3, 'worst error ' + worst.toFixed(2) + ' m');
  check('samples outside the hole are untouched', d.every((v, i) => { const x = i % W, y = (i / W) | 0; return (x >= 10 && x < 14 && y >= 10 && y < 14) || v === orig[i]; }));
  L.revert(d, r.patches);
  check('revert puts the no-data back', d.every((v, i) => { const x = i % W, y = (i / W) | 0; const inside = x >= 10 && x < 14 && y >= 10 && y < 14; return inside ? v !== v : v === orig[i]; }));
}
{
  const d = plane(); d[5 * W + 5] = NaN;
  const r = F.fillGaps(d, W, H);
  check('a single missing pixel gets the surrounding value', r.summary.filled === 1 && near(d[5 * W + 5], 100 + 10 + 15, 0.01), String(d[5 * W + 5]));
}
{
  const d = plane(); hole(d, 0, 0, 3, 3);
  const r = F.fillGaps(d, W, H);
  check('a corner hole is filled from the sides that have data', d.every((v) => v === v) && r.summary.filled === 9);
}
{
  const d = plane(); hole(d, 5, 5, 25, 25);                  // 400 of 900 px: over the 2% limit
  const r = F.fillGaps(d, W, H);
  check('a big gap is left alone and reported', r.summary.left === 1 && r.summary.leftPixels === 400 && r.summary.filled === 0 && r.patches.length === 0, JSON.stringify(r.summary));
  const r2 = F.fillGaps(d, W, H, { maxFraction: 0.9 });
  check('the size limit can be raised', r2.summary.filled === 400 && d.every((v) => v === v));
}
{
  const d = plane(); hole(d, 3, 3, 5, 5); hole(d, 20, 20, 23, 22); d[0] = NaN;
  const r = F.fillGaps(d, W, H);
  check('several gaps are each filled', r.summary.gaps === 3 && r.summary.filled === 4 + 6 + 1 && d.every((v) => v === v), JSON.stringify(r.summary));
}
{
  const d = plane(); const copy = d.slice();
  const r = F.fillGaps(d, W, H);
  check('no gaps means no change', r.patches.length === 0 && d.every((v, i) => v === copy[i]));
  const all = new Float32Array(W * H).fill(NaN);
  const r3 = F.fillGaps(all, W, H, { maxFraction: 2 });
  check('a grid with no data at all stays empty', r3.summary.filled === 0 && all.every((v) => v !== v));
}
{
  const d = plane(); d[10 * W + 10] = NaN; d[10 * W + 11] = NaN; d[11 * W + 11] = NaN;   // a diagonal chain is one gap
  const r = F.fillGaps(d, W, H);
  check('diagonally touching pixels count as one gap', r.summary.gaps === 1 && r.summary.filled === 3);
}

// raiseFloor
{
  const orig = plane(), d = plane();
  hole(d, 1, 1, 2, 2);
  const r = F.raiseFloor(d, 120);
  let below = 0, ok = true;
  for (let i = 0; i < d.length; i++) { if (orig[i] < 120) below++; if (d[i] === d[i] && d[i] < 120) ok = false; if (orig[i] >= 120 && d[i] !== orig[i] && d[i] === d[i]) ok = false; }
  check('everything below the floor is raised to it, the rest is untouched', ok && r.summary.raised === below - 1, r.summary.raised + ' of ' + below);
  check('no-data is not turned into data', d[1 * W + 1] !== d[1 * W + 1]);
  L.revert(d, r.patches);
  check('revert restores the original samples', d.every((v, i) => (v !== v && (i === W + 1)) || v === orig[i]));
  const d2 = plane(); const r2 = F.raiseFloor(d2, -50);
  check('a floor below everything changes nothing', r2.summary.raised === 0 && r2.patches.length === 0);
}
{
  // gap fill then floor then revert in reverse order restores the original
  const orig = plane(), d = plane(); hole(d, 8, 8, 11, 11);
  const a = F.fillGaps(d, W, H), b = F.raiseFloor(d, 130);
  L.revert(d, [...a.patches, ...b.patches]);
  check('stacked fixes revert newest first', d.every((v, i) => { const x = i % W, y = (i / W) | 0; return (x >= 8 && x < 11 && y >= 8 && y < 11) ? v !== v : v === orig[i]; }));
}
{
  // speed on a large grid with many gaps
  const w = 2000, h = 1333, d = new Float32Array(w * h).fill(10);
  for (let k = 0; k < 400; k++) { const x = (k * 37) % (w - 12), y = (k * 53) % (h - 12); for (let j = 0; j < 36; j++) d[(y + (j / 6 | 0)) * w + x + (j % 6)] = NaN; }
  const t = Date.now(), r = F.fillGaps(d, w, h);
  check('400 gaps on a 2000 x 1333 grid fill in under 2 s', r.summary.filled > 13000 && Date.now() - t < 2000, (Date.now() - t) + ' ms, ' + r.summary.filled + ' px');
}
