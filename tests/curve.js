// Height curve in toGrey: linear is unchanged, valleys lift low ground, peaks lower it, the ends stay put.
const H = require('../js/heightmap.js');
let fails = 0; const check = (n, ok, d) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + (d || ''))); if (!ok) fails++; };
const elev = new Float32Array([0, 25, 50, 75, 100]), stats = { min: 0, max: 100 };
const g = (curve) => Array.from(H.toGrey(elev, { stats, rangeMode: 'auto', bits: 16, curve }).data);
const lin = g(undefined);
check('linear is the identity ramp', lin[2] === Math.round(0.5 * 65535) && lin[0] === 0 && lin[4] === 65535);
check('kind linear / strength 1 changes nothing', JSON.stringify(g({ kind: 'linear', strength: 3 })) === JSON.stringify(lin) && JSON.stringify(g({ kind: 'valleys', strength: 1 })) === JSON.stringify(lin));
const v = g({ kind: 'valleys', strength: 2 }), p = g({ kind: 'peaks', strength: 2 });
check('valleys: mid-height is lifted (sqrt)', Math.abs(v[2] - Math.round(Math.sqrt(0.5) * 65535)) <= 1, v[2]);
check('peaks: mid-height is lowered (square)', Math.abs(p[2] - Math.round(0.25 * 65535)) <= 1, p[2]);
check('ends stay at black and white', v[0] === 0 && v[4] === 65535 && p[0] === 0 && p[4] === 65535);
check('both stay monotonic', v.every((x, i) => i === 0 || x >= v[i - 1]) && p.every((x, i) => i === 0 || x >= p[i - 1]));
const inv = Array.from(H.toGrey(elev, { stats, rangeMode: 'auto', bits: 16, invert: true, curve: { kind: 'valleys', strength: 2 } }).data);
check('invert applies after the curve', inv[2] === 65535 - v[2]);
process.exit(fails ? 1 : 0);
