// Run every check in this folder in turn: `node tests/run.mjs` (all), `node tests/run.mjs core`,
// `node tests/run.mjs ext`, or `node tests/run.mjs core-bury ext-spill`. Exit code 1 if any fails.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const all = fs.readdirSync(here).filter(f => /^(core|ext)-.*\.mjs$/.test(f)).sort();
const want = process.argv.slice(2);
const picked = want.length ? all.filter(f => want.some(w => f === w || f === w + '.mjs' || f.startsWith(w + '-'))) : all;
let failed = 0;
for (const f of picked) {
  console.log(`\n### ${f}`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log(`### ${f}: FAILED (exit ${r.status})`); }
}
console.log(`\n${picked.length - failed}/${picked.length} passed`);
process.exit(failed ? 1 : 0);
