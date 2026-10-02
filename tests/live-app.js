const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
const S = require('./lib.js').OUT;
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(q.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html',gpx:'application/gpx+xml'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8146, async () => {
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: true });
  await ctx.route(/tile\.openstreetmap/, r => r.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(S + '/tile.png') }));
  const pg = await ctx.newPage(); pg.on('pageerror', e => console.log('pageerror', e.message));
  const pref = require('./lib.js').OUT || 'auto';
  await pg.goto('http://localhost:8146/'); await pg.waitForSelector('#track-info:not([hidden])');
  if (pref !== 'auto') { await pg.click('summary:has-text("Advanced")'); await pg.selectOption('#source-select', pref); }
  const t = Date.now();
  const tick = setInterval(async () => { try { console.log(Math.round((Date.now() - t) / 1000) + 's', (await pg.locator('#status').innerText()).replace(/\n/g, ' '), '| err:', (await pg.locator('#fetch-error').innerText()).slice(0, 200)); } catch (e) {} }, 15000);
  pg.on('requestfailed', (r) => { if (/nationalmap|amazonaws/.test(r.url())) console.log('REQFAILED', r.failure().errorText, r.url().slice(0, 60)); });
  await pg.waitForSelector('#hm-section:not([hidden])', { timeout: 240000 }); clearInterval(tick);
  console.log('loaded in', Date.now() - t, 'ms');
  console.log('STATUS:', (await pg.locator('#status').innerText()).replace(/\n/g, ' '));
  console.log('INFO:', (await pg.locator('#result-info').innerText()).replace(/\n+/g, ' | '));
  const [d] = await Promise.all([pg.waitForEvent('download', { timeout: 120000 }), pg.click('#export-btn')]);
  await d.saveAs(S + '/live_' + pref + '.png'); console.log('saved', d.suggestedFilename());
  await b.close(); process.exit(0);
});
