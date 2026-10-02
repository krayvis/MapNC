const T = require('../js/track.js'), H = require('../js/heightmap.js'), G = require('../js/geo.js');
const fs = require('fs');
const txt = fs.readFileSync(__dirname + '/../samples/sierra-buttes-fire-lookout.gpx', 'utf8');
const pts = [...txt.matchAll(/lat="([-\d.]+)" lon="([-\d.]+)"/g)].map(m => ({ lat: +m[1], lon: +m[2] }));
const track = T.makeTrack('s', [pts]);
const bounds = T.padBounds(T.trackBounds(track), 0.15);
const g = G.groundSize(bounds), longM = Math.max(g.widthM, g.heightM);
const dimsFor = (longPx) => { const pm = longM / longPx; return { W: Math.round(g.widthM / pm), H: Math.round(g.heightM / pm), pm }; };
const COLOR = [225, 29, 72];
async function streamed(W, H_, pm, widthM, outPath, bandBudget = 4e6) {
  const r = widthM / 2 / pm, rowsPerBand = Math.max(1, Math.floor(bandBudget / W));
  const br = T.createBandRasterizer(track, bounds, W, H_, r, 'uniform', rowsPerBand);
  const cov = new Float32Array(W * rowsPerBand), rgba = new Uint8Array(W * rowsPerBand * 4);
  for (let i = 0; i < W * rowsPerBand; i++) { rgba[i * 4] = COLOR[0]; rgba[i * 4 + 1] = COLOR[1]; rgba[i * 4 + 2] = COLOR[2]; }
  const t0 = Date.now();
  const blob = await H.encodePngStream({ width: W, height: H_, channels: 4, rowsPerBand, text: { Software: 'MapNC test' }, pixelsPerMetre: 1 / pm,
    getRows: async (y0, n) => { const band = Math.floor(y0 / rowsPerBand); if (br.isEmpty(band)) { for (let i = 0; i < W * n; i++) rgba[i * 4 + 3] = 0; return rgba.subarray(0, W * n * 4); }
      br.render(band, cov); for (let i = 0; i < W * n; i++) rgba[i * 4 + 3] = Math.round(cov[i] * 255); return rgba.subarray(0, W * n * 4); } });
  if (outPath) fs.writeFileSync(outPath, Buffer.from(await blob.arrayBuffer()));
  return { size: blob.size, ms: Date.now() - t0 };
}
(async () => {
  // 1. band rasterizer == full rasterizer
  const { W, H: Hh, pm } = dimsFor(2048); const r = 20 / 2 / pm;
  for (const shape of ['uniform', 'rounded', 'v']) {
    const full = T.rasterize(track, bounds, W, Hh, r, shape), rowsPerBand = 97, br = T.createBandRasterizer(track, bounds, W, Hh, r, shape, rowsPerBand), buf = new Float32Array(W * rowsPerBand);
    let worst = 0;
    for (let b = 0; b < br.bands; b++) { const rows = br.render(b, buf); for (let i = 0; i < rows * W; i++) worst = Math.max(worst, Math.abs(buf[i] - full[b * rowsPerBand * W + i])); }
    console.log(`band == full rasterize (${shape}, ${W}x${Hh}, ${br.bands} bands): max |diff| = ${worst.toExponential(2)}`);
  }
  // 2. streamed PNG vs in-memory PNG for the same pixels
  const full = T.rasterize(track, bounds, W, Hh, r, 'uniform'); const rgba = new Uint8Array(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) { rgba[i * 4] = COLOR[0]; rgba[i * 4 + 1] = COLOR[1]; rgba[i * 4 + 2] = COLOR[2]; rgba[i * 4 + 3] = Math.round(full[i] * 255); }
  const mem = await H.encodePng(W, Hh, 8, rgba, { Software: 'MapNC test' }, 4, 1 / pm);
  fs.writeFileSync(require('./lib.js').OUT + '/mem.png', Buffer.from(await mem.arrayBuffer()));
  const st = await streamed(W, Hh, pm, 20, require('./lib.js').OUT + '/stream.png', 123456);
  console.log(`in-memory ${mem.size} B | streamed ${st.size} B (${st.ms} ms)`);
  // 3. big sizes
  for (const longPx of [4096, 8192, 16384]) {
    const d = dimsFor(longPx); const rss0 = process.memoryUsage().rss; let peak = rss0; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    const res = await streamed(d.W, d.H, d.pm, 20, longPx === 8192 ? require('./lib.js').OUT + '/big8192.png' : null);
    clearInterval(iv); peak = Math.max(peak, process.memoryUsage().rss);
    console.log(`${d.W}x${d.H} (${(d.W * d.H * 4 / 1048576).toFixed(0)} MB raw RGBA): ${(res.size / 1024).toFixed(0)} KB file, ${(res.ms / 1000).toFixed(1)} s, peak RSS +${Math.round((peak - rss0) / 1048576)} MB (line ${(20 / d.pm).toFixed(0)} px wide)`);
  }
  // 4. cancel
  let n = 0; try { await H.encodePngStream({ width: 100, height: 1000, channels: 4, rowsPerBand: 10, isCancelled: () => ++n > 3, getRows: async (y, k) => new Uint8Array(100 * k * 4) }); console.log('cancel: FAIL no error'); } catch (e) { console.log('cancel ->', e.name); }
})();
