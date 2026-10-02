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

  // The selection, always stored as normalized bounds (south/west/north/east).
  let bounds = null;
  let rect = null;
  let handles = [];

  $('cap-text').textContent =
    Geo.LIMITS.maxSide + ' px per side, ' + (Geo.LIMITS.maxSamples / 1e6).toFixed(1) + ' M samples';

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
  }

  function setBounds(b) {
    bounds = b;
    const ll = [[b.south, b.west], [b.north, b.east]];
    if (!rect) rect = L.rectangle(ll, { weight: 2, fillOpacity: 0.12, interactive: false }).addTo(map);
    else rect.setBounds(ll);
    syncHandles();
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
  }

  $('source-select').addEventListener('change', refresh);
})();
