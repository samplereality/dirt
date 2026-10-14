// Runs the Spike D test set: for each site, probe the framing headers and take a full-page
// screenshot; write results.json and RESULTS.md next to this file.
//
//   node spike-d-web-fallback/probe-sites.mjs spike-d-web-fallback/sites.json
//   ALLOW_LOCAL=1 node spike-d-web-fallback/probe-sites.mjs spike-d-web-fallback/sites.local.json   # offline self-test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, screenshot, validateTarget, shutdown } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const listFile = process.argv[2] || path.join(HERE, 'sites.json');
const sites = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const outBase = path.basename(listFile, '.json').replace(/^sites\.?/, '') || 'results';
const results = [];

for (const site of sites) {
  const row = { ...site, probe: null, shot: null };
  process.stderr.write(`${site.name.padEnd(18)} `);
  try { validateTarget(site.url); } catch (e) { row.probe = { error: e.message }; results.push(row); process.stderr.write(`skipped: ${e.message}\n`); continue; }
  try { row.probe = await probe(site.url); } catch (e) { row.probe = { error: e.message.split('\n')[0] }; }
  try { const s = await screenshot(site.url); delete s.file; row.shot = s; } catch (e) { row.shot = { error: e.message.split('\n')[0] }; }
  const p = row.probe, s = row.shot;
  process.stderr.write(`${p.error ? 'probe ERR ' + p.error : (p.frameable ? 'frameable' : 'BLOCKED') + ' (' + p.reason + ')'} | ${s.error ? 'shot ERR ' + s.error : s.width + 'x' + s.height + ' in ' + s.ms + 'ms'}\n`);
  results.push(row);
}

const resultsName = outBase === 'results' ? 'results' : `results.${outBase}`;
fs.writeFileSync(path.join(HERE, `${resultsName}.json`), JSON.stringify(results, null, 2));
const md = [
  `# Spike D results — ${new Date().toISOString().slice(0, 10)}`, '',
  `Device profile: iPhone 14 (Playwright descriptor), headless Chromium. Screenshot = full page capped at 12000 px.`, '',
  '| Site | Category | Status | Frameable? | Why | Screenshot | Time |', '|---|---|---|---|---|---|---|',
  ...results.map(r => {
    const p = r.probe || {}, s = r.shot || {};
    return `| ${r.name} | ${r.category} | ${p.status ?? (p.error ? 'ERR' : '')} | ${p.error ? '—' : p.frameable ? 'yes' : '**no**'} | ${p.error ? p.error : p.reason} | ${s.error ? 'ERR: ' + s.error : s.width + '×' + s.height + (s.title ? ' “' + String(s.title).slice(0, 40) + '”' : '')} | ${s.ms ? s.ms + ' ms' : ''} |`;
  }), '',
  `Frameable: ${results.filter(r => r.probe && r.probe.frameable).length} / ${results.length}. Clean screenshots: ${results.filter(r => r.shot && !r.shot.error).length} / ${results.length}.`,
];
fs.writeFileSync(path.join(HERE, `${resultsName.toUpperCase()}.md`), md.join('\n') + '\n');
console.log(md.join('\n'));
await shutdown();
