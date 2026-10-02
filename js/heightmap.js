/* Heightmap mapping and PNG encoding for MapNC.
 *
 * Elevation -> grey:   t = clamp(((z - lo) / (hi - lo)) * k, 0, 1)      k = vertical exaggeration
 *                      grey = round(t * maxVal)                          maxVal = 65535 (16-bit) or 255 (8-bit)
 * `lo` maps to grey 0 (black = lowest). With k > 1 the relief is stretched upward from `lo`, so anything above
 * lo + (hi - lo)/k clips to white. No-data samples always become grey 0. `invert` flips the result afterwards.
 * Metres per grey level = (hi - lo) / (k * maxVal).
 *
 * Works in browsers and Node 18+ (needs Blob + CompressionStream for PNG encoding).
 */
(function (root) {
  'use strict';

  /** Resolve the elevation window. mode: 'auto' uses data min/max; 'manual' uses the given lo/hi. */
  function resolveRange(stats, mode, manualLo, manualHi) {
    let lo = stats.min, hi = stats.max;
    if (mode === 'manual' && Number.isFinite(manualLo) && Number.isFinite(manualHi)) { lo = manualLo; hi = manualHi; }
    if (!(hi > lo)) hi = lo + 1;    // flat terrain / bad manual range: avoid dividing by zero
    return { lo, hi };
  }

  /**
   * Map elevations to grey values.
   * @returns {{ data: Uint8Array|Uint16Array, maxVal, lo, hi, k, metresPerLevel, clippedHigh, clippedLow, nodata }}
   */
  function toGrey(elev, opts) {
    const bits = opts.bits === 8 ? 8 : 16;
    const maxVal = bits === 8 ? 255 : 65535;
    const k = opts.exaggeration > 0 ? opts.exaggeration : 1;
    const { lo, hi } = resolveRange(opts.stats, opts.rangeMode, opts.manualLo, opts.manualHi);
    const scale = k / (hi - lo);
    const out = bits === 8 ? new Uint8Array(elev.length) : new Uint16Array(elev.length);
    let clippedHigh = 0, clippedLow = 0, nodata = 0;
    for (let i = 0; i < elev.length; i++) {
      const z = elev[i];
      if (z !== z) { nodata++; out[i] = 0; continue; }
      let t = (z - lo) * scale;
      if (t > 1) { clippedHigh++; t = 1; } else if (t < 0) { clippedLow++; t = 0; }
      const g = Math.round(t * maxVal);
      out[i] = opts.invert ? maxVal - g : g;
    }
    return { data: out, bits, maxVal, lo, hi, k, metresPerLevel: (hi - lo) / (k * maxVal), clippedHigh, clippedLow, nodata };
  }

  // ---- PNG ---------------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, body) {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
    return out;
  }

  async function zlibDeflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')); // zlib-wrapped, as PNG IDAT requires
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Encode greyscale samples (Uint8Array for 8-bit, Uint16Array for 16-bit) as a PNG Blob.
   * Rows use PNG filter type 2 ("Up"), which suits smooth terrain; the first row uses type 0 (None). `text` adds tEXt chunks.
   */
  async function encodePng(width, height, bits, samples, text) {
    const bpp = bits === 16 ? 2 : 1;
    const rowBytes = width * bpp;
    const raw = new Uint8Array(height * (rowBytes + 1));
    let cur = new Uint8Array(rowBytes);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
      if (bits === 16) {
        for (let x = 0, s = y * width; x < width; x++) { const v = samples[s + x]; cur[2 * x] = v >> 8; cur[2 * x + 1] = v & 255; }
      } else {
        cur.set(samples.subarray(y * width, (y + 1) * width));
      }
      const o = y * (rowBytes + 1);
      raw[o] = y === 0 ? 0 : 2;    // first row has no row above: filter None
      if (y === 0) raw.set(cur, o + 1);
      else for (let i = 0; i < rowBytes; i++) raw[o + 1 + i] = (cur[i] - prev[i]) & 255;
      [prev, cur] = [cur, prev];    // this row becomes "the row above"; reuse the old buffer for the next
    }
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width); dv.setUint32(4, height);
    ihdr[8] = bits; ihdr[9] = 0;     // colour type 0 = greyscale
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
    for (const [key, value] of Object.entries(text || {})) {
      // tEXt = keyword, NUL, text (Latin-1). Sanitise each part separately so the NUL separator survives.
      const clean = (t) => String(t).replace(/[^\x20-\x7e]/g, '?');
      const latin1 = clean(key).slice(0, 79) + '\0' + clean(value);
      parts.push(chunk('tEXt', Uint8Array.from(latin1, (c) => c.charCodeAt(0))));
    }
    parts.push(chunk('IDAT', await zlibDeflate(raw)), chunk('IEND', new Uint8Array(0)));
    return new Blob(parts, { type: 'image/png' });
  }

  const api = { resolveRange, toGrey, encodePng };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCHeightmap = api;
})(typeof self !== 'undefined' ? self : this);
