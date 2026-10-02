/* 3D terrain view: a raw-WebGL renderer for the elevation grid, with the route draped on it. No dependencies.
 *
 * World frame: x east, y up, z south, metres, centred on the region; y is elevation above the grid minimum. The
 * vertical exaggeration is a shader uniform, so changing it never rebuilds the mesh. The mesh is the elevation grid
 * box-averaged down to at most MAX_SIDE samples along its long side. Cells touching no-data are left out (a hole).
 *
 * Controls (pointer events, so mouse and touch behave alike): one pointer rotates (a mouse also pans with the right
 * button, the middle button or Shift); two pointers pinch to zoom and drag to pan; the wheel zooms.
 *
 * create(canvas) returns null when WebGL is missing. Pure helpers (gridFor, metresPerDegree) are exported for tests.
 */
(function (root) {
  'use strict';
  const MAX_SIDE = 512, FOV = 40 * Math.PI / 180;
  const ROUTE_RGB = [0.882, 0.114, 0.282];

  /** Metres per degree of longitude and latitude at `lat`. */
  function metresPerDegree(lat) {
    const r = lat * Math.PI / 180;
    return { lng: 111412.84 * Math.cos(r) - 93.5 * Math.cos(3 * r) + 0.118 * Math.cos(5 * r), lat: 111132.92 - 559.82 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r) };
  }

  /** Box-average the elevation grid by `stride`. Returns { gw, gh, stride, h: Float32Array (NaN = none), min, max }. */
  function reduceGrid(data, W, H, maxSide) {
    const stride = Math.max(1, Math.ceil(Math.max(W, H) / maxSide));
    const gw = Math.floor((W - 1) / stride) + 1, gh = Math.floor((H - 1) / stride) + 1;
    const h = new Float32Array(gw * gh);
    const r = stride / 2;
    let min = Infinity, max = -Infinity;
    for (let j = 0; j < gh; j++) {
      const y0 = Math.max(0, Math.ceil(j * stride - r)), y1 = Math.min(H - 1, Math.floor(j * stride + r));
      for (let i = 0; i < gw; i++) {
        const x0 = Math.max(0, Math.ceil(i * stride - r)), x1 = Math.min(W - 1, Math.floor(i * stride + r));
        let s = 0, n = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = data[y * W + x]; if (v === v) { s += v; n++; } }
        const v = n ? s / n : NaN;
        h[j * gw + i] = v;
        if (v === v) { if (v < min) min = v; if (v > max) max = v; }
      }
    }
    if (min === Infinity) { min = 0; max = 0; }
    return { gw, gh, stride, h, min, max };
  }

  // ---- small matrix helpers (column-major, like GL) ----
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  function perspective(fov, aspect, n, f) {
    const t = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
    return o;
  }
  function lookAt(e, c, up) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }

  const TERRAIN_VS = `
    attribute vec3 aPos; attribute vec2 aSlope; attribute float aT;
    uniform mat4 uVP; uniform float uExag;
    varying vec3 vN; varying float vT;
    void main() {
      vN = normalize(vec3(-aSlope.x * uExag, 1.0, -aSlope.y * uExag));
      vT = aT;
      gl_Position = uVP * vec4(aPos.x, aPos.y * uExag, aPos.z, 1.0);
    }`;
  const TERRAIN_FS = `
    precision mediump float;
    varying vec3 vN; varying float vT;
    vec3 ramp(float t) {
      vec3 a = vec3(0.30, 0.45, 0.25), b = vec3(0.56, 0.63, 0.34), c = vec3(0.72, 0.62, 0.46), d = vec3(0.62, 0.58, 0.55), e = vec3(0.96, 0.96, 0.97);
      if (t < 0.3) return mix(a, b, t / 0.3);
      if (t < 0.6) return mix(b, c, (t - 0.3) / 0.3);
      if (t < 0.85) return mix(c, d, (t - 0.6) / 0.25);
      return mix(d, e, (t - 0.85) / 0.15);
    }
    void main() {
      float lit = max(dot(normalize(vN), normalize(vec3(-0.5, 0.75, -0.45))), 0.0);
      gl_FragColor = vec4(ramp(clamp(vT, 0.0, 1.0)) * (0.32 + 0.78 * lit), 1.0);
    }`;
  const ROUTE_VS = `
    attribute vec3 aPos;
    uniform mat4 uVP; uniform float uExag; uniform float uLift;
    void main() { gl_Position = uVP * vec4(aPos.x, aPos.y * uExag + uLift, aPos.z, 1.0); }`;
  const ROUTE_FS = `
    precision mediump float;
    uniform vec3 uColor;
    void main() { gl_FragColor = vec4(uColor, 1.0); }`;

  function program(gl, vs, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function create(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: true, alpha: true, preserveDrawingBuffer: true }) || canvas.getContext('experimental-webgl'); } catch (e) { gl = null; }
    if (!gl) return null;
    const uint = gl.getExtension('OES_element_index_uint');
    let tp, rp;
    try { tp = program(gl, TERRAIN_VS, TERRAIN_FS); rp = program(gl, ROUTE_VS, ROUTE_FS); } catch (e) { return null; }

    const S = {
      exag: 2, showRoute: true,
      yaw: Math.PI * 0.25, pitch: 0.7, dist: 1, target: [0, 0, 0],
      radius: 1, mesh: null, route: null, drawn: false,
    };
    let dirty = false, raf = 0;

    const buf = () => gl.createBuffer();
    function freeMesh() { if (S.mesh) { gl.deleteBuffer(S.mesh.vb); gl.deleteBuffer(S.mesh.ib); S.mesh = null; } }
    function freeRoute() { if (S.route) { gl.deleteBuffer(S.route.vb); gl.deleteBuffer(S.route.ib); S.route = null; } }

    function resetView() {
      S.yaw = Math.PI * 0.25; S.pitch = 0.7;
      S.dist = S.radius * 2.3; S.target = [0, S.relief * 0.3 * S.exag, 0];
      draw();
    }

    /** elev: { data, width, height, bounds, min, max }. */
    function setElevation(elev) {
      freeMesh(); freeRoute();
      const W = elev.width, H = elev.height, b = elev.bounds;
      const mp = metresPerDegree((b.north + b.south) / 2);
      const Wm = (b.east - b.west) * mp.lng, Hm = (b.north - b.south) * mp.lat;
      const side = uint ? MAX_SIDE : 255;
      const g = reduceGrid(elev.data, W, H, side);
      const { gw, gh, stride, h } = g;
      const sx = Wm / W, sz = Hm / H;                      // metres per source pixel
      const span = Math.max(g.max - g.min, 1e-6);
      const V = new Float32Array(gw * gh * 6);
      const hAt = (i, j) => h[Math.min(gh - 1, Math.max(0, j)) * gw + Math.min(gw - 1, Math.max(0, i))];
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const o = (j * gw + i) * 6, v = h[j * gw + i], ok = v === v;
          V[o] = ((i * stride + 0.5) / W - 0.5) * Wm;
          V[o + 2] = ((j * stride + 0.5) / H - 0.5) * Hm;
          V[o + 1] = ok ? v - g.min : 0;
          let dx = 0, dz = 0;
          if (ok) {
            const l = hAt(i - 1, j), r = hAt(i + 1, j), u = hAt(i, j - 1), d = hAt(i, j + 1);
            const lx = l === l ? l : v, rx = r === r ? r : v, uz = u === u ? u : v, dz2 = d === d ? d : v;
            dx = (rx - lx) / (((r === r ? 1 : 0) + (l === l ? 1 : 0)) * stride * sx || 1);
            dz = (dz2 - uz) / (((d === d ? 1 : 0) + (u === u ? 1 : 0)) * stride * sz || 1);
          }
          V[o + 3] = dx; V[o + 4] = dz; V[o + 5] = ok ? (v - g.min) / span : -1;
        }
      }
      const idx = [];
      for (let j = 0; j < gh - 1; j++) for (let i = 0; i < gw - 1; i++) {
        const a = j * gw + i, bb = a + 1, c = a + gw, d = c + 1;
        if (h[a] !== h[a] || h[bb] !== h[bb] || h[c] !== h[c] || h[d] !== h[d]) continue;
        idx.push(a, c, bb, bb, c, d);
      }
      const I = uint ? new Uint32Array(idx) : new Uint16Array(idx);
      const vb = buf(), ib = buf();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, V, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
      S.mesh = { vb, ib, count: I.length, type: uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
      S.grid = g; S.W = W; S.H = H; S.Wm = Wm; S.Hm = Hm; S.relief = g.max - g.min;
      S.radius = 0.5 * Math.hypot(Wm, Hm);
      S.cellM = Math.min(stride * sx, stride * sz);
      resetView();
    }

    /** Terrain height (metres above the grid minimum) at fractional mesh coordinates, or NaN. */
    function sample(gi, gj) {
      const { gw, gh, h } = S.grid;
      if (gi < 0 || gj < 0 || gi > gw - 1 || gj > gh - 1) return NaN;
      const i0 = Math.min(gw - 2, Math.floor(gi)), j0 = Math.min(gh - 2, Math.floor(gj));
      const fx = gi - i0, fy = gj - j0;
      const a = h[j0 * gw + i0], b = h[j0 * gw + i0 + 1], c = h[(j0 + 1) * gw + i0], d = h[(j0 + 1) * gw + i0 + 1];
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy - S.grid.min;
    }

    /** lines: [[{x, y}]] in source-pixel coordinates (the frame of Track.toPixels). Drawn as a flat ribbon on the surface. */
    function setRoute(lines) {
      freeRoute();
      if (!S.mesh || !lines || !lines.length) { draw(); return; }
      const { stride } = S.grid;
      const width = Math.max(S.Wm, S.Hm) * 0.004, step = Math.max(S.cellM * 0.7, 1e-3);
      const V = [], I = [];
      for (const line of lines) {
        // densify in world metres so the ribbon follows the mesh between its vertices
        const pts = [];
        const w = (p) => ({ x: (p.x / S.W - 0.5) * S.Wm, z: (p.y / S.H - 0.5) * S.Hm, gi: (p.x - 0.5) / stride, gj: (p.y - 0.5) / stride });
        for (let k = 0; k < line.length; k++) {
          const q = w(line[k]);
          if (k) {
            const p = pts[pts.length - 1], n = Math.min(2000, Math.floor(Math.hypot(q.x - p.x, q.z - p.z) / step));
            for (let m = 1; m <= n; m++) { const t = m / (n + 1); pts.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, gi: p.gi + (q.gi - p.gi) * t, gj: p.gj + (q.gj - p.gj) * t }); }
          }
          pts.push(q);
        }
        // split where the surface has no data
        let run = [];
        const flush = () => {
          if (run.length >= 2) {
            const base = V.length / 3;
            for (let k = 0; k < run.length; k++) {
              const a = run[Math.max(0, k - 1)], c = run[Math.min(run.length - 1, k + 1)];
              let dx = c.x - a.x, dz = c.z - a.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
              const nx = -dz * width / 2, nz = dx * width / 2, p = run[k];
              V.push(p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz);
              if (k) { const o = base + (k - 1) * 2; I.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
            }
          }
          run = [];
        };
        for (const p of pts) { const y = sample(p.gi, p.gj); if (y === y) { p.y = y; run.push(p); } else flush(); }
        flush();
      }
      if (V.length) {
        const vb = buf(), ib = buf(), Iarr = uint ? new Uint32Array(I) : new Uint16Array(I);
        if (!uint && V.length / 3 > 65535) { draw(); return; }
        gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(V), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Iarr, gl.STATIC_DRAW);
        S.route = { vb, ib, count: Iarr.length, type: uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, width };
      }
      draw();
    }

    function camera() {
      const cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
      const eye = [S.target[0] + S.dist * cp * Math.sin(S.yaw), S.target[1] + S.dist * sp, S.target[2] + S.dist * cp * Math.cos(S.yaw)];
      const asp = canvas.width / Math.max(1, canvas.height);
      return mul(perspective(FOV, asp, Math.max(S.radius * 0.005, S.dist * 0.01), S.radius * 40), lookAt(eye, S.target, [0, 1, 0]));
    }

    function render() {
      dirty = false; raf = 0;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!S.mesh) return;
      gl.enable(gl.DEPTH_TEST);
      const vp = camera();
      gl.useProgram(tp);
      gl.uniformMatrix4fv(gl.getUniformLocation(tp, 'uVP'), false, vp);
      gl.uniform1f(gl.getUniformLocation(tp, 'uExag'), S.exag);
      gl.bindBuffer(gl.ARRAY_BUFFER, S.mesh.vb); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.mesh.ib);
      const at = (p, n, size, stride, off) => { const l = gl.getAttribLocation(p, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off); };
      at(tp, 'aPos', 3, 24, 0); at(tp, 'aSlope', 2, 24, 12); at(tp, 'aT', 1, 24, 20);
      gl.drawElements(gl.TRIANGLES, S.mesh.count, S.mesh.type, 0);
      gl.disableVertexAttribArray(gl.getAttribLocation(tp, 'aSlope')); gl.disableVertexAttribArray(gl.getAttribLocation(tp, 'aT'));
      if (S.route && S.showRoute) {
        gl.useProgram(rp);
        gl.uniformMatrix4fv(gl.getUniformLocation(rp, 'uVP'), false, vp);
        gl.uniform1f(gl.getUniformLocation(rp, 'uExag'), S.exag);
        gl.uniform1f(gl.getUniformLocation(rp, 'uLift'), S.route.width * 0.8 + S.cellM * 0.15 * S.exag);
        gl.uniform3fv(gl.getUniformLocation(rp, 'uColor'), ROUTE_RGB);
        gl.bindBuffer(gl.ARRAY_BUFFER, S.route.vb); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, S.route.ib);
        const l = gl.getAttribLocation(rp, 'aPos'); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 12, 0);
        gl.drawElements(gl.TRIANGLES, S.route.count, S.route.type, 0);
      }
      S.drawn = true;
    }
    function draw() { dirty = true; if (!raf) raf = requestAnimationFrame(render); }

    // ---- input ----
    canvas.style.touchAction = 'none';
    const ptrs = new Map();
    let last = null;                                   // { x, y } for one pointer, { d, x, y } for two
    const mid = () => { const a = [...ptrs.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; };
    function pan(dx, dy) {
      const k = 2 * S.dist * Math.tan(FOV / 2) / Math.max(1, canvas.clientHeight);
      const rx = Math.cos(S.yaw), rz = -Math.sin(S.yaw);                 // screen-right on the ground
      const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);                // ground direction pointing away from the camera
      S.target[0] += (-dx * rx + dy * fx / Math.max(0.2, Math.sin(S.pitch))) * k;
      S.target[2] += (-dx * rz + dy * fz / Math.max(0.2, Math.sin(S.pitch))) * k;
      const lim = S.radius;
      S.target[0] = Math.max(-lim, Math.min(lim, S.target[0])); S.target[2] = Math.max(-lim, Math.min(lim, S.target[2]));
    }
    const zoom = (f) => { S.dist = Math.max(S.radius * 0.05, Math.min(S.radius * 12, S.dist * f)); };
    canvas.addEventListener('pointerdown', (ev) => {
      canvas.setPointerCapture(ev.pointerId);
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, panMode: ev.button === 2 || ev.button === 1 || ev.shiftKey });
      last = ptrs.size === 2 ? mid() : { x: ev.clientX, y: ev.clientY };
      ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      const p = ptrs.get(ev.pointerId);
      if (!p) return;
      const px = p.x, py = p.y;
      p.x = ev.clientX; p.y = ev.clientY;
      if (ptrs.size === 1) {
        const dx = p.x - px, dy = p.y - py;
        if (p.panMode) pan(dx, dy);
        else { S.yaw -= dx * 0.008; S.pitch = Math.max(0.05, Math.min(1.5, S.pitch + dy * 0.008)); }
      } else if (ptrs.size === 2) {
        const m = mid();
        if (last && last.d > 0 && m.d > 0) zoom(last.d / m.d);
        if (last) pan(m.x - last.x, m.y - last.y);
        last = m;
      }
      draw();
    });
    const up = (ev) => {
      ptrs.delete(ev.pointerId);
      last = ptrs.size === 2 ? mid() : ptrs.size === 1 ? { x: [...ptrs.values()][0].x, y: [...ptrs.values()][0].y } : null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); zoom(Math.exp(ev.deltaY * 0.0015)); draw(); }, { passive: false });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(draw).observe(canvas);

    return {
      setElevation, setRoute, resetView, draw,
      setExaggeration(v) { S.exag = v; draw(); },
      setRouteVisible(on) { S.showRoute = !!on; draw(); },
      get state() { return { exag: S.exag, yaw: S.yaw, pitch: S.pitch, dist: S.dist, target: S.target.slice(), mesh: !!S.mesh, route: !!S.route, triangles: S.mesh ? S.mesh.count / 3 : 0, grid: S.grid ? [S.grid.gw, S.grid.gh] : null }; },
    };
  }

  const api = { create, reduceGrid, metresPerDegree };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MapNCTerrain3D = api;
})(typeof self !== 'undefined' ? self : this);
