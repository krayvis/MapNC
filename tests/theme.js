const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const root = require('./lib.js').ROOT, S = require('./lib.js').OUT;
const srv = http.createServer((q, r) => { const p = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8126, async () => {
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const tile = fs.readFileSync(S + '/tile.png');
  const attr = async (pg) => pg.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themePref, document.getElementById('theme-btn').textContent]);
  const open = async (scheme) => {
    const ctx = await b.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 700 } });
    await ctx.route('**/tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: tile }));
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto('http://localhost:8126/?sample=off'); await pg.waitForTimeout(600);
    return { ctx, pg, errs };
  };
  // 1. system dark, Auto
  let { ctx, pg, errs } = await open('dark');
  console.log('system dark  ->', await attr(pg));
  // draw a rectangle so panel content shows
  await pg.click('#draw-btn'); const m = await pg.locator('#map').boundingBox();
  await pg.mouse.move(m.x + 300, m.y + 200); await pg.mouse.down(); await pg.mouse.move(m.x + 420, m.y + 300, { steps: 4 }); await pg.mouse.up();
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: S + '/dark.png' });
  // 2. cycle: auto -> light -> dark -> auto
  const seq = [];
  for (let i = 0; i < 3; i++) { await pg.click('#theme-btn'); seq.push(await attr(pg)); }
  console.log('cycle        ->', JSON.stringify(seq));
  // 3. choose Light while system is dark, reload: persists
  await pg.click('#theme-btn');                       // auto -> light
  await pg.reload(); await pg.waitForTimeout(400);
  console.log('light+reload ->', await attr(pg));
  await pg.screenshot({ path: S + '/light.png' });
  // computed colours sanity
  console.log('body bg/fg   ->', await pg.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color, getComputedStyle(document.querySelector('.leaflet-tile-pane')).filter]));
  console.log('errors', errs);
  await ctx.close();
  // 4. system light, Auto, then system flips to dark live
  ({ ctx, pg, errs } = await open('light'));
  console.log('system light ->', await attr(pg));
  await pg.emulateMedia({ colorScheme: 'dark' }); await pg.waitForTimeout(200);
  console.log('flip to dark ->', await attr(pg));
  await b.close(); srv.close();
});
