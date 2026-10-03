// Canadian source: where Auto picks it, the WCS request format, and a mocked service that answers in lat/lon at the
// bounding box it was given (grown if the pixel aspect differs, as the 3DEP emulation does). No network.
global.self = global;
global.MapNCGeo = require('../js/geo.js');
const G = global.MapNCGeo;
const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
const box = (lat, lon, d) => ({ south: lat - d, north: lat + d, west: lon - d, east: lon + d });
const id = (b, pref) => G.planSource(b, pref || 'auto', { mode: 'auto' }).id;

// ---- detection
check('Ottawa picks Canada', id(box(45.42, -75.70, 0.05)) === 'canada');
check('northern Ontario picks Canada', id(box(51.0, -90.0, 0.2)) === 'canada');
check('Banff picks Canada', id(box(51.18, -115.57, 0.1)) === 'canada');
check('Cape Breton picks Canada', id(box(46.4, -60.8, 0.1)) === 'canada');
check('the far north picks Canada', id(box(70.0, -100.0, 0.5)) === 'canada');
check('Sierra Buttes still picks 3DEP', id(box(39.59, -120.66, 0.05)) === '3dep');
check('Seattle picks 3DEP', id(box(47.6, -122.3, 0.1)) === '3dep');
check('Maine picks 3DEP', id(box(45.0, -69.0, 0.1)) === '3dep');
check('Buffalo picks 3DEP', id(box(42.9, -78.85, 0.05)) === '3dep');
check('Alaska panhandle is not Canada', id(box(58.3, -134.4, 0.1)) !== 'canada');
check('Mexico City is not Canada', id(box(19.4, -99.1, 0.1)) === 'terrarium');
check('a region across the border gets the global source', id({ south: 48.9, north: 49.1, west: -120.2, east: -120.0 }) === 'terrarium');
check('explicit Canada is honoured anywhere', id(box(39.59, -120.66, 0.05), 'canada') === 'canada');
const p = G.planSource(box(39.59, -120.66, 0.05), 'canada', { mode: 'auto' });
check('explicit Canada outside Canada warns', /NoData/.test(p.resolutionNote) && p.region === null, p.resolutionNote);
const q = G.planSource(box(45.42, -75.70, 0.05), 'auto', { mode: 'auto' });
check('the plan names the source', q.label === 'NRCan High Resolution DEM' && q.region === 'Canada' && q.resolutionM === 10 && q.grid.width > 0);

// ---- request format
const S = require('../js/sources.js');
const url = S.canadaUrl({ west: -75.74, south: 45.38, east: -75.70, north: 45.42 }, 500, 400);
const u = new URL(url), g = (k) => u.searchParams.get(k);
check('request is WCS 1.1.1 GetCoverage for dtm as a GeoTIFF', g('service') === 'WCS' && g('version') === '1.1.1' && g('request') === 'GetCoverage' && g('identifier') === 'dtm' && g('format') === 'image/geotiff');
check('the bounding box is south,west,north,east in EPSG:4326', g('boundingbox') === '45.38,-75.74,45.42,-75.7,urn:ogc:def:crs:EPSG::4326', g('boundingbox'));
check('the pixel size is gridoffsets, latitude step negative first', g('gridoffsets') === '-0.0001,0.00008', g('gridoffsets'));
check('grid CRS parameters are set', g('gridbasecrs') === 'urn:ogc:def:crs:EPSG::4326' && g('gridcs') === 'urn:ogc:def:crs:OGC::imageCRS' && g('gridtype') === 'urn:ogc:def:method:WCS:1.1:2dGridIn2dCrs');

// ---- mocked service
const truth = (lon, lat) => 100 + (lon + 75.9) * 8000 + (lat - 45.2) * 12000;
const replies = [], requests = [];
global.GeoTIFF = { fromArrayBuffer: async (buf) => {
  const r = replies[new DataView(buf).getUint32(4, true)];
  return { getImage: async () => ({ getWidth: () => r.w, getHeight: () => r.h, readRasters: async () => [r.data], getGDALNoData: () => -32767, getBoundingBox: () => [r.west, r.south, r.east, r.north] }) };
} };
let fail = null, holey = false; const seen = [];
global.fetch = async (url) => {
  const uu = new URL(url);
  seen.push(url);
  if (/nationalmap/.test(url)) throw new Error('unexpected 3DEP call');
  if (fail) return { ok: false, status: fail };
  const [south, west, north, east] = uu.searchParams.get('boundingbox').split(',').slice(0, 4).map(Number);
  const [dLat, dLon] = uu.searchParams.get('gridoffsets').split(',').map(Number);
  const w = Math.round((east - west) / dLon), h = Math.round((north - south) / -dLat);
  requests.push({ west, south, east, north, w, h, dLat, dLon });
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = ((i < 3 && j < 3) || (holey && i > w / 3)) ? -32767 : truth(west + (i + 0.5) / w * (east - west), north - (j + 0.5) / h * (north - south));
  replies.push({ w, h, data, west, south, east, north });
  const b = Buffer.alloc(16); b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(replies.length - 1, 4);
  return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + 16) };
};
(async () => {
  const bounds = { west: -75.9, east: -75.8, south: 45.2, north: 45.25 };
  const out = await S.fetchElevation(Object.assign({}, bounds), 'auto', { spec: { mode: 'pixels', value: 800 } });
  check('Auto fetches from the Canadian service', /NRCan/.test(out.sourceLabel) && requests.length >= 1, out.sourceLabel + ', ' + requests.length + ' requests');
  check('the request pixels are square in degrees', requests.every((r) => Math.abs((r.east - r.west) / r.w - (r.north - r.south) / r.h) < 1e-9));
  let worst = 0;
  for (let j = 4; j < out.height - 2; j += 11) for (let i = 4; i < out.width - 2; i += 11) {
    const want = truth(bounds.west + (i + 0.5) / out.width * (bounds.east - bounds.west), bounds.north - (j + 0.5) / out.height * (bounds.north - bounds.south));
    worst = Math.max(worst, Math.abs(out.data[j * out.width + i] - want));
  }
  check('every sample sits at its true lon/lat', worst < 3, 'worst ' + worst.toFixed(2) + ' m');
  check('no-data (-32767) becomes NaN', out.nodata > 0 && out.min > 0, 'nodata ' + out.nodata + ', min ' + out.min);

  // a big region is split in chunks and each request stays under the size limit
  requests.length = 0;
  const big = { west: -76.2, east: -75.6, south: 45.0, north: 45.4 };
  await S.fetchElevation(big, 'canada', { spec: { mode: 'pixels', value: 4000 } });
  check('large grids go out as several chunks', requests.length > 1, requests.length + ' requests');
  check('no request is bigger than 3000 px a side', requests.every((r) => r.w <= 3000 && r.h <= 3000), requests.map((r) => r.w + 'x' + r.h).join(' '));

  // coverage: an Auto fetch that is mostly no-data goes to Terrarium; choosing Canada keeps the partial data
  holey = true; seen.length = 0;
  let part = null, err0 = null;
  try { part = await S.fetchElevation(Object.assign({}, bounds), 'canada', { spec: { mode: 'pixels', value: 300 } }); } catch (e) { err0 = e; }
  check('choosing Canada keeps a partial result', part && part.nodata > 0 && /NRCan/.test(part.sourceLabel) && !seen.some((x) => /elevation-tiles-prod/.test(x)), err0 && err0.message);
  seen.length = 0;
  try { await S.fetchElevation(Object.assign({}, bounds), 'auto', { spec: { mode: 'pixels', value: 300 } }); } catch (e) { /* the mock has no tiles to decode; only the request matters */ }
  check('Auto leaves a mostly empty Canadian result for Terrarium', seen.some((x) => /elevation-tiles-prod/.test(x)), seen.length + ' requests');
  holey = false;

  // failure: Auto falls back to Terrarium, an explicit choice does not
  fail = 503;
  let err = null;
  try { await S.fetchElevation(Object.assign({}, bounds), 'canada', { spec: { mode: 'pixels', value: 300 } }); } catch (e) { err = e; }
  check('an explicit Canada choice reports the failure', err && /NRCan request failed: HTTP 503/.test(err.message), err && err.message);
  check('the service name is in the message', err && !/3DEP/.test(err.message));
  fail = 404; err = null;
  try { await S.fetchElevation(Object.assign({}, bounds), 'auto', { spec: { mode: 'pixels', value: 300 } }); } catch (e) { err = e; }
  check('Auto tries the global source after a failure', seen.some((x) => /elevation-tiles-prod/.test(x)), seen.length + ' requests');
  seen.length = 0; fail = 404; err = null;
  try { await S.fetchElevation(Object.assign({}, bounds), 'canada', { spec: { mode: 'pixels', value: 300 } }); } catch (e) { err = e; }
  check('an explicit choice never switches source', err && !seen.some((x) => /elevation-tiles-prod/.test(x)));
})().catch((e) => { console.log('FAIL exception ' + e.stack); process.exit(1); });
