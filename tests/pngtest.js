const H = require('../js/heightmap.js');
const fs = require('fs');
(async () => {
  const W = 300, Hh = 200;
  const elev = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) elev[y * W + x] = 100 + x * 2.5 + y * 1.1 + 20 * Math.sin(x / 9);
  elev[5] = NaN;
  const stats = { min: 100, max: 100 + 299 * 2.5 + 199 * 1.1 + 20 };
  for (const bits of [16, 8]) {
    const g = H.toGrey(elev, { stats, rangeMode: 'auto', exaggeration: 1, bits, invert: false });
    const blob = await H.encodePng(W, Hh, bits, g.data, { Software: 'MapNC test', Range: '100-900' });
    fs.writeFileSync(require('./lib.js').OUT + `/t${bits}.png`, Buffer.from(await blob.arrayBuffer()));
    fs.writeFileSync(require('./lib.js').OUT + `/t${bits}.raw`, Buffer.from(g.data.buffer));
    console.log(bits, 'bytes', blob.size, 'perLevel', g.metresPerLevel.toExponential(3), 'nodata', g.nodata, 'clipH', g.clippedHigh);
  }
  const ex = H.toGrey(elev, { stats, rangeMode: 'auto', exaggeration: 2, bits: 16 });
  console.log('k=2 clippedHigh%', (100 * ex.clippedHigh / elev.length).toFixed(1), 'perLevel', ex.metresPerLevel.toExponential(3));
  const man = H.toGrey(elev, { stats, rangeMode: 'manual', manualLo: 200, manualHi: 600, exaggeration: 1, bits: 16, invert: true });
  console.log('manual: lo/hi', man.lo, man.hi, 'clipH', man.clippedHigh, 'clipL', man.clippedLow, 'g[0..2]', man.data[0], man.data[1], man.data[5]);
})();
