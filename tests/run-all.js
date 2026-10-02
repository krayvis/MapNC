/* Runs every offline test script in turn and reports. Usage: node tests/run-all.js [name ...]
 * The live-* scripts talk to the real USGS/AWS services and are NOT run here (see tests/README.md). */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const ALL = ['clean', 'pngtest', 'vec', 'contours', 'marks', 'curve', 'stream', 'hid', 'theme', 'default', 'aspect', 'auto', 'cleanui', 'contourui', 'hmview', 'edit', 'exports', 'smoke5'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
let failed = 0;
for (const name of want) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, name + '.js')], { encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split('\n');
  const pass = lines.filter((l) => /^PASS/.test(l)).length, bad = lines.filter((l) => /^FAIL/.test(l));
  const ok = r.status === 0 && bad.length === 0;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(9) + pass + ' passed, ' + bad.length + ' failed  (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)' + (r.status ? '  exit ' + r.status : ''));
  for (const l of bad) console.log('     ' + l);
  if (!ok && !bad.length) console.log(out.split('\n').slice(-12).map((l) => '     ' + l).join('\n'));
}
console.log(failed ? failed + ' suite(s) failed' : 'all suites passed');
process.exit(failed ? 1 : 0);
