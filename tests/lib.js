/* Shared helpers for the test scripts: repo root, a scratch output folder, fixtures, and a Playwright/Chromium loader. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
// Files the tests write (PNG/DXF/SVG exports, screenshots) go here; MAPNC_TEST_OUT keeps them somewhere you choose.
const OUT = process.env.MAPNC_TEST_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'mapnc-test-'));
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(FIXTURES)) fs.copyFileSync(path.join(FIXTURES, f), path.join(OUT, f));

function loadPlaywright() {
  for (const spec of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) {
    try { return require(spec); } catch (e) { /* try the next */ }
  }
  throw new Error('Playwright not found. Run `npm install --no-save playwright` in the repo, then `npx playwright install chromium`.');
}

// CHROMIUM_PATH points at an existing browser (e.g. in a sandbox); otherwise Playwright's own download is used.
const launchOpts = { args: ['--no-sandbox'] };
const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
if (exe) launchOpts.executablePath = exe;

module.exports = { ROOT, OUT, FIXTURES, launchOpts, get playwright() { return loadPlaywright(); } };
