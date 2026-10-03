/* A minimal ZIP writer: stored entries only (no compression), because what goes in are PNGs, which are already
 * compressed. Entries are { name, data } with data a Uint8Array, a string (UTF-8) or a Blob. Names are written as UTF-8.
 * Returns a Blob. No ZIP64, so a file or the whole archive must stay under 4 GB (it throws otherwise).
 * Works in browsers and Node 18+.
 */
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }

  async function makeZip(entries, when) {
    const enc = new TextEncoder(), stamp = dosTime(when || new Date());
    const parts = [], central = [];
    let offset = 0;
    const seen = new Set();
    for (const e of entries) {
      if (seen.has(e.name)) throw new Error('Duplicate name in the archive: ' + e.name);
      seen.add(e.name);
      const bytes = e.data instanceof Blob ? new Uint8Array(await e.data.arrayBuffer()) : typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      if (bytes.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('The archive would be over 4 GB.');
      const name = enc.encode(e.name), crc = crc32(bytes);
      const head = new Uint8Array(30 + name.length), h = new DataView(head.buffer);
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, stamp.time, true); h.setUint16(12, stamp.date, true); h.setUint32(14, crc, true);
      h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      head.set(name, 30);
      const cd = new Uint8Array(46 + name.length), c = new DataView(cd.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, stamp.time, true); c.setUint16(14, stamp.date, true); c.setUint32(16, crc, true);
      c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      cd.set(name, 46);
      parts.push(head, bytes); central.push(cd);
      offset += head.length + bytes.length;
    }
    const size = central.reduce((n, p) => n + p.length, 0);
    if (entries.length > 0xffff || offset + size >= 0xffffffff) throw new Error('The archive is too large for a plain ZIP.');
    const end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true); v.setUint32(12, size, true); v.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  const api = { makeZip, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCZip = api;
})(typeof self !== 'undefined' ? self : this);
