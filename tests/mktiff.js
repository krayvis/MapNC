// Minimal little-endian float32 GeoTIFF: one uncompressed strip, GDAL_NODATA "-9999".
module.exports = function mkTiff(arr, w, h) {
  const nodata = Buffer.from('-9999\0', 'ascii');
  const entries = 11, ifdSize = 2 + entries * 12 + 4;
  const ifdOff = 8, ndOff = ifdOff + ifdSize, dataOff = ndOff + nodata.length + (nodata.length % 2);
  const buf = Buffer.alloc(dataOff + arr.length * 4);
  buf.write('II', 0); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOff, 4);
  buf.writeUInt16LE(entries, ifdOff);
  let p = ifdOff + 2;
  const ent = (tag, type, count, val) => { buf.writeUInt16LE(tag, p); buf.writeUInt16LE(type, p + 2); buf.writeUInt32LE(count, p + 4); if (type === 3 && count === 1) buf.writeUInt16LE(val, p + 8); else buf.writeUInt32LE(val, p + 8); p += 12; };
  ent(256, 4, 1, w); ent(257, 4, 1, h); ent(258, 3, 1, 32); ent(259, 3, 1, 1); ent(262, 3, 1, 1);
  ent(273, 4, 1, dataOff); ent(277, 3, 1, 1); ent(278, 4, 1, h); ent(279, 4, 1, arr.length * 4); ent(339, 3, 1, 3); ent(42113, 2, 6, ndOff);
  // GDAL_NODATA (42113) must sort after 339; entries are 10 so replace SampleFormat slot ordering: add as 11th via patch below
  nodata.copy(buf, ndOff);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], dataOff + i * 4);
  return buf;
};
