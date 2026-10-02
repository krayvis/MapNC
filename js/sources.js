/* Elevation fetchers for MapNC. Both return the same thing:
 *   { data: Float32Array (metres, NaN = no data), width, height, bounds, sourceLabel }
 *
 * Output grid frame: row 0 is the NORTH edge, column 0 is the WEST edge. Samples are evenly spaced in
 * lon/lat across `bounds`; the grid's width/height come from Geo.gridFor(), i.e. from GROUND distance
 * (dLon * cos(midLat) by dLat), so the image has the true ground aspect ratio. Mercator tile pixels are
 * resampled into this grid rather than copied across.
 */
(function (root) {
  'use strict';
  const Geo = root.MapNCGeo;

  const TERRARIUM_URL = (z, x, y) => 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + z + '/' + x + '/' + y + '.png';
  const DEP_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  const DEP_CHUNK_PX = 2000;      // conservative per-request size until the service limit is read at runtime
  const CONCURRENCY = 4;
  const DEG = Math.PI / 180;

  /** Run async jobs with a concurrency limit; rejects on first failure. */
  async function pool(jobs, limit, onDone) {
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const i = next++;
        await jobs[i]();
        if (onDone) onDone(++done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  }

  function checkAbort(signal) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  }

  // ---- AWS Terrarium -------------------------------------------------------------------------

  /** Decode a Terrarium pixel: metres = R*256 + G + B/256 - 32768. */
  function terrariumMetres(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  async function fetchTerrarium(bounds, plan, opts) {
    const { signal, onProgress } = opts || {};
    const { z, x0, x1, y0, y1 } = plan.tiles;
    const tw = x1 - x0 + 1, th = y1 - y0 + 1;
    const mosaicW = tw * 256, mosaicH = th * 256;
    const mosaic = new Float32Array(mosaicW * mosaicH);
    mosaic.fill(NaN);

    const jobs = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        jobs.push(async () => {
          checkAbort(signal);
          const res = await fetch(TERRARIUM_URL(z, tx, ty), { signal });
          if (!res.ok) throw new Error('Terrarium tile ' + z + '/' + tx + '/' + ty + ' failed: HTTP ' + res.status);
          // premultiplyAlpha/colorSpaceConversion off: the RGB channels carry data, not colour.
          const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
          const c = new OffscreenCanvas(256, 256);
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          const px = ctx.getImageData(0, 0, 256, 256).data;
          const ox = (tx - x0) * 256, oy = (ty - y0) * 256;
          for (let row = 0; row < 256; row++) {
            const dst = (oy + row) * mosaicW + ox;
            for (let col = 0; col < 256; col++) {
              const i = (row * 256 + col) * 4;
              mosaic[dst + col] = terrariumMetres(px[i], px[i + 1], px[i + 2]);
            }
          }
        });
      }
    }
    await pool(jobs, CONCURRENCY, (d, n) => onProgress && onProgress(d / n, 'Terrarium tiles ' + d + '/' + n));
    checkAbort(signal);

    // Resample mosaic (Web Mercator pixels, y-down) into the ground-correct lon/lat grid with Catmull-Rom bicubic.
    // Bilinear would leave visible creases along the source pixel grid when upscaling; the result here is clamped to the
    // range of the 16 samples used, so the filter's slight overshoot can never create a false peak or pit.
    const { width: W, height: H } = plan.grid;
    const out = new Float32Array(W * H);
    const ox = x0 * 256, oy = y0 * 256;
    const wx = new Float64Array(4), wy = new Float64Array(4);
    const cr = (t, w) => {            // Catmull-Rom weights for fractional position t
      const t2 = t * t, t3 = t2 * t;
      w[0] = -0.5 * t3 + t2 - 0.5 * t; w[1] = 1.5 * t3 - 2.5 * t2 + 1; w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t; w[3] = 0.5 * t3 - 0.5 * t2;
    };
    const clampI = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    for (let j = 0; j < H; j++) {
      const lat = bounds.north - ((j + 0.5) / H) * (bounds.north - bounds.south);
      const my = Geo.latToTileY(lat, z) * 256 - oy - 0.5;             // fractional mosaic row (pixel centres at k)
      const r1 = Math.floor(my);
      cr(my - r1, wy);
      for (let i = 0; i < W; i++) {
        const lon = bounds.west + ((i + 0.5) / W) * (bounds.east - bounds.west);
        const mx = Geo.lonToTileX(lon, z) * 256 - ox - 0.5;
        const c1 = Math.floor(mx);
        cr(mx - c1, wx);
        let acc = 0, lo = Infinity, hi = -Infinity;
        for (let dj = 0; dj < 4; dj++) {
          const row = clampI(r1 - 1 + dj, mosaicH - 1) * mosaicW;
          for (let di = 0; di < 4; di++) {
            const v = mosaic[row + clampI(c1 - 1 + di, mosaicW - 1)];
            acc += v * wx[di] * wy[dj];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        out[j * W + i] = acc < lo ? lo : acc > hi ? hi : acc;
      }
    }
    return { data: out, width: W, height: H, bounds, sourceLabel: plan.label };
  }

  // ---- USGS 3DEP -----------------------------------------------------------------------------

  /** Split the output grid into chunks of at most DEP_CHUNK_PX per side. */
  function depChunks(grid) {
    const chunks = [];
    for (let y = 0; y < grid.height; y += DEP_CHUNK_PX) {
      for (let x = 0; x < grid.width; x += DEP_CHUNK_PX) {
        chunks.push({ x, y, w: Math.min(DEP_CHUNK_PX, grid.width - x), h: Math.min(DEP_CHUNK_PX, grid.height - y) });
      }
    }
    return chunks;
  }

  function depUrl(bbox, w, h, interpolation) {
    const p = new URLSearchParams({
      bbox: [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
      bboxSR: '4326', imageSR: '4326',
      size: w + ',' + h,
      format: 'tiff', pixelType: 'F32',
      // Cubic when the output is finer than the source: smoother than bilinear, no visible grid-aligned creases.
      interpolation: interpolation === 'cubic' ? 'RSP_CubicConvolution' : 'RSP_BilinearInterpolation',
      f: 'image',
    });
    return DEP_URL + '?' + p.toString();
  }

  /** Parse a float32 GeoTIFF; returns Float32Array (w*h) with nodata -> NaN. */
  async function parseDepTiff(buf, w, h) {
    const tiff = await root.GeoTIFF.fromArrayBuffer(buf);
    const img = await tiff.getImage();
    if (img.getWidth() !== w || img.getHeight() !== h) {
      throw new Error('3DEP returned ' + img.getWidth() + '×' + img.getHeight() + ', expected ' + w + '×' + h);
    }
    const rasters = await img.readRasters({ samples: [0] });
    const src = rasters[0];
    const nd = img.getGDALNoData();
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      out[i] = (!Number.isFinite(v) || (nd !== null && v === nd) || v < -9000 || v > 9000) ? NaN : v;
    }
    return out;
  }

  async function fetch3dep(bounds, plan, opts) {
    const { signal, onProgress } = opts || {};
    const { width: W, height: H } = plan.grid;
    const out = new Float32Array(W * H);
    const dLon = (bounds.east - bounds.west) / W, dLat = (bounds.north - bounds.south) / H;

    const jobs = depChunks(plan.grid).map((c) => async () => {
      checkAbort(signal);
      // The chunk's own bbox is a rectangle of whole output pixels, so the server resamples straight onto our grid.
      const bbox = {
        west: bounds.west + c.x * dLon, east: bounds.west + (c.x + c.w) * dLon,
        north: bounds.north - c.y * dLat, south: bounds.north - (c.y + c.h) * dLat,
      };
      const res = await fetch(depUrl(bbox, c.w, c.h, plan.interpolation), { signal });
      if (!res.ok) throw new Error('3DEP request failed: HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const isTiff = head.length >= 4 && ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 42) || (head[0] === 0x4d && head[1] === 0x4d && head[3] === 42));
      if (!isTiff) {
        // ArcGIS reports errors as 200 + JSON/HTML, so the status code alone isn't enough.
        throw new Error('3DEP did not return a TIFF: ' + new TextDecoder().decode(buf.slice(0, 200)));
      }
      const px = await parseDepTiff(buf, c.w, c.h);
      for (let row = 0; row < c.h; row++) out.set(px.subarray(row * c.w, (row + 1) * c.w), (c.y + row) * W + c.x);
    });
    await pool(jobs, CONCURRENCY, (d, n) => onProgress && onProgress(d / n, '3DEP requests ' + d + '/' + n));
    checkAbort(signal);
    return { data: out, width: W, height: H, bounds, sourceLabel: plan.label };
  }

  // ---- shared --------------------------------------------------------------------------------

  /** Min/max over finite samples and the count of no-data samples. */
  function stats(data) {
    let min = Infinity, max = -Infinity, nodata = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (v !== v) { nodata++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min, max, nodata };
  }

  /**
   * Fetch for a plan. In 'auto' mode a failed 3DEP fetch falls back to Terrarium; an explicit
   * choice never silently switches source. Returns the result plus { note } describing any fallback.
   */
  async function fetchElevation(bounds, pref, opts) {
    const spec = opts && opts.spec;
    const plan = Geo.planSource(bounds, pref, spec);
    if (plan.tooLarge || Geo.overCap(plan.grid)) throw new Error('Region exceeds the size cap.');
    let result, note = null;
    try {
      result = plan.id === '3dep' ? await fetch3dep(bounds, plan, opts) : await fetchTerrarium(bounds, plan, opts);
    } catch (err) {
      if (err.name === 'AbortError' || pref !== 'auto' || plan.id !== '3dep') throw err;
      note = '3DEP failed (' + err.message + '); used AWS Terrain Tiles instead.';
      const alt = Geo.planSource(bounds, 'terrarium', spec);
      if (alt.tooLarge || Geo.overCap(alt.grid)) throw err;
      result = await fetchTerrarium(bounds, alt, opts);
    }
    const s = stats(result.data);
    if (s.nodata === result.data.length) throw new Error('No elevation data returned for this region.');
    return Object.assign(result, s, { note });
  }

  const api = { fetchElevation, fetchTerrarium, fetch3dep, depChunks, depUrl, parseDepTiff, terrariumMetres, stats };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCSources = api;
})(typeof self !== 'undefined' ? self : this);
