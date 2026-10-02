/* Vector export of the route (SVG and DXF), in the same frame as the heightmap image so it overlays exactly.
 *
 * Frame: the origin is the heightmap's top-left corner in the SVG, and its BOTTOM-left corner in the DXF (CAD and
 * CAM packages put the job origin bottom-left and draw Y up; images and SVG go Y down). Units are millimetres of the
 * finished carve when `mmPerPx` is given (carve size entered), otherwise heightmap pixels.
 *
 * Inputs: track (MapNCTrack), bounds, W/H (heightmap grid), opts { mmPerPx, lineWidth, border, title }.
 * `lineWidth` is in the output units and only affects how the SVG strokes look: CAM software takes the centre line.
 */
(function (root) {
  'use strict';
  const Track = root.MapNCTrack || (typeof require !== 'undefined' ? require('./track.js') : null);

  const num = (v) => (Math.round(v * 1000) / 1000).toString();     // 3 decimals, no trailing zeros
  const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  /** Polylines [[{x, y}, ...], ...] in output units, y down from the top-left corner. */
  function polylines(track, bounds, W, H, mmPerPx) {
    const k = mmPerPx > 0 ? mmPerPx : 1;
    return Track.toPixels(track, bounds, W, H).map((seg) => seg.map((p) => ({ x: p.x * k, y: p.y * k })));
  }

  function toSvg(track, bounds, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx > 0 ? o.mmPerPx : 1, unit = o.mmPerPx > 0 ? 'mm' : '';
    const w = W * k, h = H * k;
    const sw = o.lineWidth > 0 ? o.lineWidth : Math.max(w, h) / 500;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}${unit}" height="${num(h)}${unit}" viewBox="0 0 ${num(w)} ${num(h)}">`,
      `  <title>${esc(o.title || 'MapNC route')}</title>`,
      `  <desc>Origin top-left, Y down, units ${unit || 'px'}. Same frame as the MapNC heightmap PNG.</desc>`,
    ];
    if (o.border) lines.push(`  <rect id="job-border" x="0" y="0" width="${num(w)}" height="${num(h)}" fill="none" stroke="#2563eb" stroke-width="${num(sw / 4)}"/>`);
    lines.push(`  <g id="route" fill="none" stroke="#e11d48" stroke-width="${num(sw)}" stroke-linejoin="round" stroke-linecap="round">`);
    for (const seg of polylines(track, bounds, W, H, o.mmPerPx)) lines.push(`    <polyline points="${seg.map((p) => num(p.x) + ',' + num(p.y)).join(' ')}"/>`);
    lines.push('  </g>', '</svg>', '');
    return lines.join('\n');
  }

  /**
   * ASCII DXF, AutoCAD R12 (AC1009): the most widely read dialect. Layers: ROUTE (open polylines) and, optionally,
   * JOB_BORDER (a closed rectangle of the heightmap's extent). Y is flipped so the origin is bottom-left.
   */
  function toDxf(track, bounds, W, H, opts) {
    const o = opts || {}, k = o.mmPerPx > 0 ? o.mmPerPx : 1;
    const w = W * k, h = H * k;
    const out = [];
    const g = (code, value) => { out.push(String(code), String(value)); };
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1); g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0.0); g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, o.border ? 2 : 1);
    g(0, 'LAYER'); g(2, 'ROUTE'); g(70, 0); g(62, 1); g(6, 'CONTINUOUS');
    if (o.border) { g(0, 'LAYER'); g(2, 'JOB_BORDER'); g(70, 0); g(62, 5); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB'); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    const poly = (layer, pts, closed) => {
      g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, closed ? 1 : 0);
      for (const p of pts) { g(0, 'VERTEX'); g(8, layer); g(10, num(p.x)); g(20, num(h - p.y)); g(30, 0); }
      g(0, 'SEQEND'); g(8, layer);
    };
    if (o.border) poly('JOB_BORDER', [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], true);
    for (const seg of polylines(track, bounds, W, H, o.mmPerPx)) poly('ROUTE', seg, false);
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\n') + '\n';
  }

  const api = { toSvg, toDxf, polylines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCVector = api;
})(typeof self !== 'undefined' ? self : this);
