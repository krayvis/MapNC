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
  const map = L.map('map', { worldCopyJump: true, boxZoom: false, maxZoom: 22 }).setView([39.5, -98.35], 4);

  // Base maps. className marks which ones the dark-mode filter may invert: it suits drawn maps, but would wreck photos.
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const baseLayers = {
    'Street (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 22, maxNativeZoom: 19, className: 'tiles-map', attribution: OSM_ATTR,
    }),
    'Topographic (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 22, maxNativeZoom: 17, subdomains: 'abc', className: 'tiles-map',
      attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    }),
    'Satellite (Esri World Imagery)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22, maxNativeZoom: 19, className: 'tiles-photo',
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    }),
    'USGS Topo (US only)': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 22, maxNativeZoom: 16, className: 'tiles-map',
      attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>',
    }),
  };
  let baseName = 'Street (OpenStreetMap)';
  const SATELLITE = 'Satellite (Esri World Imagery)';
  try { const saved = localStorage.getItem('mapnc-basemap'); if (saved && baseLayers[saved]) baseName = saved; } catch (e) { /* storage unavailable: default map */ }
  baseLayers[baseName].addTo(map);
  L.control.layers(baseLayers, null, { collapsed: true, position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { baseName = e.name; try { localStorage.setItem('mapnc-basemap', e.name); } catch (err) { /* ignore */ } });
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
    return portrait ? Geo.parseRatio(h, w) : Geo.parseRatio(w, h);
  }

  // Presets are listed landscape (4:3). Rotating flips them to portrait (3:4) in the menu itself, as a camera or phone
  // does, rather than turning the choice into a custom ratio. The option values stay landscape; only the label and
  // the ratio read from them change.
  let portrait = false;
  const baseLabel = new Map();
  const flipLabel = (t) => t.replace(/^(\d+):(\d+)/, '$2:$1').replace(/(\d+)×(\d+)/g, '$2×$1');
  function relabelAspect() {
    for (const o of $('aspect-select').options) {
      if (!/^\d+:\d+$/.test(o.value)) continue;
      if (!baseLabel.has(o)) baseLabel.set(o, o.textContent);
      o.textContent = portrait ? flipLabel(baseLabel.get(o)) : baseLabel.get(o);
    }
    $('aspect-swap').classList.toggle('is-portrait', portrait);
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
    else { portrait = !portrait; relabelAspect(); }
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
  ['carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', refresh));

  const fmtM = (m) => (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)) + ' m';

  // ---- readout -----------------------------------------------------------------------------

  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(0) + ' m');
  const fmtDeg = (ll) => Math.abs(ll.lat).toFixed(4) + (ll.lat < 0 ? 'S ' : 'N ') + Math.abs(ll.lng).toFixed(4) + (ll.lng < 0 ? 'W' : 'E');

  /** Is this pixel size enough for the carve? Judged against the finishing stepover (0.25 mm if none is given), and
   *  against the source data's own spacing, which sets the real detail however many pixels there are. */
  function resolutionAdvice(a) {
    const step = a.stepMm > 0 ? a.stepMm : 0.25, given = a.stepMm > 0;
    const needPx = Math.ceil(a.carveMm / step);
    const stepTxt = step + ' mm' + (given ? '' : ' (typical; enter yours above)');
    if (a.mmPx > step * 1.5) return { level: 'warn', text: 'Too coarse: pixels are ' + a.mmPx.toFixed(2) + ' mm on the carve, wider than a ' + stepTxt + ' stepover, so the toolpath will follow visible steps. Use about ' + needPx + ' px on the long side or more.' };
    if (a.srcMm > step * 2) return { level: 'note', text: 'Pixel size is fine, but the elevation data itself is only sampled every ' + a.srcMm.toFixed(2) + ' mm on the carve, coarser than a ' + stepTxt + ' stepover. The extra pixels give a smooth surface, not extra detail. A smaller region or a higher-resolution source is the only way to add real detail.' };
    if (a.mmPx < step / 4 && a.longPx > needPx * 2) return { level: 'note', text: 'More than needed: ' + a.mmPx.toFixed(3) + ' mm per pixel is far finer than a ' + stepTxt + ' stepover. About ' + needPx + ' px on the long side would do the same job with a smaller file.' };
    return { level: 'ok', text: 'Resolution is sufficient: ' + a.mmPx.toFixed(2) + ' mm per pixel against a ' + stepTxt + ' stepover.' };
  }

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
        const longM = Math.max(g.widthM, g.heightM);
        const adv = resolutionAdvice({ carveMm: mm, mmPx, srcMm: mm * plan.resolutionM / longM, longPx: Math.max(plan.grid.width, plan.grid.height), stepMm: parseFloat($('stepover').value) });
        $('out-advice').textContent = adv.text; $('out-advice').className = 'hint ' + (adv.level === 'ok' ? '' : 'warning'); $('out-advice').hidden = false;
      } else {
        $('out-carve').textContent = 'enter a carve size above';
        $('out-advice').hidden = true;
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
  let cleanedTrack = null; // rawTrack after the automatic clean-up
  let editTrack = null;    // cleanedTrack plus manual edits; exists only while there are edits
  let lastCleanStats = null;
  let trackLayer = null;   // Leaflet polyline group
  let widthTouched = false; // true once the user edits the line width, so a re-fit won't overwrite it

  /** The route as drawn and exported: the points themselves, or a spline fitted through them when that is switched on. */
  function shown() {
    if (!track || !$('spline-on').checked) return track;
    try { return Track.splineTrack(track, parseFloat($('spline-tol').value) || 0.5); } catch (e) { return track; }
  }

  function trackError(msg) { $('track-error').textContent = msg; $('track-error').hidden = !msg; }

  const ll = (t) => t.segments.map((seg) => seg.map((p) => [p.lat, p.lon]));

  // The original track shows dashed grey under the route whenever clean-up or editing has changed it (and the user
  // has not hidden it). One place decides, so clean-up and editing cannot disagree.
  let showOriginal = true, thinLine = false;
  function syncRawLayer() {
    const want = showOriginal && rawTrack && trackLayer && ((lastCleanStats && lastCleanStats.changed) || editTrack);
    if (want && !rawLayer) rawLayer = L.polyline(ll(rawTrack), { color: '#7b8794', weight: 2, dashArray: '4 5', opacity: .9, interactive: false }).addTo(map);
    else if (!want && rawLayer) { rawLayer.remove(); rawLayer = null; }
    if (trackLayer) { trackLayer.setStyle({ weight: thinLine ? 1.5 : 3 }); trackLayer.bringToFront(); }
  }

  function trackSummary() {
    const pts = track.segments.reduce((n, s) => n + s.length, 0);
    return (track.name ? track.name + ': ' : '') + Track.trackLengthKm(track).toFixed(1) + ' km, ' +
      pts + ' points' + (track.segments.length > 1 ? ' in ' + track.segments.length + ' segments' : '') + '.';
  }

  function showTrack() {
    if (trackLayer) trackLayer.remove();
    if (rawLayer) { rawLayer.remove(); rawLayer = null; }
    trackLayer = L.polyline(ll(shown()), { color: '#e11d48', weight: 3, interactive: false }).addTo(map);
    $('track-info').textContent = trackSummary();
    $('track-info').hidden = false;
    $('track-fit').hidden = false;
    $('track-clear').hidden = false;
    $('route-guide-wrap').hidden = false;
    $('route-export').hidden = false;
    $('pane-clean').hidden = false;
    updateRouteExportInfo();
  }

  // ---- route clean-up ----------------------------------------------------------------------

  const num = (id) => Math.max(0, parseFloat($(id).value) || 0);
  const cleanOpts = () => ({
    spikeM: $('clean-spikes').checked ? num('clean-spike-m') : 0,
    spacingM: num('clean-spacing'), mergeM: $('clean-merge').checked ? num('clean-merge-m') : 0,
  });

  function applyClean() {
    if (!rawTrack) return;
    let result;
    try { result = Track.cleanTrack(rawTrack, cleanOpts()); } catch (err) { trackError('Clean-up failed: ' + err.message); return; }
    cleanedTrack = result.track;
    track = editTrack || cleanedTrack;
    const st = lastCleanStats = result.stats;
    trackLayer.setLatLngs(ll(shown()));
    syncRawLayer();
    $('clean-points').textContent = st.changed ? st.pointsBefore + ' → ' + st.pointsAfter : st.pointsBefore + ' (unchanged)';
    $('clean-length').textContent = st.changed ? st.lengthBeforeKm.toFixed(2) + ' → ' + st.lengthAfterKm.toFixed(2) + ' km' : st.lengthBeforeKm.toFixed(2) + ' km';
    $('clean-shift').textContent = st.changed ? (st.maxShiftM < 10 ? st.maxShiftM.toFixed(1) : st.maxShiftM.toFixed(0)) + ' m from the original' : '–';
    $('clean-spikes-n').textContent = $('clean-spikes').checked ? String(st.spikes) : '–';
    refreshEditUi();
    $('track-info').textContent = trackSummary();
  }

  let cleanTimer = null;
  const scheduleClean = () => { clearTimeout(cleanTimer); cleanTimer = setTimeout(applyClean, 150); };
  ['clean-spikes', 'clean-spike-m', 'clean-spacing', 'clean-merge', 'clean-merge-m'].forEach((id) => $(id).addEventListener('input', scheduleClean));
  function setCleanInputs(spikes, spacing) {
    $('clean-spikes').checked = spikes > 0;
    $('clean-spike-m').value = spikes > 0 ? spikes : 20;
    $('clean-spacing').value = spacing;
    $('clean-merge').checked = false; $('clean-merge-m').value = 3;
    syncDependents();
  }

  // Fields that only matter while a checkbox is on (data-for="<checkbox id>") are hidden until it is ticked.
  function syncDependents() {
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !$(el.dataset.for).checked; });
  }
  document.querySelectorAll('[data-for]').forEach((el) => $(el.dataset.for).addEventListener('change', syncDependents));
  syncDependents();
  function splineChanged() {
    if (!track) return;
    trackLayer.setLatLngs(ll(shown()));
    syncRawLayer();
    if (elevation && grey) drawPreview();
    updateRouteExportInfo();
  }
  $('spline-on').addEventListener('change', splineChanged);
  $('spline-tol').addEventListener('input', splineChanged);
  $('clean-suggest').addEventListener('click', () => { setCleanInputs(20, 3); applyClean(); });
  $('clean-reset').addEventListener('click', () => { setCleanInputs(0, 0); applyClean(); });

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
    resetEditState();
    track = rawTrack;
    setCleanInputs(0, 0);
    widthTouched = false;
    showTrack();
    applyClean();
    fitToTrack();
  }

  $('track-file').addEventListener('change', async (ev) => {
    const f = ev.target.files[0];
    if (f) loadTrackText(await f.text(), f.name);
  });

  // Sample route shipped with the site (same origin, so no CORS and nothing leaves the browser). It loads at start.
  async function loadSample() {
    try {
      const res = await fetch('samples/sierra-buttes-fire-lookout.gpx');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      loadTrackText(await res.text(), 'sierra-buttes-fire-lookout.gpx');
    } catch (err) { /* the sample is a convenience; start empty if it cannot load */ }
  }

  $('track-fit').addEventListener('click', () => track && fitToTrack());
  $('track-clear').addEventListener('click', () => {
    resetEditState();
    track = null;
    rawTrack = null;
    cleanedTrack = null;
    if (trackLayer) { trackLayer.remove(); trackLayer = null; }
    if (rawLayer) { rawLayer.remove(); rawLayer = null; }
    $('track-file').value = '';
    ['track-info', 'track-fit', 'track-clear', 'route-guide-wrap', 'route-export', 'pane-clean'].forEach((id) => { $(id).hidden = true; });
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
      curve: { kind: $('curve-kind').value, strength: parseFloat($('curve-strength').value) },
      bits: Number($('bits-select').value),
      invert: $('invert').checked,
    };
  }

  // ---- route rasterizing -------------------------------------------------------------------

  let routeCache = null;   // { elev, key, weight }: the route weights depend only on grid, width and profile

  function recompute() {
    if (!elevation) return;
    grey = HM.toGrey(elevation.data, currentParams());
    const total = elevation.data.length - grey.nodata;
    $('hm-window').textContent = grey.lo.toFixed(1) + ' to ' + grey.hi.toFixed(1) + ' m' + (grey.k !== 1 ? ' (×' + grey.k + ')' : '');
    $('hm-level').textContent = grey.metresPerLevel < 0.01
      ? (grey.metresPerLevel * 1000).toFixed(2) + ' mm (' + (grey.maxVal + 1) + ' levels)'
      : grey.metresPerLevel.toFixed(3) + ' m (' + (grey.maxVal + 1) + ' levels)';
    if (grey.curve) $('hm-level').textContent += ', average: the curve makes it vary';
    const clip = grey.clippedHigh + grey.clippedLow;
    $('hm-clip').textContent = clip ? (100 * clip / total).toFixed(1) + '% of samples (' +
      (grey.clippedHigh ? 'above window' : '') + (grey.clippedHigh && grey.clippedLow ? ', ' : '') + (grey.clippedLow ? 'below window' : '') + ')' : 'none';
    $('export-status').textContent = '';
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
      for (const seg of Track.toPixels(shown(), e.bounds, e.width, e.height)) {
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
  ['range-lo', 'range-hi', 'curve-strength'].forEach((id) => $(id).addEventListener('input', scheduleRecompute));
  $('curve-kind').addEventListener('change', () => { $('curve-strength-wrap').hidden = $('curve-kind').value === 'linear'; recompute(); });
  ['bits-select', 'invert', 'route-guide'].forEach((id) => $(id).addEventListener('change', recompute));
  $('route-width').addEventListener('input', () => { widthTouched = true; });

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
        MetresPerGreyLevel: grey.metresPerLevel.toPrecision(5) + (grey.curve ? ' (average)' : ''),
        HeightCurve: grey.curve ? grey.curve.kind + ' ' + grey.curve.strength : 'linear',
        Inverted: String($('invert').checked),
      }, 1, pixelsPerMetre());
      $('export-status').textContent = 'Saved ' + saveBlob(blob, exportFilename()) + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).';
    } catch (err) {
      $('export-status').textContent = 'Export failed: ' + err.message;
    } finally {
      $('export-btn').disabled = false;
    }
  });

  // ---- manual point editing ----------------------------------------------------------------
  // Pipeline: original -> automatic clean-up -> manual edits. While manual edits exist the clean-up controls are locked
  // (changing them would silently throw the hand work away); "Discard manual edits" unlocks them. Edits happen on the
  // map: drag a point to move it, drag the line to add a point, click to select (Shift+click for a stretch), Delete
  // or right-click to remove. Pointer events with pointer capture are used, so mouse and touch behave alike.

  const edit = { on: false, undo: [], redo: [], sel: null, drag: null };
  const MAX_HANDLES = 1500;                      // more handles than this in view and the map gets sluggish
  const UNDO_LIMIT = 100;
  const editPane = map.createPane('edit');
  editPane.classList.add('leaflet-edit-pane');
  const editRenderer = L.canvas({ pane: 'edit', padding: 0.3 });
  const handleLayer = L.layerGroup().addTo(map);
  let handleMarkers = new Map();                 // "seg:idx" -> circleMarker, so a drag moves one marker, not all
  let lastView = { list: [], total: 0 };         // vertices in view, in container pixels

  const hkey = (seg, idx) => seg + ':' + idx;
  const isSelected = (seg, idx) => !!edit.sel && edit.sel.seg === seg && idx >= edit.sel.a && idx <= edit.sel.b;

  function visibleVertices() {
    const out = [], size = map.getSize(), pad = 24;
    let total = 0;
    if (track) track.segments.forEach((seg, si) => seg.forEach((p, pi) => {
      const c = map.latLngToContainerPoint([p.lat, p.lon]);
      if (c.x < -pad || c.x > size.x + pad || c.y < -pad || c.y > size.y + pad) return;
      total++;
      if (total <= MAX_HANDLES) out.push({ seg: si, idx: pi, x: c.x, y: c.y });
    }));
    return { list: total > MAX_HANDLES ? [] : out, total };      // too many in view: no handles at all
  }

  function drawHandles() {
    handleLayer.clearLayers();
    handleMarkers = new Map();
    lastView = edit.on && track ? visibleVertices() : { list: [], total: 0 };
    if (edit.on && lastView.total <= MAX_HANDLES) {
      for (const v of lastView.list) {
        const p = track.segments[v.seg][v.idx], sel = isSelected(v.seg, v.idx);
        const m = L.circleMarker([p.lat, p.lon], {
          renderer: editRenderer, pane: 'edit', interactive: false, radius: sel ? 8 : 5, weight: 2,
          color: sel ? '#2563eb' : '#e11d48', fillColor: sel ? '#2563eb' : '#ffffff', fillOpacity: 1,
        }).addTo(handleLayer);
        handleMarkers.set(hkey(v.seg, v.idx), m);
      }
    }
    refreshEditUi();
  }
  map.on('moveend zoomend', () => { if (edit.on) drawHandles(); });

  const segDist = (p, a, b) => {                  // distance from p to segment a-b, and the nearest point on it
    const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
    const q = { x: a.x + t * vx, y: a.y + t * vy };
    return { d: Math.hypot(p.x - q.x, p.y - q.y), q };
  };

  /** What is under container point `cp`: a vertex, a line (to insert into), or nothing. */
  function hitTest(cp, touch) {
    if (!edit.on || !track || lastView.total > MAX_HANDLES) return null;
    const R = touch ? 20 : 11;
    let best = null, bd = R * R;
    for (const v of lastView.list) { const d = (v.x - cp.x) ** 2 + (v.y - cp.y) ** 2; if (d <= bd) { bd = d; best = v; } }
    if (best) return { type: 'vertex', seg: best.seg, idx: best.idx, x: best.x, y: best.y };
    const L2 = touch ? 16 : 9;
    let line = null, ld = L2;
    track.segments.forEach((seg, si) => {
      let prev = null;
      seg.forEach((p, pi) => {
        const c = map.latLngToContainerPoint([p.lat, p.lon]);
        if (prev && !(Math.max(prev.x, c.x) < cp.x - L2 || Math.min(prev.x, c.x) > cp.x + L2 || Math.max(prev.y, c.y) < cp.y - L2 || Math.min(prev.y, c.y) > cp.y + L2)) {
          const r = segDist(cp, prev, c);
          if (r.d <= ld) { ld = r.d; line = { type: 'line', seg: si, after: pi - 1, q: r.q }; }
        }
        prev = c;
      });
    });
    return line;
  }

  const snapshotNow = () => Track.snapshotSegments(track.segments);
  function ensureEditTrack() {
    if (!editTrack) editTrack = { name: track.name, segments: Track.copySegments(track.segments) };
    track = editTrack;
  }
  function pushUndo(snap) {
    edit.undo.push(snap);
    if (edit.undo.length > UNDO_LIMIT) edit.undo.shift();
    edit.redo = [];
  }

  /** After the route changed for good (drop, delete, undo, redo): redraw everything that depends on it. */
  function commitTrackChange() {
    trackLayer.setLatLngs(ll(shown()));
    syncRawLayer();
    $('track-info').textContent = trackSummary();
    drawHandles();
    if (elevation) recompute();                    // the route in the heightmap follows the edit
  }

  function onEditDown(e) {
    if (!edit.on || drawing || edit.drag || e.button > 0) return;
    if (e.target.closest && e.target.closest('.leaflet-control, .leaflet-marker-icon')) return;
    const cp = map.mouseEventToContainerPoint(e);
    const hit = hitTest(cp, e.pointerType === 'touch');
    if (!hit) return;                              // empty map: let it pan
    map.dragging.disable();                        // this gesture belongs to the editor, not the map
    try { mapEl.setPointerCapture(e.pointerId); } catch (err) { /* pointer not capturable: the gesture still works while it stays over the map */ }
    edit.drag = { id: e.pointerId, hit, start: cp, moved: false, shift: e.shiftKey, before: null, target: null,
      offset: hit.type === 'vertex' ? { x: hit.x - cp.x, y: hit.y - cp.y } : { x: 0, y: 0 } };
    e.preventDefault();
  }

  function onEditMove(e) {
    const d = edit.drag;
    if (!d || e.pointerId !== d.id) return;
    const cp = map.mouseEventToContainerPoint(e);
    if (!d.moved) {
      if (Math.hypot(cp.x - d.start.x, cp.y - d.start.y) < 4) return;   // still a click
      d.moved = true;
      d.before = snapshotNow();                                          // the state to return to on Undo
      ensureEditTrack();
      if (d.hit.type === 'line') {                                       // dragging the line adds a point where it was grabbed
        const at = map.containerPointToLatLng([d.hit.q.x, d.hit.q.y]);
        const r = Track.insertPoint(track.segments, d.hit.seg, d.hit.after, at.lat, at.lng);
        track.segments = r.segments;
        d.target = { seg: d.hit.seg, idx: r.index };
        drawHandles();
      } else d.target = { seg: d.hit.seg, idx: d.hit.idx };
    }
    const ll2 = map.containerPointToLatLng([cp.x + d.offset.x, cp.y + d.offset.y]);
    track.segments[d.target.seg][d.target.idx] = { lat: ll2.lat, lon: ll2.lng };
    trackLayer.setLatLngs(ll(shown()));
    const m = handleMarkers.get(hkey(d.target.seg, d.target.idx));
    if (m) m.setLatLng(ll2);
  }

  function onEditUp(e) {
    const d = edit.drag;
    if (!d || e.pointerId !== d.id) return;
    edit.drag = null;
    map.dragging.enable();
    try { mapEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    if (d.moved) {
      pushUndo(d.before);
      commitTrackChange();
    } else if (d.hit.type === 'vertex') {
      const same = edit.sel && edit.sel.seg === d.hit.seg;
      edit.sel = d.shift && same
        ? { seg: d.hit.seg, a: Math.min(edit.sel.a, d.hit.idx), b: Math.max(edit.sel.b, d.hit.idx) }
        : { seg: d.hit.seg, a: d.hit.idx, b: d.hit.idx };
      drawHandles();
    } else { edit.sel = null; drawHandles(); }
  }
  mapEl.addEventListener('pointerdown', onEditDown);
  mapEl.addEventListener('pointermove', onEditMove);
  mapEl.addEventListener('pointerup', onEditUp);
  mapEl.addEventListener('pointercancel', onEditUp);

  // Cursor hint while hovering (mouse only; touch has no hover, so the help text carries the explanation).
  let hoverQueued = false;
  mapEl.addEventListener('pointermove', (e) => {
    if (!edit.on || edit.drag || e.pointerType === 'touch' || hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      const hit = hitTest(map.mouseEventToContainerPoint(e), false);
      mapEl.classList.toggle('editing-hit-vertex', !!hit && hit.type === 'vertex');
      mapEl.classList.toggle('editing-hit-line', !!hit && hit.type === 'line');
    });
  });

  function deleteSelected() {
    if (!edit.sel || !track) return;
    const before = snapshotNow();
    const copy = { name: track.name, segments: Track.copySegments(track.segments) };
    const r = Track.deletePoints(copy.segments, edit.sel.seg, edit.sel.a, edit.sel.b);
    if (!r.ok) { $('edit-status').textContent = r.reason; return; }
    editTrack = { name: copy.name, segments: r.segments };
    track = editTrack;
    pushUndo(before);
    edit.sel = null;
    commitTrackChange();
  }
  mapEl.addEventListener('contextmenu', (e) => {
    if (!edit.on) return;
    const hit = hitTest(map.mouseEventToContainerPoint(e), false);
    if (!hit || hit.type !== 'vertex') return;
    e.preventDefault();
    edit.sel = { seg: hit.seg, a: hit.idx, b: hit.idx };
    deleteSelected();
  });

  function undo() {
    if (!edit.undo.length) return;
    edit.redo.push(snapshotNow());
    editTrack = { name: track.name, segments: Track.restoreSegments(edit.undo.pop()) };
    if (!edit.undo.length) { editTrack = null; track = cleanedTrack; } else track = editTrack;
    edit.sel = null;
    commitTrackChange();
  }
  function redo() {
    if (!edit.redo.length) return;
    edit.undo.push(snapshotNow());
    editTrack = { name: track.name, segments: Track.restoreSegments(edit.redo.pop()) };
    track = editTrack;
    edit.sel = null;
    commitTrackChange();
  }

  document.addEventListener('keydown', (e) => {
    if (!edit.on || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Escape') { if (edit.sel) { edit.sel = null; drawHandles(); } else setEditing(false); }
  });

  function setEditing(on) {
    edit.on = on && !!track;
    if (edit.on) setDrawing(false);
    edit.drag = null;
    $('main-view').hidden = edit.on;               // the sidebar becomes the editor while editing
    $('edit-view').hidden = !edit.on;
    $('panel').scrollTop = 0;
    mapEl.classList.remove('editing-hit-vertex', 'editing-hit-line');
    drawHandles();
  }

  function resetEditState() {
    editTrack = null;
    edit.undo = []; edit.redo = []; edit.sel = null; edit.drag = null;
    setEditing(false);
  }

  /** Keep every control that depends on the editing state in step with it. */
  function refreshEditUi() {
    const locked = !!editTrack, n = edit.undo.length;
    ['clean-spikes', 'clean-spike-m', 'clean-spacing', 'clean-merge', 'clean-merge-m', 'clean-suggest', 'clean-reset'].forEach((id) => { $(id).disabled = locked; });
    // main sidebar: a short summary and the way to unlock
    $('edit-summary').hidden = !locked;
    $('edit-summary').textContent = locked ? 'Manual edits: ' + n + ' change' + (n === 1 ? '' : 's') + '. The settings above are locked until you discard them.' : '';
    $('edit-discard').hidden = !locked;
    // editing view
    $('edit-undo').disabled = !n;
    $('edit-redo').disabled = !edit.redo.length;
    $('edit-delete').disabled = !edit.sel;
    $('edit-discard2').hidden = !locked;
    document.querySelectorAll('#edit-view [data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.base === baseName)));
    if (track) {
      $('edit-points').textContent = track.segments.reduce((c, sg) => c + sg.length, 0) + (track.segments.length > 1 ? ' in ' + track.segments.length + ' segments' : '');
      $('edit-length').textContent = Track.trackLengthKm(track).toFixed(2) + ' km';
    }
    $('edit-count').textContent = n ? n + ' change' + (n === 1 ? '' : 's') : 'none yet';
    let msg = '';
    if (edit.on && lastView.total > MAX_HANDLES) msg = lastView.total + ' points are in view. Zoom in (to under ' + MAX_HANDLES + ') to see and edit them.';
    else if (edit.sel) msg = edit.sel.a === edit.sel.b ? 'Point ' + (edit.sel.a + 1) + ' selected.' : (edit.sel.b - edit.sel.a + 1) + ' points selected (' + (edit.sel.a + 1) + '–' + (edit.sel.b + 1) + ').';
    else if (edit.on) msg = lastView.total + ' points in view.';
    $('edit-status').textContent = msg;
  }

  $('edit-toggle').addEventListener('click', () => setEditing(true));
  $('edit-done').addEventListener('click', () => setEditing(false));
  $('edit-undo').addEventListener('click', undo);
  $('edit-redo').addEventListener('click', redo);
  $('edit-delete').addEventListener('click', deleteSelected);
  const discardEdits = () => { const was = edit.on; resetEditState(); applyClean(); if (was) setEditing(true); };
  $('edit-discard').addEventListener('click', discardEdits);
  $('edit-discard2').addEventListener('click', discardEdits);

  function showBase(name) {
    if (!baseLayers[name] || name === baseName) return;
    map.removeLayer(baseLayers[baseName]);
    baseLayers[name].addTo(map);                    // the layer switcher and the remembered choice follow via baselayerchange
  }
  document.querySelectorAll('#edit-view [data-base]').forEach((b) => b.addEventListener('click', () => showBase(b.dataset.base)));
  $('edit-show-original').addEventListener('change', () => { showOriginal = $('edit-show-original').checked; syncRawLayer(); });
  $('edit-thin').addEventListener('change', () => { thinLine = $('edit-thin').checked; syncRawLayer(); });
  map.on('baselayerchange', refreshEditUi);
  window.MapNC.editView = () => ({ list: lastView.list, total: lastView.total, on: edit.on, sel: edit.sel, undo: edit.undo.length, redo: edit.redo.length });
  window.MapNC.track = () => track;
  window.MapNC.hit = (x, y, touch) => { const h = hitTest({ x, y }, !!touch); return h && { type: h.type, seg: h.seg, idx: h.idx }; };

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
  $('stepover').addEventListener('input', refresh);

  // PNG / Vector tabs for the route export.
  (function () {
    const tabs = [['tab-png', 'tabpanel-png'], ['tab-vec', 'tabpanel-vec']];
    const select = (id) => tabs.forEach(([t, p]) => {
      const on = t === id; $(t).setAttribute('aria-selected', on ? 'true' : 'false'); $(t).tabIndex = on ? 0 : -1; $(p).hidden = !on;
    });
    tabs.forEach(([t], i) => {
      $(t).addEventListener('click', () => select(t));
      $(t).addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]; select(n); $(n).focus();
      });
    });
  })();

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
      const br = Track.createBandRasterizer(shown(), d.bounds, d.W, d.H, lineWidthM() / 2 / d.pm, 'uniform', rowsPerBand);
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
      border: $('vec-border').checked, marks: $('vec-marks').checked, title: track.name || 'MapNC route',
    };
    const text = kind === 'svg' ? Vec.toSvg(shown(), grid.bounds, grid.W, grid.H, o) : Vec.toDxf(shown(), grid.bounds, grid.W, grid.H, o);
    const blob = new Blob([text], { type: kind === 'svg' ? 'image/svg+xml' : 'application/dxf' });
    routeStatus('Saved ' + saveBlob(blob, exportBaseName(grid) + '_' + grid.W + 'x' + grid.H + '_route.' + kind) + ' (' + (blob.size / 1024).toFixed(0) + ' KB, ' + (mm ? 'mm' : 'px') + ').');
  }
  $('export-svg-btn').addEventListener('click', () => vectorExport('svg'));
  $('export-dxf-btn').addEventListener('click', () => vectorExport('dxf'));

  $('source-select').addEventListener('change', () => { resetResult(); refresh(); scheduleAutoFetch(); });

  // Collapsible panes behave as an accordion: opening one closes the others. What is open is remembered.
  const panes = Array.from(document.querySelectorAll('details.pane'));
  let restoring = true;
  panes.forEach((d) => {
    try { const v = localStorage.getItem('mapnc-pane-' + d.id); if (v !== null) d.open = v === '1'; } catch (e) { /* default state */ }
  });
  const firstOpen = panes.find((d) => d.open);
  if (!window.__MAPNC_FREE_PANES) panes.forEach((d) => { if (d !== firstOpen) d.open = false; });
  setTimeout(() => { restoring = false; }, 0);
  panes.forEach((d) => {
    d.addEventListener('toggle', () => {
      if (restoring) return;
      if (d.open && !window.__MAPNC_FREE_PANES) panes.forEach((o) => { if (o !== d && o.open) o.open = false; });   // the flag is for tests that need several panes readable at once
      try { panes.forEach((o) => localStorage.setItem('mapnc-pane-' + o.id, o.open ? '1' : '0')); } catch (e) { /* ignore */ }
    });
  });

  // Start with the sample route loaded so the whole flow can be tried straight away. "Clear route" removes it;
  // add ?sample=off to the address to start empty.
  if (new URLSearchParams(location.search).get('sample') !== 'off') loadSample();
})();
