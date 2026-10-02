const { chromium } = require('./lib.js').playwright;
const http = require('http'), fs = require('fs'), path = require('path');
http.createServer((q, r) => { const p = path.join(require('./lib.js').ROOT, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(p, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('Content-Type', {js:'text/javascript',css:'text/css',html:'text/html'}[p.split('.').pop()]||'image/png'); r.end(d); } }); }).listen(8128, async function () {
  const b = await chromium.launch(require('./lib.js').launchOpts);
  const pg = await (await b.newContext()).newPage();
  await pg.goto('http://localhost:8128/?sample=off'); await pg.waitForTimeout(400);
  // every element carrying [hidden] must actually be non-rendered
  console.log('hidden but rendered:', await pg.evaluate(() => [...document.querySelectorAll('[hidden]')].filter(e => e.offsetParent !== null || getComputedStyle(e).display !== 'none').map(e => e.id || e.className)));
  await b.close(); process.exit(0);
});
