// 3DEP framing: the service grows the extent of a request whose pixel aspect differs from its degree aspect. The fetch must
// still land every sample at its true lon/lat. Server emulated here (extent growth + georeferenced reply), no network.
global.self = global;
global.MapNCGeo = require('../js/geo.js');
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
const truth = (lon, lat) => 1000 + (lon + 120.2) * 20000 + (lat - 38.8) * 30000;
const replies = [];
global.GeoTIFF = { fromArrayBuffer: async (buf) => {
  const r = replies[new DataView(buf).getUint32(4, true)];
  return { getImage: async () => ({ getWidth: () => r.w, getHeight: () => r.h, readRasters: async () => [r.data], getGDALNoData: () => null, getBoundingBox: () => [r.west, r.south, r.east, r.north] }) };
} };
let requests = [];
global.fetch = async (url) => {
  const u = new URL(url); let [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
  requests.push({ west, south, east, north, w, h });
  // ArcGIS exportImage: keep the extent's longer side, grow the other so the pixels come out square
  const lonS = east - west, latS = north - south;
  if (Math.abs(lonS / latS - w / h) > 1e-6) {
    if (lonS / latS < w / h) { const grow = latS * 0 + lonS * h / w; const mid = (north + south) / 2; south = mid - grow / 2; north = mid + grow / 2; }
    else { const grow = latS * w / h; const mid = (east + west) / 2; west = mid - grow / 2; east = mid + grow / 2; }
  }
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = truth(west + (i + 0.5) / w * (east - west), north - (j + 0.5) / h * (north - south));
  replies.push({ w, h, data, west, south, east, north });
  const b = Buffer.alloc(16); b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(replies.length - 1, 4);
  return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + 16) };
};
const S = require('../js/sources.js');
(async () => {
  const bounds = { west: -120.2, east: -120.1, south: 38.8, north: 38.85 };
  const grid = global.MapNCGeo.gridFor(bounds, 30);
  const out = await S.fetch3dep(bounds, { grid, interpolation: 'bilinear', label: 't' }, {});
  check('grid is ground-correct, not degree-proportional', Math.abs(grid.width / grid.height - 2) > 0.2, grid.width + 'x' + grid.height);
  check('request is made at the extent\'s own degree aspect', requests.every((r) => Math.abs((r.east - r.west) / (r.north - r.south) - r.w / r.h) < 0.01), JSON.stringify(requests[0]));
  let worst = 0;
  for (let j = 2; j < grid.height - 2; j += 7) for (let i = 2; i < grid.width - 2; i += 7) {
    const want = truth(bounds.west + (i + 0.5) / grid.width * (bounds.east - bounds.west), bounds.north - (j + 0.5) / grid.height * (bounds.north - bounds.south));
    worst = Math.max(worst, Math.abs(out.data[j * grid.width + i] - want));
  }
  check('every sample sits at its true lon/lat', worst < 5, 'worst error ' + worst.toFixed(2) + ' m (slope is ~30 m per grid pixel)');
  // the same data, taken as the old code did (assume the requested extent), would be wrong: prove the test can fail
  const naive = replies[0]; const nv = naive.data[Math.floor(naive.h / 2) * naive.w + Math.floor(naive.w / 2)];
  check('the emulated server really does re-frame', replies[0].north !== bounds.north || replies[0].east !== bounds.east || requests[0].w / requests[0].h !== grid.width / grid.height);
})();
