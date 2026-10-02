/* MapNC phase 1: map, rectangle selection, source auto-detect readout. */
(function () {
  'use strict';
  const Geo = window.MapNCGeo;

  const $ = (id) => document.getElementById(id);
  const mapEl = $('map');
  const drawBtn = $('draw-btn');
  const clearBtn = $('clear-btn');

  // Shift+drag is Leaflet's box-zoom gesture, and its Draggable refuses any drag that starts with Shift held. This app
  // uses Shift (like Ctrl/Cmd/Alt) to resize a rectangle from its centre, so box-zoom is off and marker handles are
  // allowed to start a drag with Shift down. (Leaflet is vendored at a fixed version, so patching this one check is safe.)
  const origOnDown = L.Draggable.prototype._onDown;
  L.Draggable.prototype._onDown = function (e) {
    if (!e.shiftKey || !this._element || !this._element.classList.contains('leaflet-marker-icon')) return origOnDown.call(this, e);
    return origOnDown.call(this, new Proxy(e, {
      get: (t, k) => { if (k === 'shiftKey') return false; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; },
    }));
  };
  const map = L.map('map', { worldCopyJump: true, boxZoom: false }).setView([39.5, -98.35], 4);

  // Base maps. className marks which ones the dark-mode filter may invert: it suits drawn maps, but would wreck photos.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const baseLayers = {
    'Street (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'tiles-map', attribution: OSM_ATTR,
    }),
    'Topographic (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, subdomains: 'abc', className: 'tiles-map',
      attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    }),
    'Satellite (Esri World Imagery)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, className: 'tiles-photo',
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }),
    'USGS Topo (US only)': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, className: 'tiles-map',
      attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>',
    }),
  };
  let baseName = 'Street (OpenStreetMap)';
  try { const saved = localStorage.getItem('mapnc-basemap'); if (saved && baseLayers[saved]) baseName = saved; } catch (e) { /* storage unavailable: default map */ }
  baseLayers[baseName].addTo(map);
  L.control.layers(baseLayers, null, { collapsed: true, position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem('mapnc-basemap', e.name); } catch (err) { /* ignore */ } });
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
    scheduleAutoFetch();
  });

  // Holding Shift, Ctrl, Cmd or Alt/Option while dragging makes the rectangle resize from its centre (mouse only: touch has no keys).
  let centreMod = false;
  let redoCornerDrag = null;       // set while a corner drag is active; re-runs it when the key state changes
  function setCentreMod(v) {
    if (v === centreMod) return;
    centreMod = v;
    if (redoCornerDrag) redoCornerDrag();
    else if (activePointer !== null && anchor && lastDrawPoint) redrawFromPointer();
  }
  const modOf = (e) => !!(e.shiftKey || e.ctrlKey || e.metaKey || e.altKey);
  ['keydown', 'keyup'].forEach((t) => document.addEventListener(t, (e) => setCentreMod(modOf(e))));
  ['pointermove', 'mousemove'].forEach((t) => document.addEventListener(t, (e) => setCentreMod(modOf(e)), true));
  window.addEventListener('blur', () => setCentreMod(false));   // a key released outside the window never fires keyup

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
    beginInteract();
    mapEl.setPointerCapture(e.pointerId);
    anchor = map.mouseEventToLatLng(e);
    lastDrawPoint = anchor;
    setBounds(Geo.normalizeBounds(anchor, anchor));
    e.preventDefault();
  });

  let lastDrawPoint = null;
  function redrawFromPointer() {
    // With the modifier held the press point is the rectangle's centre; otherwise it is a fixed corner.
    if (centreMod) setBounds(Geo.centredBounds(anchor, lastDrawPoint, ratio));
    else setBounds(Geo.normalizeBounds(anchor, ratio ? Geo.constrainCorner(anchor, lastDrawPoint, ratio) : lastDrawPoint));
  }
  mapEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer) return;
    lastDrawPoint = map.mouseEventToLatLng(e);
    redrawFromPointer();
  });

  function endDrag(e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    anchor = null;
    if (bounds && (bounds.north - bounds.south < 1e-6 || bounds.east - bounds.west < 1e-6)) clearSelection(); // a click, not a drag
    setDrawing(false);
    endInteract();
  }
  mapEl.addEventListener('pointerup', endDrag);
  mapEl.addEventListener('pointercancel', endDrag);

  // ---- selection state ---------------------------------------------------------------------

  function clearSelection() {
    bounds = null;
    if (rect) { rect.remove(); rect = null; }
    handles.forEach((h) => h.remove());
    handles = [];
    if (moveHandle) { moveHandle.remove(); moveHandle = null; }
    $('edit-hint').hidden = true;
    clearBtn.disabled = true;
    drawBtn.textContent = 'Draw rectangle';
    $('region-info').hidden = true;
    $('source-info').hidden = true;
    $('cap-warning').hidden = true;
    $('draw-hint').hidden = false;
    cancelFetch();
    resetResult();
    scheduleAutoFetch();                   // no region: back to the starting message
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
    $('edit-hint').hidden = false;
    refresh();
    scheduleAutoFetch();
  }

  // ---- handles: resize by corner, move by the centre handle ----------------------------------

  const OPPOSITE = { sw: 'ne', se: 'nw', ne: 'sw', nw: 'se' };
  const MOVE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
  let moveHandle = null;
  let moveStart = null;    // bounds when a move began: its ground size is kept for the whole drag

  function cornerLatLngs() {
    return [
      { key: 'sw', ll: L.latLng(bounds.south, bounds.west) },
      { key: 'se', ll: L.latLng(bounds.south, bounds.east) },
      { key: 'ne', ll: L.latLng(bounds.north, bounds.east) },
      { key: 'nw', ll: L.latLng(bounds.north, bounds.west) },
    ];
  }

  const isDragging = (m) => !!(m.dragging && m.dragging._draggable && m.dragging._draggable._moving);

  function createHandles() {
    handles = cornerLatLngs().map((c) => {
      const m = L.marker(c.ll, {
        draggable: true,
        icon: L.divIcon({ className: '', html: '<div class="corner-handle"></div>', iconSize: [0, 0] }),
      }).addTo(map);
      m._key = c.key;
      let fixed = null, centre = null, raw = null;   // opposite corner and centre as they were when the drag began
      const step = () => {
        if (!raw) return;                            // a key was pressed before the first drag movement
        const key0 = (raw.lat >= (centreMod ? centre.lat : fixed.lat) ? 'n' : 's') + (raw.lng >= (centreMod ? centre.lng : fixed.lng) ? 'e' : 'w');
        const next = centreMod
          ? Geo.centredBounds(centre, raw, ratio)
          : Geo.normalizeBounds(fixed, ratio ? Geo.constrainCorner(fixed, raw, ratio) : raw);
        // Dragging past the fixed corner (or centre) flips which corner this handle is: relabel so none collide.
        const others = handles.filter((h) => h !== m);
        const anchorHandle = others.find((h) => h._key === OPPOSITE[m._key]) || others[0];
        const rest = ['sw', 'se', 'ne', 'nw'].filter((k) => k !== key0 && k !== OPPOSITE[key0]);
        m._key = key0;
        anchorHandle._key = OPPOSITE[key0];
        others.filter((h) => h !== anchorHandle).forEach((h, i) => { h._key = rest[i]; });
        const corner = { sw: [next.south, next.west], se: [next.south, next.east], ne: [next.north, next.east], nw: [next.north, next.west] }[key0];
        m.setLatLng(corner);                         // keep the handle on the (constrained / mirrored) corner
        setBounds(next);
      };
      m.on('dragstart', () => {
        fixed = cornerLatLngs().find((x) => x.key === OPPOSITE[m._key]).ll;
        centre = Geo.centreOf(bounds);
        redoCornerDrag = step;
        beginInteract();
      });
      m.on('drag', () => { raw = m.getLatLng(); step(); });
      m.on('dragend', () => { redoCornerDrag = null; endInteract(); });
      return m;
    });

    moveHandle = L.marker(Geo.centreOf(bounds) , {
      draggable: true, zIndexOffset: 500,
      icon: L.divIcon({ className: '', html: '<div class="move-handle" role="button" aria-label="Move rectangle">' + MOVE_ICON + '</div>', iconSize: [0, 0] }),
    }).addTo(map);
    moveHandle.on('dragstart', () => { moveStart = Object.assign({}, bounds); beginInteract(); });
    moveHandle.on('dragend', endInteract);
    moveHandle.on('drag', () => {
      const moved = Geo.moveBounds(moveStart, moveHandle.getLatLng());
      moveHandle.setLatLng(Geo.centreOf(moved));     // stays put if the move was clamped at the latitude limit
      setBounds(moved);
    });
  }

  function syncHandles() {
    if (handles.length === 0) createHandles();
    const corners = cornerLatLngs();
    // Reposition every handle except one being dragged (it already sits under the pointer).
    handles.forEach((m) => { if (!isDragging(m)) m.setLatLng(corners.find((c) => c.key === m._key).ll); });
    if (!isDragging(moveHandle)) moveHandle.setLatLng(Geo.centreOf(bounds));
    updateMoveHandleVisibility();
  }

  // On a very small on-screen rectangle the centre handle would sit on top of the corner handles.
  function updateMoveHandleVisibility() {
    if (!moveHandle || !bounds || !moveHandle.getElement()) return;
    const a = map.latLngToContainerPoint([bounds.north, bounds.west]), b = map.latLngToContainerPoint([bounds.south, bounds.east]);
    moveHandle.getElement().classList.toggle('handle-hidden', Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) < 64);
  }
  map.on('zoomend', updateMoveHandleVisibility);

  // ---- aspect ratio ------------------------------------------------------------------------

  let ratio = null;        // ground width : height to enforce, or null for free

  function readRatio() {
    const v = $('aspect-select').value;
    if (v === 'free') return null;
    if (v === 'custom') return Geo.parseRatio($('aspect-w').value, $('aspect-h').value);
    const [w, h] = v.split(':');
    return Geo.parseRatio(w, h);
  }

  function setCustom(w, h) {
    $('aspect-select').value = 'custom';
    $('aspect-w').value = w;
    $('aspect-h').value = h;
    $('aspect-custom').hidden = false;
  }

  // Changing the ratio keeps the rectangle's ground area and centre: same size, new shape.
  function applyRatio() {
    ratio = readRatio();
    $('aspect-swap').disabled = ratio === null;
    if (ratio && bounds) setBounds(Geo.reshapeBounds(bounds, ratio, 'area'));
  }

  $('aspect-select').addEventListener('change', () => {
    if ($('aspect-select').value === 'current') {
      if (!bounds) { $('aspect-select').value = 'free'; return; }
      setCustom(Number(Geo.groundRatio(bounds).toFixed(3)), 1);   // freeze the present shape as a custom ratio
    }
    $('aspect-custom').hidden = $('aspect-select').value !== 'custom';
    applyRatio();
  });
  ['aspect-w', 'aspect-h'].forEach((id) => $(id).addEventListener('change', applyRatio));

  $('aspect-swap').addEventListener('click', () => {
    if (ratio === null) return;
    const v = $('aspect-select').value;
    if (v === 'custom') setCustom($('aspect-h').value, $('aspect-w').value);
    else { const [w, h] = v.split(':'); setCustom(h, w); }
    applyRatio();
  });

  // ---- output resolution + carve size ------------------------------------------------------

  const RES_DEFAULTS = { scale: { value: 4, label: 'Scale (× finer than the source)' }, pixels: { value: 3000, label: 'Pixels on the long side' }, mpp: { value: 2, label: 'Metres per pixel' } };

  function resSpec() {
    const mode = $('res-mode').value;
    return { mode, value: parseFloat($('res-value').value) };
  }

  $('res-mode').addEventListener('change', () => {
    const mode = $('res-mode').value, d = RES_DEFAULTS[mode];
    $('res-value-wrap').hidden = !d;
    if (d) { $('res-value').value = d.value; $('res-value-label').textContent = d.label; }
    resetResult();
    refresh();
    scheduleAutoFetch();
  });
  $('res-value').addEventListener('input', () => { resetResult(); refresh(); scheduleAutoFetch(); });

  /** Carve length (long side) in mm, or null when not entered. */
  function carveLongMm() {
    const v = parseFloat($('carve-size').value);
    return v > 0 ? v * ($('carve-unit').value === 'in' ? 25.4 : 1) : null;
  }
  ['carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', () => {
    refresh();
    if (elevation && grey) updateRouteReadout();
  }));

  const fmtM = (m) => (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)) + ' m';

  // ---- readout -----------------------------------------------------------------------------

  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(0) + ' m');
  const fmtDeg = (ll) => Math.abs(ll.lat).toFixed(4) + (ll.lat < 0 ? 'S ' : 'N ') + Math.abs(ll.lng).toFixed(4) + (ll.lng < 0 ? 'W' : 'E');

  function refresh() {
    if (!bounds) return;
    const g = Geo.groundSize(bounds);
    const plan = Geo.planSource(bounds, $('source-select').value, resSpec());
    const tooBig = plan.tooLarge || Geo.overCap(plan.grid);

    $('region-info').hidden = false;
    $('source-info').hidden = false;
    $('info-size').textContent = fmtKm(g.widthM) + ' × ' + fmtKm(g.heightM);
    $('info-aspect').textContent = (g.widthM / g.heightM).toFixed(2) + ' : 1' + (ratio ? ' (locked)' : '');
    $('info-corners').textContent = fmtDeg({ lat: bounds.north, lng: bounds.west }) + ' to ' + fmtDeg({ lat: bounds.south, lng: bounds.east });
    $('info-grid').textContent = plan.tooLarge ? '–' : plan.grid.width + ' × ' + plan.grid.height + ' px';
    $('info-source').textContent = plan.label + (plan.id === '3dep' && !plan.region ? ' (outside US coverage)' : '');
    $('info-res').textContent = plan.resolutionNote;
    $('out-info').hidden = !!plan.tooLarge;
    updateRouteExportInfo();
    if (!plan.tooLarge) {
      const f = plan.resolutionM / plan.outputResM;
      $('out-px').textContent = fmtM(plan.outputResM) + ' per pixel' + (f > 1.05 ? ' (' + f.toFixed(1) + '× finer than source)' : f < 0.95 ? ' (coarser than source)' : ' (source resolution)');
      const mm = carveLongMm();
      if (mm) {
        const mmPx = mm / Math.max(plan.grid.width, plan.grid.height);
        $('out-carve').textContent = mmPx.toFixed(3) + ' mm per pixel (' + (25.4 / mmPx).toFixed(0) + ' px/in)';
      } else {
        $('out-carve').textContent = 'enter a carve size above';
      }
    }
    const coarse = !tooBig && plan.outputResM > 100;

    const warn = $('cap-warning');
    warn.hidden = !tooBig && !coarse;
    if (coarse) {
      warn.textContent = 'Large region: resolution drops to about ' + plan.outputResM.toFixed(0) +
        ' m per pixel, so fine terrain detail will be lost. Draw a smaller rectangle for more detail.';
    } else if (tooBig) {
      warn.textContent = plan.tooLarge
        ? 'Region is too large for any source. Draw a smaller rectangle.'
        : 'Output would be ' + plan.grid.width + ' × ' + plan.grid.height + ' px, over the ' +
          Geo.LIMITS.maxSide + ' px cap. Draw a smaller rectangle.';
    }
    rect.setStyle({ color: tooBig ? '#d92d20' : '#2563eb' });
  }

  // ---- route track ------------------------------------------------------------------------

  const Track = window.MapNCTrack;
  let rawTrack = null;     // the track as loaded: { name, segments }
  let track = null;        // the track in use: rawTrack after clean-up (the same object when nothing is enabled)
  let rawLayer = null;     // the original, shown dashed under the cleaned line when clean-up changes it
  let trackVersion = 0;    // bumps whenever `track` changes, so cached route weights are rebuilt
  let trackLayer = null;   // Leaflet polyline group
  let widthTouched = false; // true once the user edits the line width, so a re-fit won't overwrite it

  function trackError(msg) { $('track-error').textContent = msg; $('track-error').hidden = !msg; }

  const ll = (t) => t.segments.map((seg) => seg.map((p) => [p.lat, p.lon]));

  function trackSummary() {
    const pts = track.segments.reduce((n, s) => n + s.length, 0);
    return (track.name ? track.name + ': ' : '') + Track.trackLengthKm(track).toFixed(1) + ' km, ' +
      pts + ' points' + (track.segments.length > 1 ? ' in ' + track.segments.length + ' segments' : '') + '.';
  }

  function showTrack() {
    if (trackLayer) trackLayer.remove();
    if (rawLayer) { rawLayer.remove(); rawLayer = null; }
    trackLayer = L.polyline(ll(track), { color: '#e11d48', weight: 3, interactive: false }).addTo(map);
    $('track-info').textContent = trackSummary();
    $('track-info').hidden = false;
    $('track-fit').hidden = false;
    $('track-clear').hidden = false;
    $('route-controls').hidden = false;
    $('route-export').hidden = false;
    $('pane-clean').hidden = false;
    updateRouteExportInfo();
  }

  // ---- route clean-up ----------------------------------------------------------------------

  const num = (id) => Math.max(0, parseFloat($(id).value) || 0);
  const cleanOpts = () => ({
    spikeM: $('clean-spikes').checked ? num('clean-spike-m') : 0,
    spacingM: num('clean-spacing'), smoothM: num('clean-smooth'), simplifyM: num('clean-simplify'),
  });

  function applyClean() {
    if (!rawTrack) return;
    let result;
    try { result = Track.cleanTrack(rawTrack, cleanOpts()); } catch (err) { trackError('Clean-up failed: ' + err.message); return; }
    track = result.track;
    trackVersion++;
    const st = result.stats;
    trackLayer.setLatLngs(ll(track));
    if (st.changed) {
      if (!rawLayer) rawLayer = L.polyline(ll(rawTrack), { color: '#7b8794', weight: 2, dashArray: '4 5', opacity: .9, interactive: false }).addTo(map);
      trackLayer.bringToFront();
    } else if (rawLayer) { rawLayer.remove(); rawLayer = null; }
    $('clean-points').textContent = st.changed ? st.pointsBefore + ' → ' + st.pointsAfter : st.pointsBefore + ' (unchanged)';
    $('clean-length').textContent = st.changed ? st.lengthBeforeKm.toFixed(2) + ' → ' + st.lengthAfterKm.toFixed(2) + ' km' : st.lengthBeforeKm.toFixed(2) + ' km';
    $('clean-shift').textContent = st.changed ? (st.maxShiftM < 10 ? st.maxShiftM.toFixed(1) : st.maxShiftM.toFixed(0)) + ' m from the original' : '–';
    $('clean-spikes-n').textContent = $('clean-spikes').checked ? String(st.spikes) : '–';
    $('track-info').textContent = trackSummary();
    if (elevation) recompute();      // the route in the heightmap follows the cleaned line
  }

  let cleanTimer = null;
  const scheduleClean = () => { clearTimeout(cleanTimer); cleanTimer = setTimeout(applyClean, 150); };
  ['clean-spikes', 'clean-spike-m', 'clean-spacing', 'clean-smooth', 'clean-simplify'].forEach((id) => $(id).addEventListener('input', scheduleClean));
  function setCleanInputs(spikes, spacing, smooth, simplify) {
    $('clean-spikes').checked = spikes > 0;
    $('clean-spike-m').value = spikes > 0 ? spikes : 20;
    $('clean-spacing').value = spacing; $('clean-smooth').value = smooth; $('clean-simplify').value = simplify;
  }
  $('clean-suggest').addEventListener('click', () => { setCleanInputs(20, 3, 5, 2); applyClean(); });
  $('clean-reset').addEventListener('click', () => { setCleanInputs(0, 0, 0, 0); applyClean(); });

  function fitToTrack() {
    const margin = Math.max(0, parseFloat($('track-margin').value) || 0) / 100;
    let b = Track.padBounds(Track.trackBounds(track), margin);
    if (ratio) b = Geo.reshapeBounds(b, ratio, 'outside');   // grow to the ratio so the route stays inside
    setBounds(b);
    map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [30, 30] });
    if (!widthTouched) {
      // Default line width: about 0.8 % of the longer side of the region, 2 significant figures.
      const g = Geo.groundSize(b), w = Math.max(g.widthM, g.heightM) * 0.008;
      $('route-width').value = Number(w.toPrecision(2));
    }
  }

  function loadTrackText(text, filename) {
    trackError('');
    try {
      rawTrack = Track.parseTrackText(text, filename);
    } catch (err) {
      trackError(err.message);
      return;
    }
    track = rawTrack;
    setCleanInputs(0, 0, 0, 0);
    widthTouched = false;
    showTrack();
    applyClean();
    fitToTrack();
  }

  $('track-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (f) loadTrackText(await f.text(), f.name);
  });

  // Sample route shipped with the site (same origin, so no CORS and nothing leaves the browser).
  async function loadSample(quiet) {
    try {
      const res = await fetch('samples/sierra-buttes-fire-lookout.gpx');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      $('track-file').value = '';
      loadTrackText(await res.text(), 'sierra-buttes-fire-lookout.gpx');
    } catch (err) {
      if (!quiet) trackError('Could not load the sample route: ' + err.message + '. (It needs the page to be served over http, not opened as a file.)');
    }
  }
  $('track-sample').addEventListener('click', () => loadSample(false));

  $('track-fit').addEventListener('click', () => track && fitToTrack());
  $('track-clear').addEventListener('click', () => {
    track = null;
    rawTrack = null;
    trackVersion++;
    if (trackLayer) { trackLayer.remove(); trackLayer = null; }
    if (rawLayer) { rawLayer.remove(); rawLayer = null; }
    $('track-file').value = '';
    ['track-info', 'track-fit', 'track-clear', 'route-controls', 'route-export', 'pane-clean'].forEach((id) => { $(id).hidden = true; });
    trackError('');
    if (elevation) recompute();
  });

  // ---- fetch + preview ---------------------------------------------------------------------

  // Elevation loads by itself once the region, resolution or source stops changing. A change cancels a load in
  // progress. Big outputs (a large download) wait for a click instead of fetching on every tweak.
  const AUTO_FETCH_MAX_SAMPLES = 4.2e6;   // about 2048 x 2048
  const SETTLE_MS = 700;
  let fetching = false;
  let controller = null;       // AbortController of the load in progress; also identifies "the current load"
  let fetchTimer = null;
  let interacting = 0;         // >0 while the user is mid-drag (drawing, resizing or moving): don't load yet
  let elevation = null;        // last result from MapNCSources.fetchElevation

  const setStatus = (t) => { $('status').textContent = t; };
  function setFetchButton(label) {   // null hides it
    $('fetch-btn').hidden = !label;
    if (label) $('fetch-btn').textContent = label;
  }
  function showHeightmap(on) {
    $('hm-section').hidden = !on;
    $('export-section').hidden = !on;
    $('hm-empty').hidden = on;
    $('export-empty').hidden = on;
  }

  function resetResult() {
    elevation = null;
    grey = null;
    $('result-info').hidden = true;
    $('fetch-error').hidden = true;
    showHeightmap(false);
  }

  function setFetching(on) {
    fetching = on;
    $('progress').hidden = !on;
    $('cancel-btn').hidden = !on;
    if (on) setFetchButton(null);
  }

  function cancelFetch() {
    clearTimeout(fetchTimer);
    fetchTimer = null;
    if (controller) { controller.abort(); controller = null; }
    setFetching(false);
  }

  const currentPlan = () => Geo.planSource(bounds, $('source-select').value, resSpec());

  function sizeNote(plan) {
    const mb = plan.id === '3dep' ? plan.grid.width * plan.grid.height * 4 / 1048576 : (plan.tiles ? plan.tiles.count * 0.1 : 0);
    return plan.grid.width + ' × ' + plan.grid.height + ' px' + (mb ? ', a download of up to ~' + Math.max(1, Math.round(mb)) + ' MB' : '');
  }

  /** Decide what to do about elevation data for the current region: nothing, wait for a click, or load soon. */
  function scheduleAutoFetch() {
    cancelFetch();
    if (!bounds) { setStatus('Draw a region or load a route to begin.'); setFetchButton(null); return; }
    const plan = currentPlan();
    if (plan.tooLarge || Geo.overCap(plan.grid)) {
      setStatus('The output is over the size limit. Make the region smaller, or lower the output size.');
      setFetchButton(null);
      return;
    }
    if (interacting) { setStatus('Waiting for you to finish editing…'); setFetchButton(null); return; }
    if (plan.grid.width * plan.grid.height > AUTO_FETCH_MAX_SAMPLES) {
      setStatus('Large output (' + sizeNote(plan) + '). Load it when you are ready.');
      setFetchButton('Load elevation data');
      return;
    }
    setStatus('Loading elevation shortly…');
    setFetchButton(null);
    fetchTimer = setTimeout(startFetch, SETTLE_MS);
  }

  function beginInteract() { interacting++; cancelFetch(); }
  function endInteract() { interacting = Math.max(0, interacting - 1); if (!interacting) scheduleAutoFetch(); }

  async function startFetch() {
    if (!bounds) return;
    cancelFetch();
    resetResult();
    const plan = currentPlan();
    if (plan.tooLarge || Geo.overCap(plan.grid)) { scheduleAutoFetch(); return; }
    const mine = new AbortController();
    controller = mine;
    setFetching(true);
    $('progress').value = 0;
    setStatus('Loading elevation…');
    try {
      const e = await window.MapNCSources.fetchElevation(Object.assign({}, bounds), $('source-select').value, {
        signal: mine.signal,
        spec: resSpec(),
        onProgress: (f, msg) => { if (controller === mine) { $('progress').value = f; setStatus(msg); } },
      });
      if (controller !== mine) return;           // superseded by a newer region or setting
      controller = null;
      setFetching(false);
      elevation = e;
      setStatus(e.sourceLabel + ' · ' + e.width + ' × ' + e.height + ' px' + (e.note ? ' — ' + e.note : ''));
      $('res-range').textContent = e.min.toFixed(1) + ' to ' + e.max.toFixed(1) + ' m (' + (e.max - e.min).toFixed(1) + ' m range)';
      $('res-nodata').textContent = e.nodata ? (100 * e.nodata / e.data.length).toFixed(1) + '% (magenta in preview)' : 'none';
      $('result-info').hidden = false;
      showHeightmap(true);
      recompute();
    } catch (err) {
      if (controller !== mine) return;
      controller = null;
      setFetching(false);
      if (err.name === 'AbortError') { scheduleAutoFetch(); return; }
      setStatus('Could not load elevation data.');
      $('fetch-error').textContent = err.message;
      $('fetch-error').hidden = false;
      setFetchButton('Retry');
    }
  }

  $('fetch-btn').addEventListener('click', startFetch);
  $('reload-btn').addEventListener('click', startFetch);
  $('cancel-btn').addEventListener('click', () => {
    cancelFetch();
    const plan = bounds && currentPlan();
    setStatus('Stopped.');
    if (plan && !plan.tooLarge) setFetchButton('Load elevation data');
  });

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
    const key = shape + '|' + r.toFixed(3) + '|' + trackVersion;
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
    const mm = carveLongMm(), gs = Geo.groundSize(elevation.bounds);
    const onCarve = mm ? ', about ' + ((widthPx * pixelMetres()) / Math.max(gs.widthM, gs.heightM) * mm).toFixed(2) + ' mm on the carve' : '';
    $('route-px').textContent = r > 0 ? widthPx.toFixed(1) + ' px (' + (widthPx * pixelMetres()).toFixed(0) + ' m' + onCarve + ')' : '–';
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

  /** Pixels per metre of the carve, for the PNG's pHYs chunk (null when no carve size is set). */
  function pixelsPerMetre() {
    const mm = carveLongMm();
    return mm ? Math.max(elevation.width, elevation.height) / (mm / 1000) : null;
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
      }, 1, pixelsPerMetre());
      $('export-status').textContent = 'Saved ' + saveBlob(blob, exportFilename()) + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).';
    } catch (err) {
      $('export-status').textContent = 'Export failed: ' + err.message;
    } finally {
      $('export-btn').disabled = false;
    }
  });

  // ---- route exports: PNG layer (streamed) and vector (SVG / DXF) ----------------------------
  // These need only the region and the route. They are framed exactly like the heightmap: same bounds, and a pixel
  // grid with the same aspect, so everything overlays.

  const LAYER_MIN_PX = 64, LAYER_MAX_PX = 16384;
  const ROUTE_RGB = [225, 29, 72];
  const Vec = window.MapNCVector;

  /** The heightmap's grid: from the loaded data when there is some, otherwise from the plan. null if unknown. */
  function exportGrid() {
    if (!bounds) return null;
    if (elevation) return { bounds: Object.assign({}, elevation.bounds), W: elevation.width, H: elevation.height };
    const plan = currentPlan();
    return plan.tooLarge ? null : { bounds: Object.assign({}, bounds), W: plan.grid.width, H: plan.grid.height };
  }

  /** Size of the route layer PNG, from the size menu. Same framing and aspect as the heightmap. */
  function layerDims() {
    const grid = exportGrid();
    if (!grid) return null;
    const gs = Geo.groundSize(grid.bounds), longM = Math.max(gs.widthM, gs.heightM);
    const sel = $('layer-size').value;
    if (sel !== 'px' && Math.max(grid.W, grid.H) * Number(sel) <= LAYER_MAX_PX) {
      // An exact whole multiple of the heightmap grid, so the two images overlay pixel for pixel.
      const k = Number(sel);
      return { bounds: grid.bounds, W: grid.W * k, H: grid.H * k, pm: longM / (Math.max(grid.W, grid.H) * k), longM, clamped: false };
    }
    const asked = sel === 'px' ? parseInt($('layer-px').value, 10) || 0 : Math.max(grid.W, grid.H) * Number(sel);
    const longPx = Math.max(LAYER_MIN_PX, Math.min(LAYER_MAX_PX, Math.round(asked)));
    const pm = longM / longPx;
    return { bounds: grid.bounds, W: Math.max(1, Math.round(gs.widthM / pm)), H: Math.max(1, Math.round(gs.heightM / pm)), pm, longM, clamped: asked > LAYER_MAX_PX };
  }

  const lineWidthM = () => { const v = parseFloat($('route-width').value); return v > 0 ? v : 10; };

  function updateRouteExportInfo() {
    if (!track) return;
    $('layer-px-wrap').hidden = $('layer-size').value !== 'px';
    const d = layerDims();
    if (!d) { $('layer-info').textContent = 'Draw a region first.'; return; }
    const gb = d.W * d.H * 4 / 1e9;
    $('layer-info').textContent = d.W + ' × ' + d.H + ' px (' + (d.pm >= 1 ? d.pm.toFixed(2) + ' m' : (d.pm * 100).toFixed(d.pm < 0.1 ? 1 : 0) + ' cm') + ' per pixel), line about ' +
      Math.max(1, Math.round(lineWidthM() / d.pm)) + ' px wide.' + (d.clamped ? ' Limited to ' + LAYER_MAX_PX + ' px.' : '') +
      (gb >= 0.25 ? ' Opening it in another program needs about ' + gb.toFixed(1) + ' GB of memory.' : '');
    const mm = carveLongMm();
    $('vec-hint').textContent = mm
      ? 'Units: millimetres of the finished carve (long side ' + mm.toFixed(1) + ' mm). Origin: top-left in the SVG, bottom-left in the DXF. DXF is usually the safer choice for Vectric or Carbide Create; check the size on import.'
      : 'Units: heightmap pixels. Enter a carve size under Output size to export in millimetres.';
  }
  ['layer-size', 'layer-px'].forEach((id) => $(id).addEventListener('input', updateRouteExportInfo));
  $('route-width').addEventListener('input', updateRouteExportInfo);
  ['carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', updateRouteExportInfo));

  function exportBaseName(d) {
    const b = d.bounds, p = (v, pos, neg) => Math.abs(v).toFixed(3) + (v < 0 ? neg : pos);
    return 'mapnc_' + p((b.north + b.south) / 2, 'N', 'S') + '_' + p((b.east + b.west) / 2, 'E', 'W');
  }
  const routeStatus = (t) => { $('route-export-status').textContent = t; };

  let layerBusy = false, layerCancel = false;
  $('export-route-btn').addEventListener('click', async () => {
    const btn = $('export-route-btn');
    if (layerBusy) { layerCancel = true; routeStatus('Cancelling…'); return; }
    const d = layerDims();
    if (!track || !d) return;
    layerBusy = true; layerCancel = false;
    btn.textContent = 'Cancel';
    try {
      const rowsPerBand = Math.max(1, Math.floor(4e6 / d.W));           // about 4 M pixels per strip
      const br = Track.createBandRasterizer(track, d.bounds, d.W, d.H, lineWidthM() / 2 / d.pm, 'uniform', rowsPerBand);
      const cover = new Float32Array(d.W * rowsPerBand), rgba = new Uint8Array(d.W * rowsPerBand * 4);
      for (let i = 0; i < d.W * rowsPerBand; i++) { rgba[i * 4] = ROUTE_RGB[0]; rgba[i * 4 + 1] = ROUTE_RGB[1]; rgba[i * 4 + 2] = ROUTE_RGB[2]; }
      const mm = carveLongMm(), b = d.bounds;
      routeStatus('Drawing route layer… 0%');
      const blob = await HM.encodePngStream({
        width: d.W, height: d.H, channels: 4, rowsPerBand,
        text: { Software: 'MapNC', Bounds: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(','), RouteWidthM: String(lineWidthM()) },
        pixelsPerMetre: mm ? Math.max(d.W, d.H) / (mm / 1000) : null,
        isCancelled: () => layerCancel,
        onProgress: (f) => routeStatus('Drawing route layer… ' + Math.round(f * 100) + '%'),
        getRows: async (y0, n) => {
          const band = Math.floor(y0 / rowsPerBand);
          if (br.isEmpty(band)) { for (let i = 0; i < d.W * n; i++) rgba[i * 4 + 3] = 0; }
          else { br.render(band, cover); for (let i = 0; i < d.W * n; i++) rgba[i * 4 + 3] = Math.round(cover[i] * 255); }
          return rgba.subarray(0, d.W * n * 4);
        },
      });
      routeStatus('Saved ' + saveBlob(blob, exportBaseName(d) + '_' + d.W + 'x' + d.H + '_route.png') + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).');
    } catch (err) {
      routeStatus(err.name === 'AbortError' ? 'Cancelled.' : 'Export failed: ' + err.message);
    } finally {
      layerBusy = false; layerCancel = false;
      btn.textContent = 'Export route layer (PNG)';
    }
  });

  function vectorExport(kind) {
    const grid = exportGrid();
    if (!track || !grid) return;
    const mm = carveLongMm(), gs = Geo.groundSize(grid.bounds), longM = Math.max(gs.widthM, gs.heightM);
    const o = {
      mmPerPx: mm ? mm / Math.max(grid.W, grid.H) : 0,
      lineWidth: mm ? lineWidthM() * (mm / longM) : 0,     // only how thick the SVG line looks; CAM uses the centre line
      border: $('vec-border').checked, title: track.name || 'MapNC route',
    };
    const text = kind === 'svg' ? Vec.toSvg(track, grid.bounds, grid.W, grid.H, o) : Vec.toDxf(track, grid.bounds, grid.W, grid.H, o);
    const blob = new Blob([text], { type: kind === 'svg' ? 'image/svg+xml' : 'application/dxf' });
    routeStatus('Saved ' + saveBlob(blob, exportBaseName(grid) + '_' + grid.W + 'x' + grid.H + '_route.' + kind) + ' (' + (blob.size / 1024).toFixed(0) + ' KB, ' + (mm ? 'mm' : 'px') + ').');
  }
  $('export-svg-btn').addEventListener('click', () => vectorExport('svg'));
  $('export-dxf-btn').addEventListener('click', () => vectorExport('dxf'));

  $('source-select').addEventListener('change', () => { resetResult(); refresh(); scheduleAutoFetch(); });

  // Collapsible panes remember whether they were open.
  document.querySelectorAll('details.pane').forEach((d) => {
    try { const v = localStorage.getItem('mapnc-pane-' + d.id); if (v !== null) d.open = v === '1'; } catch (e) { /* default state */ }
    d.addEventListener('toggle', () => { try { localStorage.setItem('mapnc-pane-' + d.id, d.open ? '1' : '0'); } catch (e) { /* ignore */ } });
  });

  // Start with the sample route loaded so the whole flow can be tried straight away. "Clear route" removes it;
  // add ?sample=off to the address to start empty.
  if (new URLSearchParams(location.search).get('sample') !== 'off') loadSample(true);
})();
