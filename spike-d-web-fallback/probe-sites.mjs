// Runs the Spike D test set: for each site, probe the framing headers and take a full-page
// screenshot; write results.json and RESULTS.md next to this file.
//
//   node spike-d-web-fallback/probe-sites.mjs spike-d-web-fallback/sites.json
//   ALLOW_LOCAL=1 node spike-d-web-fallback/probe-sites.mjs spike-d-web-fallback/sites.local.json   # offline self-test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, screenshot, validateTarget, shutdown, framingVerdict } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const listFile = process.argv[2] || path.join(HERE, 'sites.json');
const sites = JSON.parse(fs.readFileSync(listFile, 'utf8'));
const outBase = path.basename(listFile, '.json').replace(/^sites\.?/, '') || 'results';
const REBUILD = process.argv.includes('--rebuild'); // regenerate the table from results.json without re-fetching
const results = [];

for (const site of REBUILD ? [] : sites) {
  const row = { ...site, probe: null, shot: null };
  process.stderr.write(`${site.name.padEnd(18)} `);
  try { validateTarget(site.url); } catch (e) { row.probe = { error: e.message }; results.push(row); process.stderr.write(`skipped: ${e.message}\n`); continue; }
  try { row.probe = await probe(site.url); } catch (e) { row.probe = { error: e.message.split('\n')[0] }; }
  try { const s = await screenshot(site.url); delete s.file; row.shot = s; } catch (e) { row.shot = { error: e.message.split('\n')[0] }; }
  const p = row.probe, s = row.shot;
  process.stderr.write(`${p.error ? 'probe ERR ' + p.error : (p.frameable ? 'frameable' : 'BLOCKED') + ' (' + p.reason + ')'} | ${s.error ? 'shot ERR ' + s.error : s.width + 'x' + s.height + ' in ' + s.ms + 'ms'}\n`);
  results.push(row);
  if (s.error && /not installed/.test(s.error)) { process.stderr.write('\nStopping: install the browser first, then re-run.\n'); await shutdown(); process.exit(1); }
}

const resultsName = outBase === 'results' ? 'results' : `results.${outBase}`;
if (REBUILD) {
  for (const r of JSON.parse(fs.readFileSync(path.join(HERE, `${resultsName}.json`), 'utf8'))) {
    if (r.probe && !r.probe.error) {
      // re-derive the framing verdict with the current rules from the recorded headers
      const v = framingVerdict({ 'x-frame-options': r.probe.xFrameOptions || '', 'content-security-policy': r.probe.frameAncestors ? 'frame-ancestors ' + r.probe.frameAncestors : '' });
      Object.assign(r.probe, v);
    }
    results.push(r);
  }
}
fs.writeFileSync(path.join(HERE, `${resultsName}.json`), JSON.stringify(results, null, 2));
// A screenshot is "usable" when the page answered 200 and the capture is taller than one screen;
// a one-screen capture is almost always a login wall, consent wall, bot block or empty app shell.
const usable = r => r.shot && !r.shot.error && r.probe && r.probe.status === 200 && r.shot.height > 800;
const md = [
  `# Spike D results — ${new Date().toISOString().slice(0, 10)}`, '',
  `Device profile: iPhone 14 (Playwright descriptor), headless Chromium. Screenshot = full page capped at 12000 px.`, '',
  '| Site | Category | Status | Frameable? | Why | Screenshot | Usable? | Time |', '|---|---|---|---|---|---|---|---|',
  ...results.map(r => {
    const p = r.probe || {}, s = r.shot || {};
    return `| ${r.name} | ${r.category} | ${p.status ?? (p.error ? 'ERR' : '')} | ${p.error ? '—' : p.frameable ? 'yes' : '**no**'} | ${p.error ? p.error : p.reason} | ${s.error ? 'ERR: ' + s.error : s.width + '×' + s.height + (s.title ? ' “' + String(s.title).slice(0, 40) + '”' : '')} | ${usable(r) ? 'yes' : '**suspect**'} | ${s.ms ? s.ms + ' ms' : ''} |`;
  }), '',
  `Frameable: ${results.filter(r => r.probe && r.probe.frameable).length} / ${results.length}. Screenshots captured: ${results.filter(r => r.shot && !r.shot.error).length} / ${results.length}; usable (200 and taller than one screen): ${results.filter(usable).length} / ${results.length}.`,
  '', '"Suspect" captures are one screen tall or a non-200 answer: a bot block (403/401), a login or consent wall, or an app shell that rendered nothing without interaction. Open the PNG in `cache/` to see which.',
];
fs.writeFileSync(path.join(HERE, `${resultsName.toUpperCase()}.md`), md.join('\n') + '\n');
console.log(md.join('\n'));
if (!REBUILD) await shutdown();
