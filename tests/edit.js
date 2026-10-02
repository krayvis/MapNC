const { chromium } = require('./lib.js').playwright;
const mkTiff = require('./mktiff.js');
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8144, async () => {
  const f = (lon, lat) => 2000 + (lon + 120.66) * 5000 + (lat - 39.59) * 3000;
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true });
  await ctx.route(/tile\.openstreetmap|arcgisonline/, r => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  let reqs = 0;
  await ctx.route('**/elevation.nationalmap.gov/**', async (route) => {
    reqs++; const u = new URL(route.request().url()); const [west, south, east, north] = u.searchParams.get('bbox').split(',').map(Number); const [w, h] = u.searchParams.get('size').split(',').map(Number);
    const arr = new Float32Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) arr[j * w + i] = f(west + (i + .5) / w * (east - west), north - (j + .5) / h * (north - south));
    await route.fulfill({ status: 200, contentType: 'image/tiff', headers: { 'access-control-allow-origin': '*' }, body: mkTiff(arr, w, h) });
  });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  const check = (n, ok, x) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : ''));
  const ready = () => pg.waitForSelector('#result-info:not([hidden])', { timeout: 15000 });
  const mapBox = async () => pg.locator('#map').boundingBox();
  const view = () => pg.evaluate(() => window.MapNC.editView());
  const pts = () => pg.evaluate(() => window.MapNC.track().segments.reduce((n, s) => n + s.length, 0));
  const pt = (seg, idx) => pg.evaluate(([s, i]) => window.MapNC.track().segments[s][i], [seg, idx]);
  const center = () => pg.evaluate(() => { const c = window.MapNC.map.getCenter(); return [c.lat, c.lng]; });
  const gsum = () => pg.evaluate(() => { const g = window.MapNC.grey.data; let s = 0; for (let i = 0; i < g.length; i += 7) s = (s * 31 + g[i]) % 1000000007; return s; });
  const status = () => pg.locator('#edit-status').innerText();
  let MOVING = 2000;
  const goto = async (idx, zoom) => { const p = await pt(0, idx); await pg.evaluate(([la, lo, z]) => { window.MapNC.map.setView([la, lo], z, { animate: false }); }, [p.lat, p.lon, zoom]); await pg.waitForTimeout(250); };
  const abs = async (v) => { const m = await mapBox(); return [m.x + v.x, m.y + v.y]; };
  const drag = async (x0, y0, x1, y1, mods = []) => { for (const k of mods) await pg.keyboard.down(k); await pg.mouse.move(x0, y0); await pg.mouse.down(); await pg.mouse.move(x1, y1, { steps: 8 }); await pg.mouse.up(); for (const k of mods) await pg.keyboard.up(k); await pg.waitForTimeout(150); };
  const click = async (x, y, mods = []) => { for (const k of mods) await pg.keyboard.down(k); await pg.mouse.click(x, y); for (const k of mods) await pg.keyboard.up(k); await pg.waitForTimeout(120); };
  const nearMid = async () => { const v = (await view()).list; const m = await mapBox(); return v.filter(p => p.x > 250 && p.x < 700 && p.y > 250 && p.y < 700); };

  await pg.goto('http://localhost:8144/'); await ready();
  MOVING = await pg.evaluate(() => { const s = window.MapNC.track().segments[0], k = 111320 * Math.cos(39.6 * Math.PI / 180); for (let i = 300; i < s.length - 40; i++) { const a = s[i], c = s[i + 40]; let straight = true; for (let j = i; j < i + 40; j += 4) { if (Math.hypot((s[j + 4].lat - s[j].lat) * 110574, (s[j + 4].lon - s[j].lon) * k) < 4) { straight = false; break; } } if (straight && Math.hypot((c.lat - a.lat) * 110574, (c.lon - a.lon) * k) > 60) return i + 20; } return 1000; });
  console.log('   test centred on point', MOVING);
  await pg.click('summary:has-text("Clean up")');
  const n0 = await pts(), reqs0 = reqs;

  // A. too many points in view at the default zoom
  await pg.click('#edit-toggle');
  check('sidebar switches to the editing view', (await view()).on && await pg.locator('#edit-view').isVisible() && !(await pg.locator('#main-view').isVisible()));
  check('editing view shows the title, Done and the help', await pg.locator('.edit-title').isVisible() && await pg.locator('#edit-done').isVisible() && (await pg.locator('.help li').count()) >= 6);
  check('too many points: hint, no handles', (await view()).list.length === 0 && /Zoom in/.test(await status()), await status());

  // B. zoomed in: handles for exactly the points in view
  await goto(MOVING, 20); let v = await view();
  check('handles shown when zoomed in', v.total > 20 && v.total <= 1500 && v.list.length === v.total, `${v.total} in view`);

  // C. drag a vertex
  const c0 = await center(); let cand = await nearMid(); cand = cand.filter((p, i, a) => a.every((q, j) => i === j || Math.hypot(p.x - q.x, p.y - q.y) > 14));
  const V = cand[0]; const before = await pt(V.seg, V.idx); const [ax, ay] = await abs(V);
  const sum0 = await gsum();
  await drag(ax, ay, ax + 60, ay + 40);
  const after = await pt(V.seg, V.idx);
  const expect = await pg.evaluate(([x, y]) => { const l = window.MapNC.map.containerPointToLatLng([x, y]); return [l.lat, l.lng]; }, [V.x + 60, V.y + 40]);
  check('vertex moved to where it was dropped', Math.abs(after.lat - expect[0]) < 2e-6 && Math.abs(after.lon - expect[1]) < 2e-6, `${(after.lat - before.lat).toExponential(2)}`);
  const c1 = await center(); check('dragging a vertex does not pan the map', Math.abs(c1[0] - c0[0]) < 1e-9 && Math.abs(c1[1] - c0[1]) < 1e-9);
  check('point count unchanged by a move', (await pts()) === n0);
  check('one undo step recorded', (await view()).undo === 1);
  await pg.waitForTimeout(500); check('heightmap route changed after the drop', (await gsum()) !== sum0);
  check('no elevation reload from editing', reqs === reqs0, `${reqs - reqs0} requests`);
  check('clean-up locked, discard offered', await pg.locator('#clean-suggest').isDisabled() && await pg.locator('#edit-discard2').isVisible());

  // D. undo / redo (buttons and keys)
  await pg.click('#edit-undo'); let p1 = await pt(V.seg, V.idx); check('Undo restores the exact point', p1.lat === before.lat && p1.lon === before.lon);
  check('Undo releases the lock when nothing is left', !(await pg.locator('#clean-suggest').isDisabled()) && !(await pg.locator('#edit-discard2').isVisible()));
  await pg.keyboard.press('Control+Shift+Z'); p1 = await pt(V.seg, V.idx); check('Ctrl+Shift+Z redoes', Math.abs(p1.lat - after.lat) < 1e-12);
  await pg.keyboard.press('Control+Z'); p1 = await pt(V.seg, V.idx); check('Ctrl+Z undoes', p1.lat === before.lat);
  await pg.keyboard.press('Control+Y'); p1 = await pt(V.seg, V.idx); check('Ctrl+Y redoes', Math.abs(p1.lat - after.lat) < 1e-12);

  // E. drag the line to add a point
  v = (await view()).list; let pair = null;
  for (let i = 1; i < v.length && !pair; i++) if (v[i].seg === v[i - 1].seg && v[i].idx === v[i - 1].idx + 1 && Math.hypot(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y) > 30 && v[i].x > 250 && v[i].x < 800 && v[i].y > 250 && v[i].y < 800) pair = [v[i - 1], v[i]];
  check('found a long segment to grab', !!pair);
  const mid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }; const [mx, my] = await abs(mid); const nBefore = await pts();
  await drag(mx, my, mx + 25, my - 45);
  check('dragging the line adds exactly one point', (await pts()) === nBefore + 1);
  const ins = await pt(pair[0].seg, pair[0].idx + 1); const dropped = await pg.evaluate(([x, y]) => { const l = window.MapNC.map.containerPointToLatLng([x, y]); return [l.lat, l.lng]; }, [mid.x + 25, mid.y - 45]);
  check('new point sits where the drag ended', Math.abs(ins.lat - dropped[0]) < 3e-6 && Math.abs(ins.lon - dropped[1]) < 3e-6);

  // F. select / delete
  v = (await view()).list; const base = v.find(p => p.x > 300 && p.x < 800 && p.y > 300 && p.y < 800 && v.every(q => q === p || Math.hypot(p.x - q.x, p.y - q.y) > 25));
  const [bx, by] = await abs(base); await click(bx, by); check('click selects a point', /Point \d+ selected/.test(await status()) && !(await pg.locator('#edit-delete').isDisabled()), await status());
  let n1 = await pts(); await pg.keyboard.press('Delete'); check('Delete key removes it', (await pts()) === n1 - 1);
  v = (await view()).list; const run = v.filter(p => p.seg === 0).slice(0, 40); // consecutive points in view
  let r0 = null, r1 = null; for (let i = 0; i + 8 < v.length; i++) if (v[i].seg === v[i + 8].seg && v[i + 8].idx - v[i].idx === 8 && [v[i], v[i + 8]].every(p => p.x > 250 && p.x < 800 && p.y > 250 && p.y < 800) && Math.hypot(v[i].x - v[i + 8].x, v[i].y - v[i + 8].y) > 30) { r0 = v[i]; r1 = v[i + 8]; break; }
  check('found a stretch of 9 points', !!r0);
  const [r0x, r0y] = await abs(r0), [r1x, r1y] = await abs(r1); await click(r0x, r0y); await click(r1x, r1y, ['Shift']);
  check('Shift+click selects the stretch', /9 points selected/.test(await status()), await status());
  n1 = await pts(); await pg.click('#edit-delete'); check('Delete button removes the stretch', (await pts()) === n1 - 9);
  v = (await view()).list; const victim = v.find(p => p.x > 300 && p.x < 800 && p.y > 300 && p.y < 800 && v.every(q => q === p || Math.hypot(p.x - q.x, p.y - q.y) > 25)); const [vx, vy] = await abs(victim);
  n1 = await pts(); await pg.mouse.click(vx, vy, { button: 'right' }); await pg.waitForTimeout(150); check('right-click deletes a point', (await pts()) === n1 - 1);
  const undoCount = (await view()).undo; for (let i = 0; i < undoCount; i++) await pg.keyboard.press('Control+Z');
  check('undoing everything returns the original track', (await pts()) === n0 && !(await pg.locator('#edit-discard2').isVisible()), `${await pts()} points`);

  // G. discard
  v = (await view()).list; const w = v.find(p => p.x > 300 && p.x < 800 && p.y > 300 && p.y < 800); const [wx, wy] = await abs(w); await drag(wx, wy, wx + 30, wy + 30);
  check('edited again', (await view()).undo === 1);
  await pg.click('#edit-discard2'); check('Discard returns to the clean-up result and unlocks', (await pts()) === n0 && !(await pg.locator('#clean-suggest').isDisabled()) && (await view()).undo === 0);

  // H. exports follow the edits
  v = (await view()).list; const x2 = v.find(p => p.x > 300 && p.x < 800 && p.y > 300 && p.y < 800); const [x2x, x2y] = await abs(x2); await click(x2x, x2y); await pg.keyboard.press('Delete');
  const nE = await pts();
  await pg.click('#edit-done'); check('Done returns to the main sidebar', await pg.locator('#main-view').isVisible() && !(await pg.locator('#edit-view').isVisible()));
  check('main sidebar summarises the manual edits', /Manual edits: 1 change/.test(await pg.locator('#edit-summary').innerText()), await pg.locator('#edit-summary').innerText());
  if (!(await pg.locator('#export-dxf-btn').isVisible())) await pg.click('summary:has-text("Export")');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('#export-dxf-btn')]); const dxfPath = S + '/edit.dxf'; await dl.saveAs(dxfPath);
  const nv = (fs.readFileSync(dxfPath, 'utf8').match(/\nVERTEX\n/g) || []).length - 4 - 12;   // minus the 4 border corners and the 12 corner-mark points
  check('DXF export has the edited vertex count', nv === nE, `${nv} vs ${nE}`);
  await pg.click('#edit-toggle');

  // I. map view switcher + display aids
  check('Street is the pressed map view', (await pg.locator('#edit-view [data-base^="Street"]').getAttribute('aria-pressed')) === 'true');
  await pg.click('#edit-view [data-base^="Satellite"]'); await pg.waitForTimeout(300);
  check('satellite view on, button pressed', (await pg.evaluate(() => !!document.querySelector('.leaflet-layer.tiles-photo'))) && (await pg.locator('#edit-view [data-base^="Satellite"]').getAttribute('aria-pressed')) === 'true' && (await pg.locator('#edit-view [data-base^="Street"]').getAttribute('aria-pressed')) === 'false');
  check('layer switcher on the map agrees', await pg.evaluate(() => [...document.querySelectorAll('.leaflet-control-layers-base input')].some(i => i.checked && /Satellite/.test(i.parentElement.textContent))));
  await pg.click('#edit-view [data-base^="Topo"]'); await pg.waitForTimeout(200); check('topo view', (await pg.locator('#edit-view [data-base^="Topo"]').getAttribute('aria-pressed')) === 'true');
  await pg.click('#edit-view [data-base^="Street"]'); await pg.waitForTimeout(200); check('back to street', (await pg.locator('#edit-view [data-base^="Street"]').getAttribute('aria-pressed')) === 'true');
  const lineW = () => pg.evaluate(() => [...document.querySelectorAll('.leaflet-overlay-pane path')].map(p => +p.getAttribute('stroke-width')).filter(w => w === 3 || w === 1.5));
  check('route line is normal weight', (await lineW()).includes(3));
  await pg.check('#edit-thin'); check('thin route line', (await lineW()).includes(1.5) && !(await lineW()).includes(3));
  await pg.uncheck('#edit-thin');
  const dashed = () => pg.evaluate(() => [...document.querySelectorAll('.leaflet-overlay-pane path')].filter(p => p.getAttribute('stroke-dasharray')).length);
  check('original (dashed) shown while edited', (await dashed()) === 1);
  await pg.uncheck('#edit-show-original'); check('original can be hidden', (await dashed()) === 0); await pg.check('#edit-show-original'); check('and shown again', (await dashed()) === 1);
  check('points / length / edits readout', /\d+/.test(await pg.locator('#edit-points').innerText()) && /km/.test(await pg.locator('#edit-length').innerText()) && /change/.test(await pg.locator('#edit-count').innerText()), `${await pg.locator('#edit-points').innerText()} | ${await pg.locator('#edit-length').innerText()} | ${await pg.locator('#edit-count').innerText()}`);

  // J. pan on empty map while editing; and with editing off a vertex drag pans instead
  await goto(MOVING, 20); v = (await view()).list; const cA = await center(); const [px, py] = await abs({ x: 780, y: 850 });
  await drag(px, py, px + 80, py + 60); const cB = await center(); check('empty map still pans in edit mode', Math.hypot(cB[0] - cA[0], cB[1] - cA[1]) > 1e-6);
  await pg.click('#edit-done'); check('edit mode off removes handles', (await view()).list.length === 0 && !(await view()).on);
  await goto(MOVING, 20); const trackBefore = await pg.evaluate(() => JSON.stringify(window.MapNC.track().segments[0].slice(1990, 2010)));
  const cC = await center(); await drag(...(await abs({ x: 650, y: 450 })), ...(await abs({ x: 700, y: 480 })));
  const cD = await center(); check('with editing off, dragging pans and edits nothing', Math.hypot(cD[0] - cC[0], cD[1] - cC[1]) > 1e-7 && trackBefore === await pg.evaluate(() => JSON.stringify(window.MapNC.track().segments[0].slice(1990, 2010))));

  // Esc: first clears a selection, then leaves
  await pg.click('#edit-toggle'); await goto(MOVING, 19); { const vv = (await view()).list.find(p => p.x > 350 && p.x < 650 && p.y > 350 && p.y < 650); const [ex, ey] = await abs(vv); await click(ex, ey); check('selected', !!(await view()).sel); await pg.keyboard.press('Escape'); check('Esc clears the selection first', !(await view()).sel && (await view()).on); await pg.keyboard.press('Escape'); check('second Esc leaves editing', !(await view()).on && await pg.locator('#main-view').isVisible()); }

  // K. touch (synthetic pointer events): a spot that touch grabs but a mouse does not
  await pg.click('#edit-toggle'); await goto(MOVING, 19); v = (await view()).list;
  const spot = await pg.evaluate(() => { const L = window.MapNC.editView().list; for (const q of L) for (let r = 12; r <= 19; r += 1.5) for (let a = 0; a < 360; a += 15) { const x = q.x + r * Math.cos(a * Math.PI / 180), y = q.y + r * Math.sin(a * Math.PI / 180); if (x < 150 || x > 800 || y < 150 || y > 800) continue; const m = window.MapNC.hit(x, y, false), t = window.MapNC.hit(x, y, true); if (!m && t && t.type === 'vertex') return { x, y, seg: t.seg, idx: t.idx }; } return null; });
  check('found a spot only touch can grab', !!spot, JSON.stringify(spot));
  const fire = (type, x, y, pointerType, id = 77) => pg.evaluate(([t, x, y, pt, id]) => { const m = document.getElementById('map'); const r = m.getBoundingClientRect(); m.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: id, pointerType: pt, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: t === 'pointerup' ? 0 : 1 })); }, [type, x, y, pointerType, id]);
  const pre = await pt(spot.seg, spot.idx);
  await fire('pointerdown', spot.x, spot.y, 'mouse'); await fire('pointermove', spot.x + 40, spot.y + 30, 'mouse'); await fire('pointerup', spot.x + 40, spot.y + 30, 'mouse');
  let now = await pt(spot.seg, spot.idx); check('mouse at that spot does not grab the point', now.lat === pre.lat && now.lon === pre.lon);
  await fire('pointerdown', spot.x, spot.y, 'touch'); await fire('pointermove', spot.x + 40, spot.y + 30, 'touch'); await fire('pointerup', spot.x + 40, spot.y + 30, 'touch');
  now = await pt(spot.seg, spot.idx); check('touch at that spot grabs and moves it', now.lat !== pre.lat || now.lon !== pre.lon);
  check('touch drag is one undo step', (await view()).undo >= 1);
  const held = await pt(spot.seg, spot.idx);
  await fire('pointerdown', spot.x + 40, spot.y + 30, 'touch', 77);
  await fire('pointermove', 10, 10, 'touch', 99);                                  // a second finger elsewhere
  const held2 = await pt(spot.seg, spot.idx); await fire('pointerup', spot.x + 40, spot.y + 30, 'touch', 77);
  check('a second pointer does not disturb a drag', held.lat === held2.lat && held.lon === held2.lon);
  await fire('pointerdown', spot.x + 40, spot.y + 30, 'touch', 77); await fire('pointercancel', spot.x + 40, spot.y + 30, 'touch', 77);
  check('pointercancel ends the gesture (no stuck drag)', await (async () => { const before2 = (await view()).undo; await fire('pointerdown', spot.x + 40, spot.y + 30, 'touch', 78); await fire('pointermove', spot.x + 70, spot.y + 40, 'touch', 78); await fire('pointerup', spot.x + 70, spot.y + 40, 'touch', 78); return (await view()).undo > before2; })());

  // L. clearing the route clears the editor
  await pg.click('#edit-done'); await pg.click('#track-clear'); check('Clear route resets the editor', !(await view()).on && (await view()).list.length === 0 && !(await pg.locator('#pane-clean').isVisible()));
  console.log('page errors:', errs); await b.close(); process.exit(0);
});
