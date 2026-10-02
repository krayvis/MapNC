const T = require('../js/track.js');
let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const fails = []; const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); if (!ok) fails.push(n); };
const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ground truth: straight leg 300 m, then a 200 m-radius half circle; points every 3 m
const truth = []; for (let x = 0; x <= 300; x += 3) truth.push({ x, y: 0 });
for (let a = -Math.PI / 2; a <= Math.PI / 2; a += 3 / 200) truth.push({ x: 300 + 200 * Math.cos(a), y: 200 + 200 * Math.sin(a) });
const distToTruth = (p) => { let b = Infinity; for (let i = 1; i < truth.length; i++) b = Math.min(b, T.distToSeg(p, truth[i - 1], truth[i])); return b; };
const noisy = truth.map(p => ({ x: p.x + gauss() * 4, y: p.y + gauss() * 4 }));
const rms = (pts) => Math.sqrt(pts.reduce((s, p) => s + distToTruth(p) ** 2, 0) / pts.length);

// 1. spikes: inject 5 single and 2 double spikes 60 m off the path
const spiked = noisy.map(p => ({ ...p })); const spikeIdx = [20, 50, 90, 130, 170]; const dbl = [60, 150];
spikeIdx.forEach(i => { spiked[i].x += 60; spiked[i].y -= 60; }); dbl.forEach(i => { for (const k of [0, 1]) { spiked[i + k].x -= 70; spiked[i + k].y += 50; } });
const injected = spikeIdx.length + dbl.length * 2;
const sp = T.removeSpikes(spiked, 20);
check('spike removal finds the injected spikes', sp.removed === injected, `removed ${sp.removed}, injected ${injected}`);
check('no point left far from the true path', sp.pts.every(p => distToTruth(p) < 25), 'worst ' + Math.max(...sp.pts.map(distToTruth)).toFixed(1) + ' m');
const clean0 = T.removeSpikes(noisy, 20); check('plain GPS noise (sigma 4 m) is NOT treated as spikes', clean0.removed === 0, 'removed ' + clean0.removed);

// 2. hairpins survive: zigzag with 8 m legs sampled every 2 m, and a switchback with sparse samples
const zig = []; for (let k = 0; k < 8; k++) for (let i = 0; i <= 4; i++) zig.push({ x: (k % 2 ? 8 - i * 2 : i * 2), y: k * 3 });
check('hairpin zigzag is preserved', T.removeSpikes(zig, 20).removed === 0);
const out = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 5 }, { x: 0, y: 5 }]; // sparse out-and-back, 100 m legs
check('real out-and-back with sparse samples is preserved', T.removeSpikes(out, 20).removed === 0);

// 3. min spacing
const still = []; for (let i = 0; i < 40; i++) still.push({ x: gauss() * 1.5, y: gauss() * 1.5 }); const walk = still.concat(truth.slice(0, 40).map(p => ({ x: p.x + 20, y: p.y })));
const ms = T.minSpacing(walk, 5), cl0 = T.minSpacing(still, 5);
check('min spacing collapses the standing-still cluster', cl0.length <= 4, `${still.length} -> ${cl0.length}`);
check('min spacing enforces the gap along a walk', ms.slice(1, -1).every((p, i) => d(p, ms[i]) >= 5 - 1e-9), `${walk.length} -> ${ms.length}`);
check('min spacing keeps first and last', ms[0] === walk[0] && ms[ms.length - 1] === walk[walk.length - 1]);

// 4. smoothing
for (const sigma of [5, 10, 20]) {
  const sm = T.smooth(noisy, sigma);
  check(`smooth sigma ${sigma} m: error vs truth drops`, rms(sm) < rms(noisy) * 0.8, `rms ${rms(noisy).toFixed(2)} -> ${rms(sm).toFixed(2)} m`);
  check(`smooth sigma ${sigma} m: ends fixed`, d(sm[0], noisy[0]) < 1e-9 && d(sm[sm.length - 1], noisy[noisy.length - 1]) < 1e-9);
}
// density independence: same path sampled 3 m vs 12 m smooths to the same curve (within a few m)
const sparse = truth.filter((_, i) => i % 4 === 0); const a = T.smooth(truth, 15), b = T.smooth(sparse, 15);
let dev = 0; for (const p of b) { let best = Infinity; for (let i = 1; i < a.length; i++) best = Math.min(best, T.distToSeg(p, a[i - 1], a[i])); dev = Math.max(dev, best); }
check('smoothing does not depend on point density (noise-free path, 3 m vs 12 m)', dev < 0.5, 'max difference ' + dev.toFixed(2) + ' m');
const tiny = [{ x: 0, y: 0 }, { x: 10, y: 0 }]; check('2-point track survives smoothing', T.smooth(tiny, 10).length === 2);

// 5. simplify: guarantee, and big reduction on a smooth path
const smooth15 = T.smooth(noisy, 15);
for (const tol of [1, 3, 10]) {
  const sp2 = T.simplify(smooth15, tol); let worst = 0;
  for (const p of smooth15) { let best = Infinity; for (let i = 1; i < sp2.length; i++) best = Math.min(best, T.distToSeg(p, sp2[i - 1], sp2[i])); worst = Math.max(worst, best); }
  check(`simplify ${tol} m: every original point within tolerance`, worst <= tol + 1e-6, `${smooth15.length} -> ${sp2.length}, worst ${worst.toFixed(2)} m`);
}

// 6. full pipeline through cleanTrack on lon/lat
const lat0 = 39.6, lon0 = -120.65, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
const toLL = p => ({ lat: lat0 + p.y / ky, lon: lon0 + p.x / kx });
const tr = T.makeTrack('t', [spiked.map(toLL), noisy.slice(0, 50).map(toLL)]);
const r = T.cleanTrack(tr, { spikeM: 20, spacingM: 3, smoothM: 10, simplifyM: 2 });
console.log('   stats', JSON.stringify(r.stats, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
check('cleanTrack: fewer points, 2 segments kept', r.stats.pointsAfter < r.stats.pointsBefore / 3 && r.track.segments.length === 2);
check('cleanTrack: reports spikes removed', r.stats.spikes >= injected);
check('cleanTrack: shortens a noisy path', r.stats.lengthAfterKm < r.stats.lengthBeforeKm);
check('cleanTrack: no ops returns the same track', T.cleanTrack(tr, {}).track === tr && T.cleanTrack(tr, {}).stats.changed === false);
check('cleanTrack: largest shift reported and sensible', r.stats.maxShiftM > 5 && r.stats.maxShiftM < 120, r.stats.maxShiftM.toFixed(1) + ' m');
// ground-truth closeness after full clean
const cl = r.track.segments[0].map(p => ({ x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky }));
check('cleaned path hugs the true path', rms(cl) < 3, 'rms ' + rms(cl).toFixed(2) + ' m (raw noisy ' + rms(noisy).toFixed(2) + ')');

// spline fit: passes through every point, stays close to a circle, straight runs stay light
{
  const R = 100, ctrl = []; for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI; ctrl.push({ lat: 40 + R * Math.sin(a) / 110574, lon: -120 + R * Math.cos(a) / (111320 * Math.cos(40 * Math.PI / 180)) }); }
  const sp = T.splineTrack(T.makeTrack('c', [ctrl]), 0.5).segments[0];
  const near = (p) => Math.min(...sp.map((q) => Math.hypot((q.lat - p.lat) * 110574, (q.lon - p.lon) * 111320 * Math.cos(40 * Math.PI / 180))));
  check('spline passes through every control point', ctrl.every((p) => near(p) < 0.01));
  const radial = sp.map((q) => Math.hypot((q.lat - 40) * 110574, (q.lon + 120) * 111320 * Math.cos(40 * Math.PI / 180)));
  check('spline of a circle arc stays within 1 m of the circle', Math.max(...radial.map((r) => Math.abs(r - R))) < 1, Math.max(...radial.map((r) => Math.abs(r - R))).toFixed(2));
  check('spline adds points on bends', sp.length > ctrl.length);
  const line = T.makeTrack('l', [[0, 1, 2, 3].map((i) => ({ lat: 40 + i * 0.0001, lon: -120 }))]);
  check('spline of a straight line adds no points', T.splineTrack(line, 0.5).segments[0].length === 4);
  check('spline with fewer than 3 points is unchanged', T.splineTrack(T.makeTrack('s', [[{ lat: 40, lon: -120 }, { lat: 40.001, lon: -120 }]]), 0.5).segments[0].length === 2);
}

// out-and-back merge
{
  const path = (i, n) => { const t = i / n * 600; return { x: t, y: 40 * Math.sin(t / 90) }; };
  const jig = (q, amp) => ({ x: q.x + (rnd() - 0.5) * 2 * amp, y: q.y + (rnd() - 0.5) * 2 * amp });
  const out = [], back = [];
  for (let i = 0; i <= 120; i++) out.push(jig(path(i, 120), 1.4));
  for (let i = 0; i <= 100; i++) back.push(jig(path(100 - i, 100), 1.4));
  const sep = (A, B) => { let w = 0, sum = 0; for (const p of A) { let b = 1e9; for (let j = 1; j < B.length; j++) b = Math.min(b, T.distToSeg(p, B[j - 1], B[j])); w = Math.max(w, b); sum += b; } return { max: w, mean: sum / A.length }; };
  const before = sep(out, back);
  const m = T.mergeBacktracks([out.concat(back)], 3);
  const o2 = m[0].slice(0, out.length), b2 = m[0].slice(out.length);
  const after = sep(o2, b2);
  check('merge pulls the two legs together', after.mean < before.mean * 0.4, before.mean.toFixed(2) + ' -> ' + after.mean.toFixed(2) + ' m mean');
  check('merge keeps point counts', m[0].length === out.length + back.length);
  const moved = Math.max(...m[0].map((q, i) => d(q, i < out.length ? out[i] : back[i - out.length])));
  check('merge moves no point farther than the distance', moved <= 3, moved.toFixed(2) + ' m');
  const far = [[...Array(60).keys()].map((i) => ({ x: i * 10, y: 0 })), [...Array(60).keys()].map((i) => ({ x: 590 - i * 10, y: 25 }))];
  const fm = T.mergeBacktracks([far[0].concat(far[1])], 3);
  check('legs 25 m apart are left alone', fm[0].every((q, i) => q.x === far[0].concat(far[1])[i].x && q.y === far[0].concat(far[1])[i].y));
  const sw = [...Array(6).keys()].map((i) => ({ x: i * 4, y: 0 })).concat([...Array(6).keys()].map((i) => ({ x: 20 - i * 4, y: 2.5 })));
  const sm = T.mergeBacktracks([sw], 3);
  check('a tight switchback (short path between legs) is left alone', sm[0].every((q, i) => q.x === sw[i].x && q.y === sw[i].y));
  check('merge off returns the input', T.mergeBacktracks([out], 0)[0] === out);
}
console.log(fails.length ? 'FAILED: ' + fails.join('; ') : 'all clean-up checks pass');
