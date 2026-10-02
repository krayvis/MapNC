/* MapNC phase 1: map, rectangle selection, source auto-detect readout. */
(function () {
  'use strict';
  const Geo = window.MapNCGeo;

  const $ = (id) => document.getElementById(id);
  const mapEl = $('map');
  const drawBtn = $('draw-btn');
  const clearBtn = $('clear-btn');

  const map = L.map('map', { worldCopyJump: true }).setView([39.5, -98.35], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  window.MapNC = { map, get elevation() { return elevation; }, get grey() { return grey; }, region: () => bounds }; // handle for debugging and automated tests

  // The selection, always stored as normalized bounds (south/west/north/east).
  let bounds = null;
  let rect = null;
  let handles = [];

  function updateCapText() {
    $('cap-text').textContent = Geo.LIMITS.maxSide + ' px per side, ' + (Geo.LIMITS.maxSamples / 1e6).toFixed(1) +
      ' M samples. A full-size fetch needs roughly ' + Math.round(Geo.memoryEstimateMB({ width: Geo.LIMITS.maxSide, height: Geo.LIMITS.maxSide })) + ' MB of browser memory.';
  }
  updateCapText();
  $('cap-select').addEventListener('change', () => {
    Geo.setMaxSide(Number($('cap-select').value));
    updateCapText();
    refresh();
  });

  // ---- drawing -----------------------------------------------------------------------------

  let drawing = false;
  let activePointer = null;
  let anchor = null;

  function setDrawing(on) {
    drawing = on;
    drawBtn.classList.toggle('on', on);
    drawBtn.textContent = on ? 'Drag on the map…' : (bounds ? 'Redraw rectangle' : 'Draw rectangle');
    mapEl.classList.toggle('drawing', on);
    if (on) map.dragging.disable(); else map.dragging.enable();
  }

  drawBtn.addEventListener('click', () => setDrawing(!drawing));
  clearBtn.addEventListener('click', clearSelection);

  mapEl.addEventListener('pointerdown', (e) => {
    if (!drawing || activePointer !== null || e.button > 0) return;
    activePointer = e.pointerId;
    mapEl.setPointerCapture(e.pointerId);
    anchor = map.mouseEventToLatLng(e);
    setBounds(Geo.normalizeBounds(anchor, anchor));
    e.preventDefault();
  });

  mapEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer) return;
    setBounds(Geo.normalizeBounds(anchor, map.mouseEventToLatLng(e)));
  });

  function endDrag(e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    anchor = null;
    if (bounds && (bounds.north - bounds.south < 1e-6 || bounds.east - bounds.west < 1e-6)) clearSelection(); // a click, not a drag
    setDrawing(false);
  }
  mapEl.addEventListener('pointerup', endDrag);
  mapEl.addEventListener('pointercancel', endDrag);

  // ---- selection state ---------------------------------------------------------------------

  function clearSelection() {
    bounds = null;
    if (rect) { rect.remove(); rect = null; }
    handles.forEach((h) => h.remove());
    handles = [];
    clearBtn.disabled = true;
    drawBtn.textContent = 'Draw rectangle';
    $('region-info').hidden = true;
    $('source-info').hidden = true;
    $('cap-warning').hidden = true;
    $('draw-hint').hidden = false;
    $('fetch-btn').disabled = true;
    resetResult();
  }

  function setBounds(b) {
    bounds = b;
    const ll = [[b.south, b.west], [b.north, b.east]];
    if (!rect) rect = L.rectangle(ll, { weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
    else rect.setBounds(ll);
    syncHandles();
    resetResult(); // the old result no longer matches the rectangle
    clearBtn.disabled = false;
    $('draw-hint').hidden = true;
    refresh();
  }

  // Corner handles: dragging one moves that corner and keeps the opposite one fixed.
  function cornerLatLngs() {
    return [
      { key: 'sw', ll: L.latLng(bounds.south, bounds.west), opp: 'ne' },
      { key: 'se', ll: L.latLng(bounds.south, bounds.east), opp: 'nw' },
      { key: 'ne', ll: L.latLng(bounds.north, bounds.east), opp: 'sw' },
      { key: 'nw', ll: L.latLng(bounds.north, bounds.west), opp: 'se' },
    ];
  }

  function syncHandles() {
    const corners = cornerLatLngs();
    if (handles.length === 0) {
      handles = corners.map((c) => {
        const m = L.marker(c.ll, {
          draggable: true,
          icon: L.divIcon({ className: '', html: '<div class="corner-handle"></div>', iconSize: [0, 0] }),
        }).addTo(map);
        m._corner = c;
        m.on('drag', () => {
          const opposite = cornerLatLngs().find((x) => x.key === m._corner.opp).ll;
          setBounds(Geo.normalizeBounds(m.getLatLng(), opposite));
        });
        return m;
      });
    }
    // Reposition every handle except the one being dragged (it already sits under the pointer).
    handles.forEach((m) => {
      const target = corners.find((c) => c.key === m._corner.key);
      m._corner.opp = target.opp;
      if (!m.dragging || !m.dragging._draggable || !m.dragging._draggable._moving) m.setLatLng(target.ll);
    });
  }

  // ---- readout -----------------------------------------------------------------------------

  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(0) + ' m');
  const fmtDeg = (ll) => Math.abs(ll.lat).toFixed(4) + (ll.lat < 0 ? 'S ' : 'N ') + Math.abs(ll.lng).toFixed(4) + (ll.lng < 0 ? 'W' : 'E');

  function refresh() {
    if (!bounds) return;
    const g = Geo.groundSize(bounds);
    const plan = Geo.planSource(bounds, $('source-select').value);
    const tooBig = plan.tooLarge || Geo.overCap(plan.grid);

    $('region-info').hidden = false;
    $('source-info').hidden = false;
    $('info-size').textContent = fmtKm(g.widthM) + ' × ' + fmtKm(g.heightM);
    $('info-corners').textContent = fmtDeg({ lat: bounds.north, lng: bounds.west }) + ' to ' + fmtDeg({ lat: bounds.south, lng: bounds.east });
    $('info-grid').textContent = plan.tooLarge ? '–' : plan.grid.width + ' × ' + plan.grid.height + ' px';
    $('info-source').textContent = plan.label + (plan.id === '3dep' && !plan.region ? ' (outside US coverage)' : '');
    $('info-res').textContent = plan.resolutionNote;
    const coarse = !tooBig && plan.resolutionM > 100;

    const warn = $('cap-warning');
    warn.hidden = !tooBig && !coarse;
    if (coarse) {
      warn.textContent = 'Large region: resolution drops to about ' + plan.resolutionM.toFixed(0) +
        ' m per pixel, so fine terrain detail will be lost. Draw a smaller rectangle for more detail.';
    } else if (tooBig) {
      warn.textContent = plan.tooLarge
        ? 'Region is too large for any source. Draw a smaller rectangle.'
        : 'Output would be ' + plan.grid.width + ' × ' + plan.grid.height + ' px, over the ' +
          Geo.LIMITS.maxSide + ' px cap. Draw a smaller rectangle.';
    }
    rect.setStyle({ color: tooBig ? '#d92d20' : '#2563eb' });
    $('fetch-btn').disabled = tooBig || fetching;
  }

  // ---- route track ------------------------------------------------------------------------

  const Track = window.MapNCTrack;
  let track = null;        // parsed track: { name, segments }
  let trackLayer = null;   // Leaflet polyline group
  let widthTouched = false; // true once the user edits the line width, so a re-fit won't overwrite it

  function trackError(msg) { $('track-error').textContent = msg; $('track-error').hidden = !msg; }

  function showTrack() {
    if (trackLayer) trackLayer.remove();
    trackLayer = L.polyline(track.segments.map((seg) => seg.map((p) => [p.lat, p.lon])), { color: '#e11d48', weight: 3, interactive: false }).addTo(map);
    const pts = track.segments.reduce((n, s) => n + s.length, 0);
    $('track-info').textContent = (track.name ? track.name + ': ' : '') + Track.trackLengthKm(track).toFixed(1) + ' km, ' +
      pts + ' points' + (track.segments.length > 1 ? ' in ' + track.segments.length + ' segments' : '') + '.';
    $('track-info').hidden = false;
    $('track-fit').hidden = false;
    $('track-clear').hidden = false;
    $('route-controls').hidden = false;
    $('export-route-btn').hidden = false;
    $('route-layer-hint').hidden = false;
  }

  function fitToTrack() {
    const margin = Math.max(0, parseFloat($('track-margin').value) || 0) / 100;
    const b = Track.padBounds(Track.trackBounds(track), margin);
    setBounds(b);
    map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [30, 30] });
    if (!widthTouched) {
      // Default line width: about 0.8 % of the longer side of the region, 2 significant figures.
      const g = Geo.groundSize(b), w = Math.max(g.widthM, g.heightM) * 0.008;
      $('route-width').value = Number(w.toPrecision(2));
    }
  }

  $('track-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    trackError('');
    try {
      track = Track.parseTrackText(await f.text(), f.name);
    } catch (err) {
      trackError(err.message);
      return;
    }
    widthTouched = false;
    showTrack();
    fitToTrack();
  });

  $('track-fit').addEventListener('click', () => track && fitToTrack());
  $('track-clear').addEventListener('click', () => {
    track = null;
    if (trackLayer) { trackLayer.remove(); trackLayer = null; }
    $('track-file').value = '';
    ['track-info', 'track-fit', 'track-clear', 'route-controls', 'export-route-btn', 'route-layer-hint'].forEach((id) => { $(id).hidden = true; });
    trackError('');
    if (elevation) recompute();
  });

  // ---- fetch + preview ---------------------------------------------------------------------

  let fetching = false;
  let controller = null;
  let elevation = null;   // last result from MapNCSources.fetchElevation

  function resetResult() {
    elevation = null;
    $('result-info').hidden = true;
    $('hm-section').hidden = true;
    grey = null;
    $('fetch-error').hidden = true;
    $('status').textContent = '';
  }

  // ---- heightmap controls ------------------------------------------------------------------

  const HM = window.MapNCHeightmap;
  let grey = null;        // last toGrey() result
  let recomputeTimer = null;

  function currentParams() {
    const mode = document.querySelector('input[name="range-mode"]:checked').value;
    return {
      stats: { min: elevation.min, max: elevation.max },
      rangeMode: mode,
      manualLo: parseFloat($('range-lo').value),
      manualHi: parseFloat($('range-hi').value),
      exaggeration: parseFloat($('exaggeration').value),
      bits: Number($('bits-select').value),
      invert: $('invert').checked,
      route: routeBurn(),
    };
  }

  // ---- route rasterizing -------------------------------------------------------------------

  let routeCache = null;   // { elev, key, weight }: the route weights depend only on grid, width and profile

  /** Ground size of one output pixel in metres (mean of the two axes; they match to well under 1 %). */
  function pixelMetres() {
    const g = Geo.groundSize(elevation.bounds);
    return (g.widthM / elevation.width + g.heightM / elevation.height) / 2;
  }

  function routeRadiusPx() {
    const widthM = parseFloat($('route-width').value);
    return Number.isFinite(widthM) && widthM > 0 ? widthM / 2 / pixelMetres() : 0;
  }

  function routeWeights(shape) {
    const r = routeRadiusPx();
    const key = shape + '|' + r.toFixed(3);
    if (!routeCache || routeCache.elev !== elevation || routeCache.key !== key) {
      routeCache = { elev: elevation, key, weight: Track.rasterize(track, elevation.bounds, elevation.width, elevation.height, r, shape) };
    }
    return routeCache.weight;
  }

  /** The { weight, fraction } the heightmap mapping needs, or null when there is nothing to burn. */
  function routeBurn() {
    if (!track || !elevation || !$('route-burn').checked) return null;
    const pct = parseFloat($('route-amount').value);
    if (!Number.isFinite(pct) || pct === 0 || routeRadiusPx() <= 0) return null;
    return { weight: routeWeights($('route-shape').value), fraction: pct / 100 };
  }

  function updateRouteReadout() {
    if (!track || !elevation) return;
    const r = routeRadiusPx(), widthPx = Math.max(2 * r, 1.5);
    $('route-px').textContent = r > 0 ? widthPx.toFixed(1) + ' px (' + (widthPx * pixelMetres()).toFixed(0) + ' m)' : '–';
    const pct = parseFloat($('route-amount').value) || 0;
    const metres = Math.abs(pct / 100) * (grey.hi - grey.lo) / grey.k;
    $('route-depth').textContent = pct === 0 ? 'none' : (pct < 0 ? 'cuts ' : 'raises ') +
      (metres >= 1 ? metres.toFixed(1) + ' m' : (metres * 1000).toFixed(0) + ' mm') + ' of terrain, ' +
      Math.round(Math.abs(pct) / 100 * grey.maxVal) + ' grey levels';
    const msgs = [];
    if (r > 0 && widthPx < 3) msgs.push('The line is only about ' + widthPx.toFixed(1) + ' px wide and may be lost when carved. Widen it, or use a smaller region for more pixels.');
    const b = elevation.bounds;
    const outside = track.segments.some((seg) => seg.some((p) => p.lat < b.south || p.lat > b.north || p.lon < b.west || p.lon > b.east));
    if (outside) msgs.push('Part of the route lies outside the selected region and is cut off.');
    $('route-warning').textContent = msgs.join(' ');
    $('route-warning').hidden = msgs.length === 0;
  }

  function recompute() {
    if (!elevation) return;
    grey = HM.toGrey(elevation.data, currentParams());
    const total = elevation.data.length - grey.nodata;
    $('hm-window').textContent = grey.lo.toFixed(1) + ' to ' + grey.hi.toFixed(1) + ' m' + (grey.k !== 1 ? ' (×' + grey.k + ')' : '');
    $('hm-level').textContent = grey.metresPerLevel < 0.01
      ? (grey.metresPerLevel * 1000).toFixed(2) + ' mm (' + (grey.maxVal + 1) + ' levels)'
      : grey.metresPerLevel.toFixed(3) + ' m (' + (grey.maxVal + 1) + ' levels)';
    const clip = grey.clippedHigh + grey.clippedLow;
    $('hm-clip').textContent = clip ? (100 * clip / total).toFixed(1) + '% of samples (' +
      (grey.clippedHigh ? 'above window' : '') + (grey.clippedHigh && grey.clippedLow ? ', ' : '') + (grey.clippedLow ? 'below window' : '') + ')' : 'none';
    $('export-status').textContent = '';
    updateRouteReadout();
    drawPreview();
  }

  function scheduleRecompute() { clearTimeout(recomputeTimer); recomputeTimer = setTimeout(recompute, 120); }

  // 8-bit display only: the export is encoded from `grey.data` at full depth.
  function drawPreview() {
    const e = elevation, c = $('preview');
    c.width = e.width; c.height = e.height;
    const img = new ImageData(e.width, e.height);
    const shift = grey.bits === 16 ? 8 : 0;
    for (let i = 0; i < e.data.length; i++) {
      const o = i * 4;
      if (e.data[i] !== e.data[i]) { img.data[o] = 255; img.data[o + 2] = 255; img.data[o + 3] = 255; continue; } // no data = magenta
      img.data[o] = img.data[o + 1] = img.data[o + 2] = grey.data[i] >> shift; img.data[o + 3] = 255;
    }
    const ctx = c.getContext('2d');
    ctx.putImageData(img, 0, 0);
    if (track && $('route-guide').checked) {
      // Guide line: about 2 screen pixels wide however large the grid is. Not part of any export.
      ctx.strokeStyle = '#e11d48';
      ctx.lineWidth = 2 * e.width / (c.clientWidth || 300);
      ctx.lineJoin = ctx.lineCap = 'round';
      for (const seg of Track.toPixels(track, e.bounds, e.width, e.height)) {
        ctx.beginPath();
        seg.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
    }
  }

  document.querySelectorAll('input[name="range-mode"]').forEach((r) => r.addEventListener('change', () => {
    const manual = document.querySelector('input[name="range-mode"]:checked').value === 'manual';
    $('manual-range').hidden = !manual;
    if (manual && !$('range-lo').value) { $('range-lo').value = Math.floor(elevation.min); $('range-hi').value = Math.ceil(elevation.max); }
    recompute();
  }));
  ['range-lo', 'range-hi', 'exaggeration'].forEach((id) => $(id).addEventListener('input', scheduleRecompute));
  ['bits-select', 'invert', 'route-burn', 'route-shape', 'route-guide'].forEach((id) => $(id).addEventListener('change', recompute));
  $('route-amount').addEventListener('input', scheduleRecompute);
  $('route-width').addEventListener('input', () => { widthTouched = true; scheduleRecompute(); });

  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return name;
  }

  function routeMetadata() {
    if (!track || !routeBurn()) return {};
    return {
      RouteBurned: 'true',
      RouteWidthM: $('route-width').value,
      RouteAmountPct: $('route-amount').value,
      RouteProfile: $('route-shape').value,
    };
  }

  function exportFilename() {
    const b = elevation.bounds, p = (v, pos, neg) => Math.abs(v).toFixed(3) + (v < 0 ? neg : pos);
    return 'mapnc_' + p((b.north + b.south) / 2, 'N', 'S') + '_' + p((b.east + b.west) / 2, 'E', 'W') + '_' +
      elevation.width + 'x' + elevation.height + '_' + grey.bits + 'bit.png';
  }

  $('export-btn').addEventListener('click', async () => {
    if (!elevation || !grey) return;
    $('export-btn').disabled = true;
    $('export-status').textContent = 'Encoding…';
    try {
      const b = elevation.bounds;
      const blob = await HM.encodePng(elevation.width, elevation.height, grey.bits, grey.data, {
        Software: 'MapNC',
        Source: elevation.sourceLabel,
        Bounds: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(','),
        ElevationWindowM: grey.lo.toFixed(3) + ',' + grey.hi.toFixed(3),
        Exaggeration: String(grey.k),
        MetresPerGreyLevel: grey.metresPerLevel.toPrecision(5),
        Inverted: String($('invert').checked),
        ...routeMetadata(),
      });
      $('export-status').textContent = 'Saved ' + saveBlob(blob, exportFilename()) + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).';
    } catch (err) {
      $('export-status').textContent = 'Export failed: ' + err.message;
    } finally {
      $('export-btn').disabled = false;
    }
  });

  // Transparent RGBA layer: red line, flat profile, alpha = coverage. Same pixel grid as the heightmap.
  $('export-route-btn').addEventListener('click', async () => {
    if (!elevation || !track) return;
    const btn = $('export-route-btn');
    btn.disabled = true;
    $('export-status').textContent = 'Encoding route layer…';
    try {
      const { width: W, height: H, bounds: b } = elevation;
      const cover = Track.rasterize(track, b, W, H, routeRadiusPx(), 'uniform');
      const rgba = new Uint8Array(W * H * 4);
      for (let i = 0; i < cover.length; i++) {
        rgba[i * 4] = 225; rgba[i * 4 + 1] = 29; rgba[i * 4 + 2] = 72;
        rgba[i * 4 + 3] = Math.round(cover[i] * 255);
      }
      const blob = await HM.encodePng(W, H, 8, rgba, {
        Software: 'MapNC',
        Bounds: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(','),
        RouteWidthM: $('route-width').value,
      }, 4);
      $('export-status').textContent = 'Saved ' + saveBlob(blob, exportFilename().replace(/_(8|16)bit\.png$/, '_route.png')) +
        ' (' + (blob.size / 1048576).toFixed(2) + ' MB).';
    } catch (err) {
      $('export-status').textContent = 'Export failed: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function setFetching(on) {
    fetching = on;
    $('fetch-btn').disabled = on;
    $('cancel-btn').hidden = !on;
    $('progress').hidden = !on;
    drawBtn.disabled = on;
    $('source-select').disabled = on;
  }

  $('cancel-btn').addEventListener('click', () => controller && controller.abort());

  $('fetch-btn').addEventListener('click', async () => {
    if (!bounds || fetching) return;
    resetResult();
    setFetching(true);
    controller = new AbortController();
    const fetchedBounds = Object.assign({}, bounds);
    try {
      const e = await window.MapNCSources.fetchElevation(fetchedBounds, $('source-select').value, {
        signal: controller.signal,
        onProgress: (f, msg) => { $('progress').value = f; $('status').textContent = msg; },
      });
      elevation = e;
      $('status').textContent = e.sourceLabel + (e.note ? ' — ' + e.note : '');
      $('res-range').textContent = e.min.toFixed(1) + ' to ' + e.max.toFixed(1) + ' m (' + (e.max - e.min).toFixed(1) + ' m range)';
      $('res-nodata').textContent = e.nodata ? (100 * e.nodata / e.data.length).toFixed(1) + '% (magenta in preview)' : 'none';
      $('result-info').hidden = false;
      $('hm-section').hidden = false;
      recompute();
    } catch (err) {
      if (err.name === 'AbortError') $('status').textContent = 'Cancelled.';
      else { $('fetch-error').textContent = err.message; $('fetch-error').hidden = false; $('status').textContent = ''; }
    } finally {
      setFetching(false);
      controller = null;
      refresh();
    }
  });

  $('source-select').addEventListener('change', () => { resetResult(); refresh(); });
})();
