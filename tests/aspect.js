const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const srv = http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8129, async () => {
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const pg = await (await b.newContext({ viewport: { width: 1300, height: 800 } })).newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('http://localhost:8129/?sample=off'); await pg.waitForTimeout(400);
  await pg.evaluate(() => window.MapNC.map.setView([35.6, -83.45], 10, { animate: false }));
  const st = () => pg.evaluate(() => { const G = window.MapNCGeo, r = window.MapNC.region(); const g = G.groundSize(r); return r ? { ratio: +G.groundRatio(r).toFixed(5), w: Math.round(g.widthM), h: Math.round(g.heightM), n: r.north, s: r.south, e: r.east, w_: r.west } : null; });
  const m = await pg.locator('#map').boundingBox();
  const drag = async (x0, y0, x1, y1) => { await pg.mouse.move(x0, y0); await pg.mouse.down(); await pg.mouse.move(x1, y1, { steps: 8 }); await pg.mouse.up(); await pg.waitForTimeout(100); };
  const handleBoxes = () => pg.evaluate(() => [...document.querySelectorAll('.corner-handle')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; }));
  const moveBox = () => pg.evaluate(() => { const r = document.querySelector('.move-handle').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, getComputedStyle(document.querySelector('.move-handle').parentElement).display]; });
  const check = (name, ok, extra) => console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));

  // 1. lock 1:1, then draw a wide drag
  await pg.selectOption('#aspect-select', '1:1');
  await pg.click('#draw-btn');
  await drag(m.x + 400, m.y + 250, m.x + 800, m.y + 400);
  let s = await st(); check('draw locked 1:1', Math.abs(s.ratio - 1) < 1e-4, JSON.stringify(s));
  check('info shows locked', (await pg.locator('#info-aspect').innerText()).includes('locked'), await pg.locator('#info-aspect').innerText());

  // 2. resize by SE corner, NW stays fixed
  let hb = await handleBoxes(); const se = hb.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  const before = await st();
  await drag(se[0], se[1], se[0] + 60, se[1] + 20);
  s = await st(); check('resize keeps 1:1', Math.abs(s.ratio - 1) < 1e-4, `w ${before.w}->${s.w}`);
  check('opposite corner fixed', Math.abs(s.n - before.n) < 1e-9 && Math.abs(s.w_ - before.w_) < 1e-9);

  // 3. drag SE past NW (flip)
  hb = await handleBoxes(); const nw = hb.reduce((a, c) => (c[0] + c[1] < a[0] + a[1] ? c : a)); const se2 = hb.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  await drag(se2[0], se2[1], nw[0] - 80, nw[1] - 60);
  s = await st(); hb = await handleBoxes();
  const distinct = new Set(hb.map(c => c.join(','))).size;
  check('flip keeps 1:1', Math.abs(s.ratio - 1) < 1e-4, JSON.stringify({ ratio: s.ratio, w: s.w }));
  check('4 distinct handle positions after flip', distinct === 4, JSON.stringify(hb));

  // 4. move (zoom in so the rectangle is comfortably large on screen)
  await pg.evaluate(() => { const r = window.MapNC.region(); window.MapNC.map.setView([(r.north + r.south) / 2, (r.east + r.west) / 2], 12, { animate: false }); });
  await pg.waitForTimeout(200);
  const mv = await moveBox(); const pre = await st();
  await drag(mv[0], mv[1], mv[0] + 120, mv[1] + 70);
  s = await st();
  check('move shifts rectangle', s.e > pre.e && s.s < pre.s, `east ${pre.e.toFixed(4)}->${s.e.toFixed(4)}`);
  check('move keeps ground size', Math.abs(s.w - pre.w) <= 1 && Math.abs(s.h - pre.h) <= 1, `${pre.w}x${pre.h} -> ${s.w}x${s.h}`);
  const mv2 = await moveBox(); hb = await handleBoxes();
  const cx = hb.reduce((a, c) => a + c[0], 0) / 4, cy = hb.reduce((a, c) => a + c[1], 0) / 4;
  check('move handle sits at the centre', Math.abs(mv2[0] - cx) < 3 && Math.abs(mv2[1] - cy) < 3);

  // 5. change ratio keeps area, centre
  const a0 = (await st()); const area0 = a0.w * a0.h;
  await pg.selectOption('#aspect-select', '3:2');
  s = await st(); check('3:2 applied', Math.abs(s.ratio - 1.5) < 1e-4, s.ratio);
  check('area kept', Math.abs(s.w * s.h / area0 - 1) < 0.002, (s.w * s.h / area0).toFixed(4));
  await pg.click('#aspect-swap'); s = await st();
  const optText = () => pg.locator('#aspect-select option:checked').innerText();
  check('rotate -> 2:3 portrait, menu keeps the preset', Math.abs(s.ratio - 2 / 3) < 1e-4 && (await pg.inputValue('#aspect-select')) === '3:2' && /^2:3/.test(await optText()), `${s.ratio} ${await pg.inputValue('#aspect-select')} ${await optText()}`);
  await pg.selectOption('#aspect-select', '4:3'); s = await st();
  check('portrait persists across presets (3:4)', Math.abs(s.ratio - 3 / 4) < 1e-4 && /^3:4/.test(await optText()), `${s.ratio} ${await optText()}`);
  await pg.selectOption('#aspect-select', '5:4'); check('label flips its print sizes too', /^4:5 \(10×8, 20×16\)/.test(await optText()), await optText());
  await pg.click('#aspect-swap'); s = await st(); check('rotate back -> landscape 5:4', Math.abs(s.ratio - 1.25) < 1e-4 && /^5:4/.test(await optText()), `${s.ratio} ${await optText()}`);
  await pg.selectOption('#aspect-select', 'custom'); await pg.fill('#aspect-w', '2'); await pg.fill('#aspect-h', '3'); await pg.press('#aspect-h', 'Tab'); await pg.click('#aspect-swap'); s = await st();
  check('rotate on custom swaps the two numbers', (await pg.inputValue('#aspect-w')) === '3' && (await pg.inputValue('#aspect-h')) === '2' && Math.abs(s.ratio - 1.5) < 1e-4, `${await pg.inputValue('#aspect-w')}:${await pg.inputValue('#aspect-h')}`);
  await pg.fill('#aspect-w', '5'); await pg.fill('#aspect-h', '7'); await pg.press('#aspect-h', 'Tab'); s = await st();
  check('custom 5:7', Math.abs(s.ratio - 5 / 7) < 1e-4, s.ratio);

  // 6. free again leaves shape alone; lock current
  await pg.selectOption('#aspect-select', 'free'); const f = await st(); check('free keeps shape', Math.abs(f.ratio - 5 / 7) < 1e-4);
  await pg.selectOption('#aspect-select', 'current'); check('lock current -> custom', (await pg.inputValue('#aspect-select')) === 'custom' && Math.abs(Number(await pg.inputValue('#aspect-w')) - 5 / 7) < 1e-3, `${await pg.inputValue('#aspect-w')}:${await pg.inputValue('#aspect-h')}`);

  // 7. route fit with lock: grow to ratio, route stays inside
  await pg.selectOption('#aspect-select', '1:1');
  await pg.setInputFiles('#track-file', require('./lib.js').OUT + '/route.gpx'); await pg.waitForSelector('#track-info:not([hidden])');
  s = await st();
  check('track fit locked 1:1', Math.abs(s.ratio - 1) < 1e-4, `${s.w}x${s.h}`);
  check('route inside rectangle', s.s <= 35.54 && s.n >= 35.62 && s.w_ <= -83.5 && s.e >= -83.3);


  // 9. resize from centre with a held modifier
  await pg.click('#clear-btn'); await pg.selectOption('#aspect-select', 'free');
  await pg.evaluate(() => window.MapNC.map.setView([35.6, -83.45], 11, { animate: false }));
  await pg.click('#draw-btn'); await drag(m.x + 500, m.y + 250, m.x + 800, m.y + 450);
  const cen = (r) => ({ lat: (r.north + r.south) / 2, lng: (r.east + r.west) / 2 });
  const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  const R0 = await pg.evaluate(() => window.MapNC.region()); const C0 = cen(R0);
  for (const key of ['Shift', 'Control', 'Meta', 'Alt']) {
    await pg.evaluate(() => window.MapNC.map.setView([35.6, -83.45], 11, { animate: false }));
    let hb2 = await handleBoxes(); const se3 = hb2.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
    await pg.keyboard.down(key);
    await pg.mouse.move(se3[0], se3[1]); await pg.mouse.down(); await pg.mouse.move(se3[0] + 50, se3[1] + 30, { steps: 6 }); await pg.mouse.up();
    await pg.keyboard.up(key); await pg.waitForTimeout(100);
    const R1 = await pg.evaluate(() => window.MapNC.region());
    check(key + ': centre fixed while resizing', same(cen(R1), C0), `size ${(R1.east - R1.west).toFixed(4)} vs ${(R0.east - R0.west).toFixed(4)}`);
    check(key + ': rectangle grew', (R1.east - R1.west) > (R0.east - R0.west) + 1e-4);
    // undo for next round: re-centre on the original box by shrinking back (keep it simple: set via ratio of drag)
    await pg.keyboard.down(key);
    hb2 = await handleBoxes(); const se4 = hb2.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
    await pg.mouse.move(se4[0], se4[1]); await pg.mouse.down(); await pg.mouse.move(se4[0] - 50, se4[1] - 30, { steps: 6 }); await pg.mouse.up();
    await pg.keyboard.up(key); await pg.waitForTimeout(100);
    const R2 = await pg.evaluate(() => window.MapNC.region());
    check(key + ': drag back restores size', Math.abs((R2.east - R2.west) - (R0.east - R0.west)) < 2e-3 && same(cen(R2), C0), `${(R2.east - R2.west).toFixed(4)}`);
  }
  // without a modifier the opposite corner stays fixed (regression)
  { const before = await pg.evaluate(() => window.MapNC.region()); const hb3 = await handleBoxes(); const se5 = hb3.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
    await drag(se5[0], se5[1], se5[0] + 40, se5[1] + 20); const after = await pg.evaluate(() => window.MapNC.region());
    check('no modifier: NW corner fixed', Math.abs(after.north - before.north) < 1e-9 && Math.abs(after.west - before.west) < 1e-9); }
  // modifier + aspect lock
  await pg.selectOption('#aspect-select', '4:3');
  { const hb3 = await handleBoxes(); const nw = hb3.reduce((a, c) => (c[0] + c[1] < a[0] + a[1] ? c : a));
    const before = cen(await pg.evaluate(() => window.MapNC.region()));
    await pg.keyboard.down('Shift'); await pg.mouse.move(nw[0], nw[1]); await pg.mouse.down(); await pg.mouse.move(nw[0] - 40, nw[1] - 40, { steps: 6 }); await pg.mouse.up(); await pg.keyboard.up('Shift'); await pg.waitForTimeout(100);
    const s2 = await st(); check('modifier + 4:3 lock keeps ratio exactly', Math.abs(s2.ratio - 4 / 3) < 1e-4, s2.ratio);
    check('modifier + 4:3 lock keeps centre', same(cen(await pg.evaluate(() => window.MapNC.region())), before)); }
  // pressing the key mid-drag switches mode live
  { await pg.selectOption('#aspect-select', 'free');
    const hb3 = await handleBoxes(); const se6 = hb3.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a)); const before = await pg.evaluate(() => window.MapNC.region());
    await pg.mouse.move(se6[0], se6[1]); await pg.mouse.down(); await pg.mouse.move(se6[0] + 40, se6[1] + 20, { steps: 5 });
    const mid1 = await pg.evaluate(() => window.MapNC.region());
    await pg.keyboard.down('Shift'); await pg.waitForTimeout(80); const mid2 = await pg.evaluate(() => window.MapNC.region());
    await pg.keyboard.up('Shift'); await pg.waitForTimeout(80); const mid3 = await pg.evaluate(() => window.MapNC.region());
    await pg.mouse.up();
    check('key mid-drag: corner mode keeps NW', Math.abs(mid1.north - before.north) < 1e-9);
    check('key mid-drag: Shift switches to centred', same(cen(mid2), cen(before)) && (mid2.east - mid2.west) > (mid1.east - mid1.west));
    check('key mid-drag: release returns to corner mode', Math.abs(mid3.north - before.north) < 1e-9); }
  // drawing with the modifier: press point is the centre
  await pg.click('#clear-btn'); await pg.click('#draw-btn');
  await pg.keyboard.down('Control'); await drag(m.x + 600, m.y + 350, m.x + 700, m.y + 420); await pg.keyboard.up('Control');
  { const r = await pg.evaluate(() => window.MapNC.region()); const mp = await pg.evaluate(() => { const ll = window.MapNC.map.containerPointToLatLng([600 - 320 + 0, 350]); return null; });
    const ctr = await pg.evaluate(() => { const r = window.MapNC.region(); const p = window.MapNC.map.latLngToContainerPoint([(r.north + r.south) / 2, (r.east + r.west) / 2]); return [p.x, p.y]; });
    check('draw with Ctrl: press point becomes centre', Math.abs(ctr[0] - 600) < 1.5 && Math.abs(ctr[1] - 350) < 1.5, JSON.stringify(ctr)); }

  // 8. move handle hidden when tiny on screen
  await pg.click('#track-clear'); await pg.click('#clear-btn');
  await pg.evaluate(() => window.MapNC.map.setView([35.6, -83.45], 5, { animate: false }));
  await pg.click('#draw-btn'); await drag(m.x + 600, m.y + 400, m.x + 640, m.y + 430);
  check('move handle hidden when rect tiny', (await moveBox())[2] === 'none');

  await pg.evaluate(() => window.MapNC.map.setView([35.6, -83.45], 10, { animate: false }));
  await pg.screenshot({ path: require('./lib.js').OUT + '/aspect.png' });
  console.log('page errors:', errs);
  await b.close(); srv.close();
});
