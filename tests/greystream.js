// Streaming heightmap export: same pixels and metadata as the whole-image encoder, with far less memory.
const zlib = require('zlib');
const H = require('../js/heightmap.js');
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));

async function bytes(blob) { return Buffer.from(await blob.arrayBuffer()); }
function chunks(buf) {
  const out = []; let o = 8;
  while (o < buf.length) { const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8); out.push({ type, body: buf.subarray(o + 8, o + 8 + len) }); o += 12 + len; }
  return out;
}
const pixels = (buf) => zlib.inflateSync(Buffer.concat(chunks(buf).filter((c) => c.type === 'IDAT').map((c) => c.body)));
const meta = (buf) => chunks(buf).filter((c) => c.type !== 'IDAT').map((c) => c.type + ':' + c.body.toString('hex')).join('|');

(async () => {
  for (const [bits, W, Hh] of [[16, 301, 217], [8, 301, 217], [16, 64, 3000], [16, 5000, 7]]) {
    const n = W * Hh, s = bits === 16 ? new Uint16Array(n) : new Uint8Array(n);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) s[y * W + x] = ((x * 37 + y * 101 + ((x * y) % 7)) * 13) % (bits === 16 ? 65536 : 256);
    const text = { Software: 'MapNC', Note: 'a b c' };
    const whole = await bytes(await H.encodePng(W, Hh, bits, s, text, 1, 5000));
    const prog = [];
    const streamed = await bytes(await H.encodeGreyStream(W, Hh, bits, s, { text, pixelsPerMetre: 5000, rowsPerBand: 50, onProgress: (f) => prog.push(f) }));
    check(bits + '-bit ' + W + 'x' + Hh + ': identical pixels', pixels(whole).equals(pixels(streamed)));
    check(bits + '-bit ' + W + 'x' + Hh + ': identical header, resolution and text', meta(whole) === meta(streamed));
    check('progress reaches 1 and never goes back', prog.length > 0 && prog[prog.length - 1] === 1 && prog.every((v, i) => !i || v >= prog[i - 1]));
  }
  // default band size on a wide image still works
  const s = new Uint16Array(4000 * 40).map((_, i) => i * 7);
  const a = await bytes(await H.encodePng(4000, 40, 16, s, {}, 1)), b = await bytes(await H.encodeGreyStream(4000, 40, 16, s));
  check('default band size gives the same pixels', pixels(a).equals(pixels(b)));
  // cancel
  let msg = '';
  try { await H.encodeGreyStream(100, 100, 16, new Uint16Array(10000), { rowsPerBand: 10, isCancelled: () => true }); } catch (e) { msg = e.name; }
  check('cancelling rejects with AbortError', msg === 'AbortError', msg);
  // memory on a big image
  const W = 12000, Hh = 12000;
  const big = new Uint16Array(W * Hh);
  for (let y = 0; y < Hh; y++) { const v = (y * 5) & 0xffff; for (let x = 0; x < W; x++) big[y * W + x] = v + (x >> 4); }
  global.gc && global.gc();
  const base = process.memoryUsage().rss; let peak = base;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const t0 = Date.now();
  const blob = await H.encodeGreyStream(W, Hh, 16, big, {});
  clearInterval(iv);
  const extra = (peak - base) / 1048576;
  check('a 144 M-sample 16-bit heightmap streams with a small memory overhead', extra < 400, 'extra ' + extra.toFixed(0) + ' MB for the ' + (blob.size / 1048576).toFixed(1) + ' MB file in ' + (Date.now() - t0) + ' ms; the whole-image encoder needs ' + (W * Hh * 2 / 1048576).toFixed(0) + ' MB for its raw copy alone');
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
