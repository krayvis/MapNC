/* MapNC phase 1: map, rectangle selection, source auto-detect readout. */
(function () {
  'use strict';
  const Geo = window.MapNCGeo, Tiles = window.MapNCTiles, Zip = window.MapNCZip;

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
  window.MapNC = { map, get elevation() { return elevation; }, get grey() { return grey; }, region: () => bounds, get t3() { return t3; } }; // handle for debugging and automated tests

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
  ['carve-size', 'carve-unit', 'piece-size', 'tile-overlap'].forEach((id) => $(id).addEventListener('input', refresh));

  // ---- tiling: the suggestion in step 4 and the plan the tile export uses ------------------------

  const unitMm = () => ($('carve-unit').value === 'in' ? 25.4 : 1);
  const fmtLen = (mm) => ($('carve-unit').value === 'in' ? (mm / 25.4).toFixed(2) + ' in' : mm.toFixed(mm < 100 ? 1 : 0) + ' mm');
  const TILE_HINT = $('tile-note').textContent;

  /** How to cut a W x H pixel grid into tiles for the carve size, largest piece and overlap entered. */
  function tilePlan(W, H) {
    const mm = carveLongMm(), piece = parseFloat($('piece-size').value), ov = parseFloat($('tile-overlap').value);
    return Tiles.planTiles({ W, H, mmPerPx: mm ? mm / Math.max(W, H) : 0, maxPieceMm: piece > 0 ? piece * unitMm() : 0, overlapMm: ov > 0 ? ov * unitMm() : 0 });
  }

  /** The tiling advice under Output size. */
  function updateTileNote(W, H) {
    const note = $('tile-note'), piece = parseFloat($('piece-size').value);
    document.querySelectorAll('.carve-unit-name').forEach((s) => { s.textContent = $('carve-unit').value; });
    let text = TILE_HINT, warn = false;
    if (piece > 0 && !carveLongMm()) { text = 'Enter the carve size above to see how it tiles.'; warn = true; }
    else if (piece > 0) {
      const tp = tilePlan(W, H), k = tp.carveWmm / W;
      if (tp.error) { text = tp.error; warn = true; }
      else if (!tp.needed) text = 'The whole carve (' + fmtLen(tp.carveWmm) + ' × ' + fmtLen(tp.carveHmm) + ') fits in one piece, so no tiling is needed.';
      else text = 'Tiling suggested: the carve is ' + fmtLen(tp.carveWmm) + ' × ' + fmtLen(tp.carveHmm) + ', more than the ' + fmtLen(piece * unitMm()) + ' you can cut at once. Cut it as ' + tp.cols + ' × ' + tp.rows + ' tiles (' + tp.count + ') of ' + fmtLen(tp.tileWmm) + ' × ' + fmtLen(tp.tileHmm) + ' (' + tp.tileW + ' × ' + tp.tileH + ' px, ' + k.toFixed(2) + ' mm per pixel), overlapping by at least ' + fmtLen(tp.minOverlapPx * k) + '. Step 5 exports the tiles.';
    }
    note.textContent = text;
    note.classList.toggle('warning', warn);
  }

  const fmtM = (m) => (m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)) + ' m';

  // ---- readout -----------------------------------------------------------------------------

  const fmtKm = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(0) + ' m');
  const fmtDeg = (ll) => Math.abs(ll.lat).toFixed(4) + (ll.lat < 0 ? 'S ' : 'N ') + Math.abs(ll.lng).toFixed(4) + (ll.lng < 0 ? 'W' : 'E');

  /** Is this pixel size enough for the carve? Judged against a typical 0.25 mm finishing stepover. The source data's own
   *  spacing is covered by the Output size note, so it is not repeated here. Only "too coarse" is worth a warning style. */
  const TYPICAL_STEPOVER_MM = 0.25;
  function resolutionAdvice(a) {
    const step = TYPICAL_STEPOVER_MM;
    const needPx = Math.ceil(a.carveMm / step);
    if (a.mmPx > step * 1.5) return { level: 'warn', text: 'Too coarse for a typical ' + step + ' mm stepover: pixels are ' + a.mmPx.toFixed(2) + ' mm on the carve, so the toolpath will follow visible steps. Use about ' + needPx + ' px on the long side or more.' + (needPx > a.capPx ? ' That is over the ' + a.capPx + ' px cap: raise it under Advanced, or carve a smaller area (tiles are cut from this one grid, so they do not add pixels).' : '') };
    if (a.mmPx < step / 4 && a.longPx > needPx * 2) return { level: 'note', text: 'More than needed: ' + a.mmPx.toFixed(3) + ' mm per pixel is far finer than a typical ' + step + ' mm stepover. About ' + needPx + ' px on the long side would do the same job with a smaller file.' };
    return { level: 'ok', text: 'Resolution is sufficient: ' + a.mmPx.toFixed(2) + ' mm per pixel against a typical ' + step + ' mm stepover.' };
  }

  function refresh() {
    if (!bounds) return;
    const g = Geo.groundSize(bounds);
    const plan = Geo.planSource(bounds, $('source-select').value, resSpec());
    const tooBig = plan.tooLarge || Geo.overCap(plan.grid);

    $('region-info').hidden = false;
    $('source-info').hidden = false;
    $('info-size').textContent = fmtKm(g.widthM) + ' × ' + fmtKm(g.heightM);
    $('info-corners').textContent = fmtDeg({ lat: bounds.north, lng: bounds.west }) + ' to ' + fmtDeg({ lat: bounds.south, lng: bounds.east });
    $('info-grid').textContent = plan.tooLarge ? '–' : plan.grid.width + ' × ' + plan.grid.height + ' px';
    $('info-source').textContent = plan.label + (plan.id === '3dep' && !plan.region ? ' (outside US coverage)' : plan.id === 'canada' && !plan.region ? ' (may extend outside Canada)' : '');
    $('info-res').textContent = plan.resolutionNote;
    $('out-info').hidden = !!plan.tooLarge;
    updateRouteExportInfo();
    if (!plan.tooLarge) {
      const f = plan.resolutionM / plan.outputResM;
      $('out-px').textContent = fmtM(plan.outputResM) + ' per pixel' + (f > 1.05 ? ' (' + f.toFixed(1) + '× finer than source)' : f < 0.95 ? ' (coarser than source)' : ' (source resolution)');
      updateTileNote(plan.grid.width, plan.grid.height);
      const mm = carveLongMm();
      if (mm) {
        const mmPx = mm / Math.max(plan.grid.width, plan.grid.height);
        $('out-carve').textContent = mmPx.toFixed(3) + ' mm per pixel (' + (25.4 / mmPx).toFixed(0) + ' px/in)';
        const longM = Math.max(g.widthM, g.heightM);
        const adv = resolutionAdvice({ carveMm: mm, mmPx, longPx: Math.max(plan.grid.width, plan.grid.height), capPx: Geo.LIMITS.maxSide });
        $('out-advice').textContent = adv.text; $('out-advice').className = 'hint ' + (adv.level === 'warn' ? 'warning' : ''); $('out-advice').hidden = false;
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
  const SPLINE_TOL_M = 0.25;   // how far the straight pieces approximating the curve may stray from it
  let splineSteps = [], splineStepsFor = null;   // smoothing choices (metres), sized from `track`'s point spacing
  function syncSplineUi() {
    if (track !== splineStepsFor) {
      splineStepsFor = track;
      splineSteps = track ? Track.smoothingSteps(track) : [];
      const r = $('spline-smooth');
      r.max = splineSteps.length;
      r.value = Math.min(+r.value, splineSteps.length);
      r.disabled = !splineSteps.length;
    }
    const lvl = +$('spline-smooth').value;
    $('spline-smooth-out').textContent = lvl ? splineSteps[lvl - 1] + ' m' : 'None';
  }
  const splineSigma = () => splineSteps[+$('spline-smooth').value - 1] || 0;
  function shown() {
    if (!track || !$('spline-on').checked) return track;
    syncSplineUi();
    try { return Track.splineTrack(track, SPLINE_TOL_M, splineSigma()); } catch (e) { return track; }
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
    $('pane-clean').hidden = false;
    syncVectorUi();
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
    $('clean-merge').checked = false; $('clean-merge-m').value = 5;
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
    if (elevation && grey) { drawPreview(); if (view === '3d') sync3d(); }
    updateRouteExportInfo();
  }
  $('spline-on').addEventListener('change', splineChanged);
  $('spline-smooth').addEventListener('input', () => { syncSplineUi(); splineChanged(); });
  $('clean-reset').addEventListener('click', () => { setCleanInputs(0, 0); applyClean(); });

  /** A freshly loaded route picks the orientation that suits its shape: a tall route gets the portrait layout, a wide
   *  one landscape. Only a fixed, non-square ratio is turned (Free has no orientation, a square has no other one). */
  function orientToTrack(b) {
    if (!ratio || ratio === 1) return;
    const wantPortrait = Geo.groundRatio(b) < 1;
    if (wantPortrait === (ratio < 1)) return;
    if ($('aspect-select').value === 'custom') setCustom($('aspect-h').value, $('aspect-w').value);
    else { portrait = wantPortrait; relabelAspect(); }
    ratio = readRatio();
  }

  function fitToTrack(autoOrient) {
    const margin = Math.max(0, parseFloat($('track-margin').value) || 0) / 100;
    let b = Track.padBounds(Track.trackBounds(track), margin);
    if (autoOrient) orientToTrack(b);
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
    $('track-name').textContent = filename || 'Route';
    setCleanInputs(0, 0);
    widthTouched = false;
    showTrack();
    applyClean();
    fitToTrack(true);
  }

  $('track-load').addEventListener('click', () => $('track-file').click());
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
    $('track-name').textContent = 'No file loaded';
    ['track-info', 'track-fit', 'track-clear', 'route-guide-wrap', 'pane-clean'].forEach((id) => { $(id).hidden = true; });
    syncVectorUi();
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
    if (!on) setView('map');
    updateViewSwitch();
    syncVectorUi();
  }

  // ---- main view: map or heightmap ------------------------------------------------------------
  let view = 'map';
  function updateViewSwitch() {
    $('view-hm').disabled = !elevation || !!edit.on;
    $('view-3d').disabled = $('view-hm').disabled;
    $('show-hm').disabled = $('view-hm').disabled;
  }
  // ---- 3D terrain ----
  let t3 = null, t3Elev = null;
  function sync3d() {
    const T = window.MapNCTerrain3D;
    if (!t3 && T) t3 = T.create($('t3-canvas'));
    $('t3-msg').hidden = !!t3;
    if (!t3) { $('t3-msg').textContent = 'The 3D view needs WebGL, which this browser does not provide.'; return; }
    if (t3Elev !== elevation) { t3.setElevation(elevation); t3Elev = elevation; }
    $('t3-route').disabled = !track;
    $('t3-route-label').hidden = !track;
    t3.setRoute(track ? Track.toPixels(shown(), elevation.bounds, elevation.width, elevation.height) : null);
    t3.setRouteVisible($('t3-route').checked);
    t3.setExaggeration(parseFloat($('t3-exag').value));
  }
  $('t3-exag').addEventListener('input', () => { $('t3-exag-out').textContent = $('t3-exag').value + '\u00d7'; if (t3) t3.setExaggeration(parseFloat($('t3-exag').value)); });
  $('t3-route').addEventListener('change', () => { if (t3) t3.setRouteVisible($('t3-route').checked); });
  $('t3-reset').addEventListener('click', () => { if (t3) t3.resetView(); });
  function setView(v) {
    if ((v === 'hm' && (!elevation || !grey || edit.on)) || (v === '3d' && (!elevation || edit.on))) v = 'map';
    view = v;
    $('map').hidden = v !== 'map';
    $('hm-view').hidden = v !== 'hm';
    $('t3-view').hidden = v !== '3d';
    $('view-map').setAttribute('aria-pressed', String(v === 'map'));
    $('view-hm').setAttribute('aria-pressed', String(v === 'hm'));
    $('view-3d').setAttribute('aria-pressed', String(v === '3d'));
    if (v === 'hm') drawPreview(); else if (v === '3d') sync3d(); else map.invalidateSize();
  }
  $('view-3d').addEventListener('click', () => setView('3d'));
  $('view-map').addEventListener('click', () => setView('map'));
  $('view-hm').addEventListener('click', () => setView('hm'));
  $('show-hm').addEventListener('click', () => setView('hm'));
  let viewTimer = null;
  window.addEventListener('resize', () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => { if (view === 'hm' && elevation && grey) drawPreview(); }, 150); });
  // Elevation and position under the pointer.
  $('hm-canvas').addEventListener('pointermove', (ev) => {
    const e = elevation, out = $('hm-readout');
    if (!e) return;
    const r = $('hm-canvas').getBoundingClientRect(), s = Math.min(r.width / e.width, r.height / e.height);
    const px = (ev.clientX - r.left - (r.width - e.width * s) / 2) / s, py = (ev.clientY - r.top - (r.height - e.height * s) / 2) / s;
    if (px < 0 || py < 0 || px >= e.width || py >= e.height) { out.hidden = true; return; }
    const v = e.data[Math.floor(py) * e.width + Math.floor(px)], b = e.bounds;
    out.textContent = (v === v ? v.toFixed(1) + ' m' : 'no data') + ' · ' +
      fmtDeg({ lat: b.north - py / e.height * (b.north - b.south), lng: b.west + px / e.width * (b.east - b.west) });
    out.hidden = false;
  });
  $('hm-canvas').addEventListener('pointerleave', () => { $('hm-readout').hidden = true; });

  function showElevationStats() {
    const e = elevation;
    $('res-range').textContent = e.min.toFixed(1) + ' to ' + e.max.toFixed(1) + ' m (' + (e.max - e.min).toFixed(1) + ' m range)';
    $('res-nodata').textContent = e.nodata ? (100 * e.nodata / e.data.length).toFixed(1) + '% (magenta in preview)' : 'none';
  }

  // ---- elevation fixes: fill gaps, flatten lakes, raise a floor ----
  // They edit elevation.data in place and keep undo patches, so unticking restores the original samples without a
  // refetch. Any change undoes all of them and applies the ticked ones again in a fixed order (gaps, lakes, floor), so
  // the result never depends on the order the boxes were ticked. The lake outlines come from OpenStreetMap (cached by osm.js).
  const Lakes = window.MapNCLakes, Fixes = window.MapNCFixes;
  let editState = null;                 // { elevation, patches } while the loaded data carries edits
  let editToken = 0;
  const note = (id, text, bad) => { $(id).textContent = text; $(id).classList.toggle('warning', !!bad); };
  const HINTS = { 'lake-note': $('lake-note').textContent, 'gap-note': $('gap-note').textContent, 'floor-note': $('floor-note').textContent };

  const edits = () => (editState && editState.elevation === elevation ? editState.info : {});

  function elevationChanged() {
    const e = elevation, s = window.MapNCSources.stats(e.data);
    e.min = s.min; e.max = s.max; e.nodata = s.nodata;
    contourDefault();
    showElevationStats();
    recompute();
  }

  function lakeSummary(s) {
    const parts = [s.flattened + ' flattened'];
    if (s.flat) parts.push(s.flat + ' already flat');
    if (s.incomplete) parts.push(s.incomplete + ' skipped (outline incomplete)');
    if (s.tiny) parts.push(s.tiny + ' too small');
    return s.found ? parts.join(', ') + '.' : 'No lakes found in this region.';
  }

  function gapSummary(s) {
    const parts = [];
    if (s.filled) parts.push('Filled ' + s.filled.toLocaleString() + ' pixels in ' + s.gaps + (s.gaps === 1 ? ' gap' : ' gaps'));
    if (s.left) parts.push((s.filled ? 'left ' : 'Left ') + s.leftPixels.toLocaleString() + ' pixels in ' + s.left + ' large ' + (s.left === 1 ? 'area' : 'areas') + ' (too big to guess)');
    return parts.length ? parts.join(', ') + '.' : 'No gaps found.';
  }

  async function syncEdits() {
    const token = ++editToken, e = elevation;
    if (!e) return;
    const hadEdits = !!(editState && editState.elevation === e && editState.patches.length);
    if (hadEdits) Lakes.revert(e.data, editState.patches);
    const state = editState = { elevation: e, patches: [], info: {} };
    let changed = hadEdits;
    const apply = (res) => { state.patches.push(...res.patches); if (res.patches.length) changed = true; return res.summary; };

    if ($('fill-gaps').checked) note('gap-note', gapSummary(state.info.gaps = apply(Fixes.fillGaps(e.data, e.width, e.height))));
    else note('gap-note', HINTS['gap-note']);

    if ($('flatten-lakes').checked) {
      const gs = Geo.groundSize(e.bounds), problem = OSM.areaProblem(Math.max(gs.widthM, gs.heightM), ['lakes']);
      if (problem) note('lake-note', problem, true);
      else {
        note('lake-note', 'Looking up lakes…');
        try {
          const feats = await OSM.fetchFeatures(e.bounds, ['lakes']);
          if (token !== editToken || elevation !== e) return;
          note('lake-note', lakeSummary(state.info.lakes = apply(Lakes.flatten(e.data, e.width, e.height, Lakes.groupLakes(feats, e.bounds, e.width, e.height)))));
        } catch (err) {
          if (token !== editToken || elevation !== e) return;
          note('lake-note', err.message, true);
        }
      }
    } else note('lake-note', HINTS['lake-note']);

    const level = parseFloat($('floor-level').value);
    if ($('raise-floor').checked && !Number.isFinite(level)) note('floor-note', 'Enter a level in metres.', true);
    else if ($('raise-floor').checked) {
      const sum = apply(Fixes.raiseFloor(e.data, level)), n = sum.raised;
      state.info.floor = level;
      note('floor-note', n ? n.toLocaleString() + ' pixels (' + (100 * n / e.data.length).toFixed(1) + '%) raised to ' + level + ' m.' : 'Nothing is below ' + level + ' m.', n === sum.finite);
    } else note('floor-note', HINTS['floor-note']);

    if (changed) elevationChanged();
  }
  for (const id of ['fill-gaps', 'flatten-lakes', 'raise-floor', 'floor-level']) $(id).addEventListener('change', syncEdits);

  function resetResult() {
    editState = null;
    editToken++;
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
    const mb = plan.id !== 'terrarium' ? plan.grid.width * plan.grid.height * 4 / 1048576 : (plan.tiles ? plan.tiles.count * 0.1 : 0);
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
      contourDefault();
      setStatus(e.sourceLabel + ' · ' + e.width + ' × ' + e.height + ' px' + (e.note ? ' — ' + e.note : ''));
      showElevationStats();
      $('result-info').hidden = false;
      showHeightmap(true);
      recompute();
      if (['fill-gaps', 'flatten-lakes', 'raise-floor'].some((id) => $(id).checked)) syncEdits();
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
      border: borderParams(),
    };
  }

  /** The edge border for toGrey, or null when off or the carve size (needed for millimetres) is unknown. */
  function borderParams() {
    const style = $('border-style').value, mm = parseFloat($('border-width').value), longMm = carveLongMm();
    const on = style !== 'none';
    $('border-width-wrap').hidden = $('border-toward-wrap').hidden = !on;
    const bad = on && (!longMm ? 'Set the carve size in step 4 to give the border a width in millimetres.' : !(mm > 0) ? 'Enter a border width in millimetres.' : '');
    const note = $('border-note');
    note.classList.toggle('warning', !!bad);
    if (bad) note.textContent = bad;
    else if (on) {
      const px = elevation ? mm / longMm * Math.max(elevation.width, elevation.height) : 0;
      note.textContent = 'About ' + Math.round(px) + ' pixels wide on the heightmap' + (elevation && px >= Math.min(elevation.width, elevation.height) / 2 ? ' (limited to half the short side).' : '.');
    } else note.textContent = BORDER_HINT;
    if (bad || !on || !elevation) return null;
    return { style, widthPx: mm / longMm * Math.max(elevation.width, elevation.height), toward: $('border-toward').value, widthMm: mm, width: elevation.width, height: elevation.height };
  }
  const BORDER_HINT = $('border-note').textContent;
  $('border-style').addEventListener('change', () => { $('border-toward').value = $('border-style').value === 'rim' ? 'high' : 'low'; borderParams(); recompute(); });
  ['border-width', 'border-toward'].forEach((id) => $(id).addEventListener('input', () => { borderParams(); recompute(); }));
  ['carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', () => { if ($('border-style').value !== 'none' && elevation && grey) recompute(); }));

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
    if (view === '3d') sync3d();
  }

  function scheduleRecompute() { clearTimeout(recomputeTimer); recomputeTimer = setTimeout(recompute, 120); }

  // 8-bit display only: the export is encoded from `grey.data` at full depth.
  function drawPreview() {
    const e = elevation, c = $('hm-canvas');
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
      // Guide line at the route layer's real width (the Line width field, metres on the ground), so it shows how wide
      // the exported line will be against the whole map; never thinner than 1.5 screen pixels so it stays visible. Not part of any export.
      ctx.strokeStyle = '#e11d48';
      const st = $('stage'), shownW = Math.max(100, Math.min(st.clientWidth - 32, (st.clientHeight - 72) * e.width / e.height));
      const gs = Geo.groundSize(e.bounds), pxPerM = Math.max(e.width, e.height) / Math.max(gs.widthM, gs.heightM);
      ctx.lineWidth = Math.max(lineWidthM() * pxPerM, 1.5 * e.width / shownW);
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
  $('route-width').addEventListener('input', () => { widthTouched = true; if (view === 'hm' && elevation && grey) drawPreview(); });

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

  /** The PNG text chunks that describe the heightmap; `bounds` defaults to the whole region (a tile passes its own). */
  function heightmapText(bounds) {
    const b = bounds || elevation.bounds;
    return {
      Software: 'MapNC',
      Source: elevation.sourceLabel,
      Bounds: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(','),
      ElevationWindowM: grey.lo.toFixed(3) + ',' + grey.hi.toFixed(3),
      Exaggeration: String(grey.k),
      MetresPerGreyLevel: grey.metresPerLevel.toPrecision(5) + (grey.curve ? ' (average)' : ''),
      HeightCurve: grey.curve ? grey.curve.kind + ' ' + grey.curve.strength : 'linear',
      Inverted: String($('invert').checked),
      EdgeBorder: grey.border ? grey.border.style + ' ' + grey.border.widthMm + ' mm, toward ' + grey.border.toward : 'none',
      LakesFlattened: String(edits().lakes ? edits().lakes.flattened : 0),
      GapsFilled: String(edits().gaps ? edits().gaps.filled : 0),
      FloorRaisedTo: edits().floor != null ? edits().floor + ' m' : 'none',
    };
  }

  $('export-btn').addEventListener('click', async () => {
    if (!elevation || !grey) return;
    $('export-btn').disabled = true;
    $('export-status').textContent = 'Encoding…';
    try {
      const blob = await HM.encodeGreyStream(elevation.width, elevation.height, grey.bits, grey.data, { pixelsPerMetre: pixelsPerMetre(), onProgress: (f) => { $('export-status').textContent = 'Encoding… ' + Math.round(f * 100) + '%'; }, text: heightmapText() });
      $('export-status').textContent = 'Saved ' + saveBlob(blob, exportFilename()) + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).';
    } catch (err) {
      $('export-status').textContent = 'Export failed: ' + err.message;
    } finally {
      $('export-btn').disabled = false;
    }
  });

  // ---- tile export (one PNG per tile, in a ZIP) --------------------------------------------------
  // Tiles are windows of the finished grid, so they share its pixel size, elevation window and edge border (which
  // lands on the outer edges only). Each tile's PNG records its place; tiles.txt lists where each one goes.

  function updateTileUi() {
    const tp = elevation ? tilePlan(elevation.width, elevation.height) : null;
    $('tile-export').hidden = !(tp && tp.needed);
    if (!tp || !tp.needed) return;
    const k = tp.carveWmm / elevation.width;
    $('tile-route-wrap').hidden = !track;
    $('tile-vectors-wrap').hidden = !(track || ($('vec-contours').checked && !$('vec-contours').disabled) || osmKinds().length);
    $('tile-export-info').textContent = tp.cols + ' × ' + tp.rows + ' tiles of ' + tp.tileW + ' × ' + tp.tileH + ' px (' + fmtLen(tp.tileWmm) + ' × ' + fmtLen(tp.tileHmm) + '), overlapping by at least ' + fmtLen(tp.minOverlapPx * k) + '. All share one elevation window, so the heights match across seams. The ZIP also holds tiles.txt with where each tile goes.';
  }
  ['carve-size', 'carve-unit', 'piece-size', 'tile-overlap'].forEach((id) => $(id).addEventListener('input', updateTileUi));
  $('vec-contours').addEventListener('change', updateTileUi);

  function tilesLayoutText(tp, base, bits) {
    const k = tp.carveWmm / elevation.width, b = elevation.bounds, mm = (v) => (v * k).toFixed(2).padStart(9);
    const rows = tp.tiles.map((t) => t.name.padEnd(6) + String(t.col).padStart(4) + String(t.row).padStart(4) + mm(t.x0) + mm(t.y0) + mm(t.x0 + t.w) + mm(t.y0 + t.h));
    return [
      'MapNC tiles for ' + base,
      '',
      'Region (south, west, north, east): ' + [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(', '),
      'Whole carve: ' + tp.carveWmm.toFixed(2) + ' x ' + tp.carveHmm.toFixed(2) + ' mm (' + elevation.width + ' x ' + elevation.height + ' px, ' + k.toFixed(4) + ' mm per pixel)',
      'Tiles: ' + tp.cols + ' columns x ' + tp.rows + ' rows, each ' + tp.tileW + ' x ' + tp.tileH + ' px (' + tp.tileWmm.toFixed(2) + ' x ' + tp.tileHmm.toFixed(2) + ' mm), ' + bits + '-bit',
      'Overlap between neighbours: at least ' + (tp.minOverlapPx * k).toFixed(2) + ' mm (' + tp.minOverlapPx + ' px)',
      'Elevation window shared by every tile: ' + grey.lo.toFixed(3) + ' to ' + grey.hi.toFixed(3) + ' m, ' + grey.metresPerLevel.toPrecision(5) + ' m per grey level' + (grey.curve ? ' (average; a height curve is on)' : ''),
      grey.border ? 'Edge border (' + grey.border.style + ', ' + grey.border.widthMm + ' mm) is on the outer edges of the whole carve only.' : 'No edge border.',
      '',
      'Where each tile goes, in mm from the top-left (north-west) corner of the whole carve. Rows count from the top, columns from the left.',
      'tile  col row     left      top    right   bottom',
      ...rows,
      '',
      'Import every tile at the same relief depth, so a given grey level is the same height on every piece. Where two tiles overlap they hold the same terrain, so the shared strip lines up when the pieces are placed at these offsets.',
      '',
    ].join('\n');
  }

  let tilesBusy = false;
  $('export-tiles-btn').addEventListener('click', async () => {
    if (!elevation || !grey || tilesBusy) return;
    const tp = tilePlan(elevation.width, elevation.height);
    if (!tp.needed) return;
    const btn = $('export-tiles-btn'), say = (t) => { $('tile-export-status').textContent = t; };
    tilesBusy = true; btn.disabled = true;
    try {
      const W = elevation.width, H = elevation.height, grid = exportGrid(), base = exportBaseName(grid), k = tp.carveWmm / W;
      const gs = Geo.groundSize(elevation.bounds), pm = Math.max(gs.widthM, gs.heightM) / Math.max(W, H);
      const withRoute = !!track && $('tile-route').checked, entries = [];
      let vc = null, vecNote = '';
      if (!$('tile-vectors-wrap').hidden && $('tile-vectors').checked) {
        vc = await vectorContent(grid, say);
        if (vc.stop) { vecNote = ' No vector files: ' + vc.stop; vc = null; }
      }
      for (let i = 0; i < tp.tiles.length; i++) {
        const t = tp.tiles[i], tb = Tiles.tileBounds(elevation.bounds, W, H, t), where = ' (tile ' + (i + 1) + ' of ' + tp.count + ')';
        say('Encoding ' + t.name + where + '…');
        const text = Object.assign(heightmapText(tb), {
          Tile: t.name + ' of ' + tp.cols + 'x' + tp.rows,
          TileOffsetMm: (t.x0 * k).toFixed(3) + ',' + (t.y0 * k).toFixed(3),
          TileOverlapMm: (tp.minOverlapPx * k).toFixed(3),
          WholeBounds: [elevation.bounds.south, elevation.bounds.west, elevation.bounds.north, elevation.bounds.east].map((v) => v.toFixed(6)).join(','),
        });
        const blob = await HM.encodeGreyStream(t.w, t.h, grey.bits, grey.data, { view: { x0: t.x0, y0: t.y0, stride: W }, pixelsPerMetre: pixelsPerMetre(), text });
        entries.push({ name: base + '_' + t.name + '_' + t.w + 'x' + t.h + '_' + grey.bits + 'bit.png', data: blob });
        if (vc) {
          const text = Vec.toDxf(shown(), grid.bounds, grid.W, grid.H, Object.assign({}, vc.o, { window: { x0: t.x0, y0: t.y0, w: t.w, h: t.h } }));
          entries.push({ name: base + '_' + t.name + '_vectors.dxf', data: text });
        }
        if (withRoute) {
          say('Drawing the route for ' + t.name + where + '…');
          entries.push({ name: base + '_' + t.name + '_route.png', data: await routeLayerPng(t.w, t.h, tb, pm, { pixelsPerMetre: pixelsPerMetre(), text: { Tile: t.name + ' of ' + tp.cols + 'x' + tp.rows } }) });
        }
      }
      entries.push({ name: 'tiles.txt', data: tilesLayoutText(tp, base, grey.bits) });
      say('Packing the ZIP…');
      const zip = await Zip.makeZip(entries);
      say('Saved ' + saveBlob(zip, base + '_tiles_' + tp.cols + 'x' + tp.rows + '.zip') + ' (' + tp.count + ' tiles, ' + (zip.size / 1048576).toFixed(1) + ' MB).' + vecNote);
    } catch (err) {
      say('Export failed: ' + err.message);
    } finally {
      tilesBusy = false; btn.disabled = false;
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
    if (edit.on) setView('map');
    updateViewSwitch();
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
    ['clean-spikes', 'clean-spike-m', 'clean-spacing', 'clean-merge', 'clean-merge-m', 'clean-reset'].forEach((id) => { $(id).disabled = locked; });
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
  const Vec = window.MapNCVector, Contours = window.MapNCContours, OSM = window.MapNCOsm;

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
    const mm = carveLongMm();
    $('vec-hint').textContent = mm
      ? 'Units: millimetres of the finished carve (long side ' + mm.toFixed(1) + ' mm). Origin: top-left in the SVG, bottom-left in the DXF. DXF is usually the safer choice for Vectric or Carbide Create; check the size on import.'
      : 'Units: heightmap pixels. Enter a carve size under Output size to export in millimetres.';
    if (!track) { $('layer-info').textContent = 'Load a route to export a route layer.'; return; }
    $('layer-px-wrap').hidden = $('layer-size').value !== 'px';
    const d = layerDims();
    if (!d) { $('layer-info').textContent = 'Draw a region first.'; return; }
    const gb = d.W * d.H * 4 / 1e9;
    $('layer-info').textContent = d.W + ' × ' + d.H + ' px (' + (d.pm >= 1 ? d.pm.toFixed(2) + ' m' : (d.pm * 100).toFixed(d.pm < 0.1 ? 1 : 0) + ' cm') + ' per pixel), line about ' +
      Math.max(1, Math.round(lineWidthM() / d.pm)) + ' px wide.' + (d.clamped ? ' Limited to ' + LAYER_MAX_PX + ' px.' : '') +
      (gb >= 0.25 ? ' Opening it in another program needs about ' + gb.toFixed(1) + ' GB of memory.' : '');
  }

  // ---- contour lines (vector export only; they never change the heightmap) -----------------------------
  const MAX_CONTOUR_LEVELS = 400;
  let contourTouched = false, contourCache = null, contourTimer = null;
  function contourDefault() {
    contourCache = null;
    if (!elevation || contourTouched) return;
    $('contour-m').value = Contours.niceInterval(elevation.max - elevation.min, 15);
  }
  /** Contours for the current elevation and interval, or { error }. Cached until either changes. */
  function contourResult() {
    const iv = parseFloat($('contour-m').value);
    if (!elevation) return { error: 'Waiting for the elevation data.' };
    if (!(iv > 0)) return { error: 'Enter a contour interval.' };
    if ((elevation.max - elevation.min) / iv > MAX_CONTOUR_LEVELS) return { error: 'That would be over ' + MAX_CONTOUR_LEVELS + ' levels. Use a larger interval.' };
    if (!contourCache || contourCache.elevation !== elevation || contourCache.iv !== iv) {
      contourCache = { elevation, iv, result: Contours.contourLines(elevation.data, elevation.width, elevation.height, iv) };
    }
    return contourCache.result;
  }
  function updateContourInfo() {
    clearTimeout(contourTimer);
    if (!$('vec-contours').checked) return;
    const info = $('contour-info');
    info.textContent = elevation ? 'Working…' : 'Waiting for the elevation data.';
    contourTimer = setTimeout(() => {
      const r = contourResult();
      if (r.error) { info.textContent = r.error; return; }
      const n = r.levels.reduce((a, l) => a + l.lines.length, 0), iv = parseFloat($('contour-m').value);
      info.textContent = n
        ? n + ' lines on ' + r.levels.length + ' levels (' + (iv * 3.28084).toFixed(iv * 3.28084 < 10 ? 1 : 0) + ' ft interval).'
        : 'No contours at this interval: the ground is flatter than that.';
    }, 250);
  }
  $('contour-m').addEventListener('input', () => { contourTouched = true; updateContourInfo(); });
  $('vec-contours').addEventListener('change', updateContourInfo);

  /** Shows the layer export once there is a route or elevation; contour controls wait for elevation. */
  function syncVectorUi() {
    $('route-export').hidden = !(track || elevation);
    $('extras-empty').hidden = !$('route-export').hidden;
    $('vec-contours').disabled = !elevation;
    $('contour-need').hidden = !!elevation;
    $('export-route-btn').disabled = !track;
    updateContourInfo();
    updateOsmInfo();
    updateRouteExportInfo();
    updateLayersUi();
    updateStlUi();
    updateTileUi();
  }
  ['layer-size', 'layer-px'].forEach((id) => $(id).addEventListener('input', updateRouteExportInfo));
  $('route-width').addEventListener('input', updateRouteExportInfo);
  ['carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', updateRouteExportInfo));

  // PNG / Vector tabs for the route export.
  (function () {
    const tabs = [['tab-png', 'tabpanel-png'], ['tab-vec', 'tabpanel-vec'], ['tab-layers', 'tabpanel-layers']];
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

  /** The route as a transparent RGBA PNG W x H over `bounds` (pm = metres per pixel), drawn a strip at a time. o: { text, pixelsPerMetre, isCancelled, onProgress }. */
  async function routeLayerPng(W, H, bounds, pm, o) {
    const opts = o || {}, b = bounds;
    const rowsPerBand = Math.max(1, Math.floor(4e6 / W));           // about 4 M pixels per strip
    const br = Track.createBandRasterizer(shown(), b, W, H, lineWidthM() / 2 / pm, 'uniform', rowsPerBand);
    const cover = new Float32Array(W * rowsPerBand), rgba = new Uint8Array(W * rowsPerBand * 4);
    for (let i = 0; i < W * rowsPerBand; i++) { rgba[i * 4] = ROUTE_RGB[0]; rgba[i * 4 + 1] = ROUTE_RGB[1]; rgba[i * 4 + 2] = ROUTE_RGB[2]; }
    return HM.encodePngStream({
      width: W, height: H, channels: 4, rowsPerBand,
      text: Object.assign({ Software: 'MapNC', Bounds: [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(','), RouteWidthM: String(lineWidthM()) }, opts.text),
      pixelsPerMetre: opts.pixelsPerMetre || null, isCancelled: opts.isCancelled, onProgress: opts.onProgress,
      getRows: async (y0, n) => {
        const band = Math.floor(y0 / rowsPerBand);
        if (br.isEmpty(band)) { for (let i = 0; i < W * n; i++) rgba[i * 4 + 3] = 0; }
        else { br.render(band, cover); for (let i = 0; i < W * n; i++) rgba[i * 4 + 3] = Math.round(cover[i] * 255); }
        return rgba.subarray(0, W * n * 4);
      },
    });
  }

  let layerBusy = false, layerCancel = false;
  $('export-route-btn').addEventListener('click', async () => {
    const btn = $('export-route-btn');
    if (layerBusy) { layerCancel = true; routeStatus('Cancelling…'); return; }
    const d = layerDims();
    if (!track || !d) return;
    layerBusy = true; layerCancel = false;
    btn.textContent = 'Cancel';
    try {
      const mm = carveLongMm();
      routeStatus('Drawing route layer… 0%');
      const blob = await routeLayerPng(d.W, d.H, d.bounds, d.pm, {
        pixelsPerMetre: mm ? Math.max(d.W, d.H) / (mm / 1000) : null,
        isCancelled: () => layerCancel,
        onProgress: (f) => routeStatus('Drawing route layer… ' + Math.round(f * 100) + '%'),
      });
      routeStatus('Saved ' + saveBlob(blob, exportBaseName(d) + '_' + d.W + 'x' + d.H + '_route.png') + ' (' + (blob.size / 1048576).toFixed(2) + ' MB).');
    } catch (err) {
      routeStatus(err.name === 'AbortError' ? 'Cancelled.' : 'Export failed: ' + err.message);
    } finally {
      layerBusy = false; layerCancel = false;
      btn.textContent = 'Export route layer (PNG)';
    }
  });


  // ---- OpenStreetMap layers (roads, water, lakes) ----
  const OSM_LAYERS = [
    { id: 'vec-osm-roads', kind: 'roads', name: 'roads', color: '#6b7280', aci: 8, width: 0.8, label: 'main roads' },
    { id: 'vec-osm-minor', kind: 'roads_minor', name: 'roads_minor', color: '#9ca3af', aci: 9, width: 0.4, label: 'minor roads' },
    { id: 'vec-osm-water', kind: 'water', name: 'water', color: '#2b7bba', aci: 4, width: 0.6, label: 'waterways' },
    { id: 'vec-osm-lakes', kind: 'lakes', name: 'lakes', color: '#1d4ed8', aci: 150, width: 0.6, label: 'lakes' },
  ];
  const osmKinds = () => OSM_LAYERS.filter((l) => $(l.id).checked).map((l) => l.kind);
  let osmToken = 0;

  /** Fetches (cached) and projects the ticked OSM layers into the export grid. Returns { layers, counts } or { error }. */
  async function osmLayers(grid) {
    const kinds = osmKinds();
    if (!kinds.length) return { layers: [], counts: {} };
    const gs = Geo.groundSize(grid.bounds), problem = OSM.areaProblem(Math.max(gs.widthM, gs.heightM), kinds);
    if (problem) return { error: problem };
    try {
      const feats = await OSM.fetchFeatures(grid.bounds, kinds);
      const px = OSM.toLayers(feats, grid.bounds, grid.W, grid.H);
      const layers = [], counts = {};
      for (const l of OSM_LAYERS) {
        if (!kinds.includes(l.kind)) continue;
        counts[l.kind] = px[l.kind].length;
        if (px[l.kind].length) layers.push({ name: l.name, color: l.color, aci: l.aci, width: l.width, lines: px[l.kind] });
      }
      return { layers, counts };
    } catch (err) {
      return { error: err.message };
    }
  }
  function osmSummary(r) {
    if (r.error) return r.error;
    return OSM_LAYERS.filter((l) => l.kind in r.counts).map((l) => r.counts[l.kind] + ' ' + l.label).join(', ') + '.';
  }
  /** Shows the credit and, after a short pause, fetches what is ticked so the counts (or the problem) appear right away. */
  let osmTimer = null;
  function updateOsmInfo() {
    clearTimeout(osmTimer);
    const kinds = osmKinds(), info = $('osm-info');
    $('osm-credit').hidden = !kinds.length;
    info.hidden = !kinds.length;
    if (!kinds.length) return;
    const grid = exportGrid();
    if (!grid) { info.textContent = 'Select a region first.'; return; }
    info.textContent = 'Fetching from OpenStreetMap…';
    const token = ++osmToken;
    osmTimer = setTimeout(async () => {
      const r = await osmLayers(grid);
      if (token === osmToken) info.textContent = osmSummary(r);
    }, 400);
  }
  OSM_LAYERS.forEach((l) => $(l.id).addEventListener('change', () => { updateOsmInfo(); updateTileUi(); }));

  let vectorBusy = false;
  /**
   * What a vector export holds, for a heightmap grid: the contour and map layers that are ticked (the route is separate).
   * Returns { layers, parts, osmNote, wantContours, wantOsm, o } with `o` the options for Vec.toSvg/toDxf, or { stop } with
   * why there is nothing to write. `say` shows progress.
   */
  async function vectorContent(grid, say) {
    const wantContours = $('vec-contours').checked && !$('vec-contours').disabled;
    const wantOsm = osmKinds().length > 0;
    if (!track && !wantContours && !wantOsm) return { stop: 'Nothing to export: load a route or turn on contour lines or a map layer.' };
    const layers = [], parts = [];
    if (wantContours) {
      const r = contourResult();
      if (r.error) return { stop: 'Contours: ' + r.error };
      const pick = (idx) => [].concat(...r.levels.filter((l) => l.index === idx).map((l) => l.lines));
      const minor = pick(false), major = pick(true);
      if (minor.length) layers.push({ name: 'contours', color: '#9a6b3c', aci: 30, width: 0.4, lines: minor });
      if (major.length) layers.push({ name: 'contours_index', color: '#5b3a17', aci: 32, width: 0.9, lines: major });
    }
    let osmNote = '';
    if (wantOsm) {
      vectorBusy = true; say('Fetching OpenStreetMap data…');
      const r = await osmLayers(grid);
      vectorBusy = false;
      if (r.error) return { stop: 'OpenStreetMap: ' + r.error };
      layers.push(...r.layers);
      osmNote = ' ' + osmSummary(r);
      for (const l of OSM_LAYERS) if (r.layers.some((x) => x.name === l.name)) parts.push(l.kind === 'water' || l.kind === 'lakes' ? 'water' : 'roads');
      if (!r.layers.length && !track && !wantContours) return { stop: 'OpenStreetMap has nothing of that kind in this region.' };
    }
    const mm = carveLongMm(), gs = Geo.groundSize(grid.bounds), longM = Math.max(gs.widthM, gs.heightM);
    const o = {
      mmPerPx: mm ? mm / Math.max(grid.W, grid.H) : 0,
      lineWidth: mm ? lineWidthM() * (mm / longM) : 0,     // only how thick the SVG line looks; CAM uses the centre line
      marks: $('vec-marks').checked, title: (track && track.name) || 'MapNC', layers,
      credit: wantOsm ? OSM.CREDIT : '',
    };
    return { layers, parts, osmNote, wantContours, wantOsm, o };
  }

  async function vectorExport(kind) {
    if (vectorBusy) return;
    const grid = exportGrid();
    if (!grid) return;
    const c = await vectorContent(grid, routeStatus);
    if (c.stop) { routeStatus(c.stop); return; }
    const { layers, parts, o } = c, mm = carveLongMm();
    const text = kind === 'svg' ? Vec.toSvg(shown(), grid.bounds, grid.W, grid.H, o) : Vec.toDxf(shown(), grid.bounds, grid.W, grid.H, o);
    const blob = new Blob([text], { type: kind === 'svg' ? 'image/svg+xml' : 'application/dxf' });
    const what = [track ? 'route' : '', c.wantContours && layers.some((l) => /^contours/.test(l.name)) ? 'contours' : '']
      .concat(parts.filter((v, i) => parts.indexOf(v) === i)).filter(Boolean).join('-') || 'frame';
    routeStatus('Saved ' + saveBlob(blob, exportBaseName(grid) + '_' + grid.W + 'x' + grid.H + '_' + what + '.' + kind) + ' (' + (blob.size / 1024).toFixed(0) + ' KB, ' + (mm ? 'mm' : 'px') + ').' + c.osmNote);
  }
  $('export-svg-btn').addEventListener('click', () => vectorExport('svg'));
  $('export-dxf-btn').addEventListener('click', () => vectorExport('dxf'));

  // ---- STL mesh export (full-precision terrain for programs that read a mesh) ----------
  const STL = window.MapNCStl;
  function stlPlan() {
    if (!elevation) return { why: 'Waiting for the elevation data.' };
    const mm = carveLongMm();
    if (!mm) return { why: 'Enter a carve size under Output size: the mesh is built at that size.' };
    const relief = parseFloat($('stl-relief').value), base = parseFloat($('stl-base').value), faceted = $('stl-style').value === 'facets';
    if (!(relief > 0)) return { why: 'Enter a relief height.' };
    if (!(base >= 0)) return { why: 'Enter a base thickness (0 or more).' };
    const W = elevation.width, H = elevation.height, k = mm / Math.max(W, H), dims = { relief, base, widthMm: W * k, heightMm: H * k, faceted };
    if (faceted) {
      const facets = Math.round(parseFloat($('stl-facets').value));
      if (!(facets >= 50 && facets <= 200000)) return { why: 'Use between 50 and 200,000 facets.' };
      return Object.assign(dims, { facets, tris: facets, bytes: 84 + 50 * facets });
    }
    const detail = Math.round(parseFloat($('stl-detail').value));
    if (!(detail >= 16)) return { why: 'Use at least 16 points on the long side.' };
    const long = Math.min(Math.max(W, H), Math.min(detail, 2000));
    const w = Math.max(2, Math.round(W >= H ? long : long * W / H)), h = Math.max(2, Math.round(H > W ? long : long * H / W)), tris = STL.triangleCount(w, h);
    return Object.assign(dims, { w, h, tris, bytes: 84 + 50 * tris });
  }
  function updateStlUi() {
    const pl = stlPlan();
    $('stl-detail-wrap').hidden = $('stl-style').value === 'facets';
    $('stl-facets-wrap').hidden = $('stl-style').value !== 'facets';
    $('export-stl-btn').disabled = !!pl.why;
    const size = pl.why ? '' : pl.widthMm.toFixed(1) + ' × ' + pl.heightMm.toFixed(1) + ' mm, ' + (pl.base + pl.relief).toFixed(1) + ' mm tall.';
    $('stl-info').textContent = pl.why || (pl.faceted
      ? 'Up to about ' + pl.facets.toLocaleString() + ' triangles on top (fewer if the ground is simple), ' + (pl.bytes / 1048576).toFixed(1) + ' MB. Points go where the terrain needs them: summits, ridges, valley floors; flat ground gets a few big facets. ' + size
      : pl.w + ' × ' + pl.h + ' points, ' + (pl.tris / 1e6).toFixed(2) + ' million triangles, about ' + (pl.bytes / 1048576).toFixed(0) + ' MB. ' + size);
  }
  ['stl-relief', 'stl-base', 'stl-detail', 'stl-facets', 'carve-size', 'carve-unit'].forEach((id) => $(id).addEventListener('input', updateStlUi));
  $('stl-style').addEventListener('change', updateStlUi);
  $('export-stl-btn').addEventListener('click', () => {
    const pl = stlPlan();
    if (pl.why) { $('export-status').textContent = pl.why; return; }
    const g = HM.toGrey(elevation.data, Object.assign(currentParams(), { bits: 16 }));
    const t = new Float32Array(g.data.length);
    for (let i = 0; i < t.length; i++) t[i] = elevation.data[i] !== elevation.data[i] ? 0 : g.data[i] / g.maxVal;
    const o = { widthMm: pl.widthMm, heightMm: pl.heightMm, reliefMm: pl.relief, baseMm: pl.base };
    let buf, note = '', tag;
    if (pl.faceted) {
      const r = STL.buildFacetedStl(t, elevation.width, elevation.height, Object.assign(o, { target: pl.facets }));
      buf = r.buf; tag = r.triangles + 'tris';
      note = ', worst fit error about ' + r.maxErrMm.toFixed(2) + ' mm of height';
    } else {
      buf = STL.buildStl(STL.resample(t, elevation.width, elevation.height, pl.w, pl.h), pl.w, pl.h, o); tag = pl.w + 'x' + pl.h;
    }
    const name = saveBlob(new Blob([buf], { type: 'model/stl' }), exportBaseName(exportGrid()) + '_' + tag + (pl.faceted ? '_faceted' : '') + '.stl');
    $('export-status').textContent = 'Saved ' + name + ' (' + (buf.byteLength / 1048576).toFixed(1) + ' MB, millimetres, Z up' + note + ').';
  });

  // ---- layered map (a stack of constant-height outlines) -----------------------------------
  /** Plan for the layered export from the inputs, or { why } when something is missing. */
  function layersPlan() {
    if (!elevation) return { why: 'Waiting for the elevation data.' };
    const mm = carveLongMm();
    if (!mm) return { why: 'Enter a carve size under Output size: the layers are cut at that size.' };
    const n = Math.round(parseFloat($('layer-count').value));
    if (!(n >= 2 && n <= 100)) return { why: 'Use between 2 and 100 layers.' };
    const p = currentParams(), range = HM.resolveRange(p.stats, p.rangeMode, p.manualLo, p.manualHi);
    const iv = (range.hi - range.lo) / n, grid = exportGrid();
    return { n, mm, iv, lo: range.lo, hi: range.hi, mmPerPx: mm / Math.max(grid.W, grid.H) };
  }
  function updateLayersUi() {
    const pl = layersPlan();
    $('layers-need').hidden = !pl.why; $('layers-need').textContent = pl.why || '';
    $('layers-svg-btn').disabled = $('layers-dxf-btn').disabled = !!pl.why;
    $('layers-info').textContent = pl.why ? '' : pl.n + ' layers, each about ' + (pl.iv >= 10 ? pl.iv.toFixed(0) : pl.iv.toFixed(1)) + ' m of height (' + pl.lo.toFixed(0) + ' to ' + pl.hi.toFixed(0) + ' m).';
  }
  ['layer-count', 'carve-size', 'carve-unit', 'range-lo', 'range-hi'].forEach((id) => $(id).addEventListener('input', updateLayersUi));
  document.querySelectorAll('input[name="range-mode"]').forEach((r) => r.addEventListener('change', updateLayersUi));
  function layersExport(kind) {
    const pl = layersPlan();
    if (pl.why) { routeStatus(pl.why); return; }
    const grid = exportGrid();
    const levels = Array.from({ length: pl.n }, (_, i) => pl.lo + i * pl.iv);
    const minArea = Math.pow(1 / pl.mmPerPx, 2);       // drop islands under 1 mm square: too small to cut
    const layers = Contours.layerOutlines(elevation.data, grid.W, grid.H, levels, { minArea }).filter((l) => l.rings.length);
    if (!layers.length) { routeStatus('Nothing to cut: the ground is flat across this range.'); return; }
    const o = { mmPerPx: pl.mmPerPx, title: 'MapNC layered map', credit: '' };
    const text = kind === 'svg' ? Vec.toLayersSvg(layers, grid.W, grid.H, o) : Vec.toLayersDxf(layers, grid.W, grid.H, o);
    const blob = new Blob([text], { type: kind === 'svg' ? 'image/svg+xml' : 'application/dxf' });
    routeStatus('Saved ' + saveBlob(blob, exportBaseName(grid) + '_' + layers.length + 'layers.' + kind) + ' (' + (blob.size / 1024).toFixed(0) + ' KB, ' + layers.length + ' layers, mm).');
  }
  $('layers-svg-btn').addEventListener('click', () => layersExport('svg'));
  $('layers-dxf-btn').addEventListener('click', () => layersExport('dxf'));

  $('source-select').addEventListener('change', () => { resetResult(); refresh(); scheduleAutoFetch(); });

  // Collapsible panes behave as an accordion: opening one closes the others. What is open is remembered.
  const panes = Array.from(document.querySelectorAll('details.pane'));
  let restoring = true;
  // Always start on step 1 (its markup is open), so a first-time visitor is walked in from the top.
  const firstOpen = panes.find((d) => d.open);
  if (!window.__MAPNC_FREE_PANES) panes.forEach((d) => { if (d !== firstOpen) d.open = false; });
  setTimeout(() => { restoring = false; }, 0);
  panes.forEach((d) => {
    d.addEventListener('toggle', () => {
      if (restoring) return;
      if (d.open && (d.id === 'pane-export' || d.id === 'pane-extras')) setView('hm');   // exports are about the heightmap, so show it
      if (d.open && !window.__MAPNC_FREE_PANES) panes.forEach((o) => { if (o !== d && o.open) o.open = false; });   // the flag is for tests that need several panes readable at once
      syncRegionLock();
    });
  });
  // The rectangle is only editable while step 1 is open; leaving it locks the region in place.
  function syncRegionLock() { mapEl.classList.toggle('region-locked', !$('pane-region').open); }
  syncRegionLock();

  // Start with the sample route loaded so the whole flow can be tried straight away. "Clear route" removes it;
  // add ?sample=off to the address to start empty.
  if (new URLSearchParams(location.search).get('sample') !== 'off') loadSample();
})();
