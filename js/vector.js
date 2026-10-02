/* Vector export of the route (SVG and DXF), in the same frame as the heightmap image so it overlays exactly.
 *
 * Frame: the origin is the heightmap's top-left corner in the SVG, and its BOTTOM-left corner in the DXF (CAD and
 * CAM packages put the job origin bottom-left and draw Y up; images and SVG go Y down). Units are millimetres of the
 * finished carve when `mmPerPx` is given (carve size entered), otherwise heightmap pixels.
 *
 * Inputs: track (MapNCTrack), bounds, W/H (heightmap grid), opts { mmPerPx, lineWidth, border, marks, title }.
 * `lineWidth` is in the output units and only affects how the SVG strokes look: CAM software takes the centre line.
 * `track` may be null. opts.layers adds more line layers: [{ name, color, aci, width, lines }], where `lines` are polylines
 * in heightmap pixels (scaled here like the route), `name` becomes the SVG group id and the DXF layer (upper-cased),
 * `aci` is the DXF colour number and `width` multiplies the SVG stroke. opts.credit is a data credit line, written into the SVG <desc> and as a DXF comment.
 */
(function (root) {
  'use strict';
  const Track = root.MapNCTrack || (typeof require !== 'undefined' ? require('./track.js') : null);

  const num = (v) => (Math.round(v * 1000) / 1000).toString();     // 3 decimals, no trailing zeros
  const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /** Polylines [[{x, y}, ...], ...] in output units, y down from the top-left corner. */
  function polylines(track, bounds, W, H, mmPerPx) {
    const k = mmPerPx > 0 ? mmPerPx : 1;
    if (!track) return [];
    return Track.toPixels(track, bounds, W, H).map((seg) => seg.map((p) => ({ x: p.x * k, y: p.y * k })));
  }

  const scaleLines = (lines, mmPerPx) => { const k = mmPerPx > 0 ? mmPerPx : 1; return lines.map((l) => l.map((p) => ({ x: p.x * k, y: p.y * k }))); };
  const layerId = (name) => String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_');

  /** Corner brackets (L shapes) inside the extent, touching the exact corners, so the group's bounding box is the
   *  heightmap's extent. Returned as polylines in output units, y down from the top-left. */
  function cornerMarks(w, h) {
    const L = Math.max(w, h) * 0.04;
    return [
      [{ x: 0, y: L }, { x: 0, y: 0 }, { x: L, y: 0 }],
      [{ x: w - L, y: 0 }, { x: w, y: 0 }, { x: w, y: L }],
      [{ x: w, y: h - L }, { x: w, y: h }, { x: w - L, y: h }],
      [{ x: L, y: h }, { x: 0, y: h }, { x: 0, y: h - L }],
    ];
  }

  function toSvg(track, bounds, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx > 0 ? o.mmPerPx : 1, unit = o.mmPerPx > 0 ? 'mm' : '';
    const w = W * k, h = H * k;
    const sw = o.lineWidth > 0 ? o.lineWidth : Math.max(w, h) / 500;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}${unit}" height="${num(h)}${unit}" viewBox="0 0 ${num(w)} ${num(h)}">`,
      `  <title>${esc(o.title || 'MapNC route')}</title>`,
      `  <desc>Origin top-left, Y down, units ${unit || 'px'}. Same frame as the MapNC heightmap PNG.${o.credit ? ' ' + esc(o.credit) : ''}</desc>`,
    ];
    if (o.border) lines.push(`  <rect id="job-border" x="0" y="0" width="${num(w)}" height="${num(h)}" fill="none" stroke="#2563eb" stroke-width="${num(sw / 4)}"/>`);
    if (o.marks) {
      lines.push(`  <g id="corner-marks" fill="none" stroke="#2563eb" stroke-width="${num(sw / 2)}" stroke-linejoin="miter" stroke-linecap="butt">`);
      for (const seg of cornerMarks(w, h)) lines.push(`    <polyline points="${seg.map((p) => num(p.x) + ',' + num(p.y)).join(' ')}"/>`);
      lines.push('  </g>');
    }
    for (const L of o.layers || []) {
      lines.push(`  <g id="${esc(String(L.name).toLowerCase())}" fill="none" stroke="${esc(L.color || '#555555')}" stroke-width="${num(sw * (L.width || 1))}" stroke-linejoin="round" stroke-linecap="round">`);
      for (const seg of scaleLines(L.lines, o.mmPerPx)) lines.push(`    <polyline points="${seg.map((p) => num(p.x) + ',' + num(p.y)).join(' ')}"/>`);
      lines.push('  </g>');
    }
    if (track) {
      lines.push(`  <g id="route" fill="none" stroke="#e11d48" stroke-width="${num(sw)}" stroke-linejoin="round" stroke-linecap="round">`);
      for (const seg of polylines(track, bounds, W, H, o.mmPerPx)) lines.push(`    <polyline points="${seg.map((p) => num(p.x) + ',' + num(p.y)).join(' ')}"/>`);
      lines.push('  </g>');
    }
    lines.push('</svg>', '');
    return lines.join('\n');
  }

  /**
   * ASCII DXF, AutoCAD R12 (AC1009): the most widely read dialect. Layers: ROUTE (open polylines) and, optionally,
   * any opts.layers, JOB_BORDER (a closed rectangle of the heightmap's extent) and CORNER_MARKS (four L brackets at its corners). Y is flipped so the origin is bottom-left.
   */
  function toDxf(track, bounds, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx > 0 ? o.mmPerPx : 1;
    const w = W * k, h = H * k;
    const out = [];
    const g = (code, value) => { out.push(String(code), String(value)); };
    if (o.credit) g(999, o.credit);
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1); g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0.0); g(0, 'ENDTAB');
    const extra = o.layers || [];
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, (track ? 1 : 0) + extra.length + (o.border ? 1 : 0) + (o.marks ? 1 : 0));
    if (track) { g(0, 'LAYER'); g(2, 'ROUTE'); g(70, 0); g(62, 1); g(6, 'CONTINUOUS'); }
    for (const L of extra) { g(0, 'LAYER'); g(2, layerId(L.name)); g(70, 0); g(62, L.aci || 7); g(6, 'CONTINUOUS'); }
    if (o.border) { g(0, 'LAYER'); g(2, 'JOB_BORDER'); g(70, 0); g(62, 5); g(6, 'CONTINUOUS'); }
    if (o.marks) { g(0, 'LAYER'); g(2, 'CORNER_MARKS'); g(70, 0); g(62, 5); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    const poly = (layer, pts, closed) => {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, closed ? 1 : 0);
      for (const p of pts) { g(0, 'VERTEX'); g(8, layer); g(10, num(p.x)); g(20, num(h - p.y)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    };
    if (o.border) poly('JOB_BORDER', [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true);
    if (o.marks) for (const seg of cornerMarks(w, h)) poly('CORNER_MARKS', seg, false);
    for (const L of extra) for (const seg of scaleLines(L.lines, o.mmPerPx)) poly(layerId(L.name), seg, false);
    for (const seg of polylines(track, bounds, W, H, o.mmPerPx)) poly('ROUTE', seg, false);
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\n') + '\n';
  }

  /**
   * Layered-map sheet (laser cutting): one tile per layer, laid out in a grid on a single sheet so every layer can be
   * cut in one job. `layers` is [{ z, rings }] with rings in heightmap pixels (closed polylines); each layer's rings
   * are its cut lines (outer edge and any holes). Units are millimetres (`opts.mmPerPx` is required). Cut lines are
   * on layer CUT (red); a small label per tile ("1", the layer number) is on layer LABELS (blue), so it can be
   * engraved or left out. Tiles read left to right, top to bottom, layer 1 (lowest) first.
   * Returns { tiles: [{ n, z, x, y }], width, height, text? } via layout(); toLayersSvg/toLayersDxf return the file text.
   */
  function layout(layers, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx, w = W * k, h = H * k, gap = o.gap == null ? 5 : o.gap;
    const n = layers.length, cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * h / w)))), rows = Math.ceil(n / cols);
    const tiles = layers.map((L, i) => ({ n: i + 1, z: L.z, rings: L.rings, x: (i % cols) * (w + gap), y: Math.floor(i / cols) * (h + gap) }));
    return { tiles, w, h, cols, rows, width: cols * w + (cols - 1) * gap, height: rows * h + (rows - 1) * gap };
  }

  function toLayersSvg(layers, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx, L = layout(layers, W, H, o), unit = 'mm';
    const fs = Math.max(2, Math.min(L.w, L.h) * 0.04);
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(L.width)}${unit}" height="${num(L.height)}${unit}" viewBox="0 0 ${num(L.width)} ${num(L.height)}">`,
      `  <title>${esc(o.title || 'MapNC layered map')}</title>`,
      `  <desc>${layers.length} layers, ${num(L.w)} x ${num(L.h)} mm each${o.thickness ? ', ' + o.thickness + ' mm material' : ''}. Cut lines are red, labels blue. Origin top-left, Y down, units mm.${o.credit ? ' ' + esc(o.credit) : ''}</desc>`,
    ];
    for (const t of L.tiles) {
      const d = t.rings.map((r) => 'M' + r.map((p) => num(t.x + p.x * k) + ' ' + num(t.y + p.y * k)).join(' L') + ' Z').join(' ');
      out.push(`  <g id="layer-${String(t.n).padStart(2, '0')}">`);
      out.push(`    <path class="cut" d="${d}" fill="none" stroke="#ff0000" stroke-width="0.1" stroke-linejoin="round"/>`);
      out.push(`    <text class="label" x="${num(t.x + fs * 0.6)}" y="${num(t.y + fs * 1.6)}" font-family="sans-serif" font-size="${num(fs)}" fill="none" stroke="#0000ff" stroke-width="0.1">${t.n}</text>`);
      out.push('  </g>');
    }
    out.push('</svg>', '');
    return out.join('\n');
  }

  function toLayersDxf(layers, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx, L = layout(layers, W, H, o), out = [];
    const g = (code, value) => { out.push(String(code), String(value)); };
    const fs = Math.max(2, Math.min(L.w, L.h) * 0.04);
    if (o.credit) g(999, o.credit);
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1); g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0.0); g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, 2);
    g(0, 'LAYER'); g(2, 'CUT'); g(70, 0); g(62, 1); g(6, 'CONTINUOUS');
    g(0, 'LAYER'); g(2, 'LABELS'); g(70, 0); g(62, 5); g(6, 'CONTINUOUS');
    g(0, 'ENDTAB'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const t of L.tiles) {
      for (const r of t.rings) {
        g(0, 'POLYLINE'); g(8, 'CUT'); g(66, 1); g(70, 1);
        for (const p of r) { g(0, 'VERTEX'); g(8, 'CUT'); g(10, num(t.x + p.x * k)); g(20, num(L.height - (t.y + p.y * k))); g(30, 0); }
        g(0, 'SEQEND'); g(8, 'CUT');
      }
      g(0, 'TEXT'); g(8, 'LABELS'); g(10, num(t.x + fs * 0.6)); g(20, num(L.height - (t.y + fs * 1.6))); g(30, 0); g(40, num(fs)); g(1, t.n);
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\n') + '\n';
  }

  const api = { toSvg, toDxf, toLayersSvg, toLayersDxf, layout, polylines, cornerMarks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCVector = api;
})(typeof self !== 'undefined' ? self : this);
