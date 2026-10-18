// Unit check of the sand rule alone (no browser): a 14-row vertical face must crumble into a
// slope within a few ticks, not slide down as a sheet or drop as a piston. Extracts settle()
// from dirt-core.js by its source text.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './_lib.mjs';
const src = fs.readFileSync(path.join(ROOT, 'dirt-core.js'), 'utf8');
const m = src.match(/  function settle\(s\) \{[\s\S]*?\n  \}\n/);
if (!m) throw new Error('settle() not found in dirt-core.js');
const settle = new Function('seedRef', `let seed = seedRef.v; ${m[0]} return function (s) { settle(s); seedRef.v = seed; };`)({ v: 12345 });
const W = 30, H = 24, g = new Uint8Array(W * H);
for (let y = 20; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = 1;   // floor
for (let y = 6; y < 20; y++) for (let x = 15; x < W; x++) g[y * W + x] = 1;   // block with a vertical face at x=15
const s = { grid: g, W, H, targetTop: 0 };
const tops = () => Array.from({ length: W }, (_, x) => { for (let y = 0; y < H; y++) if (g[y * W + x]) return y; return H; });
const steepest = () => { const t = tops(); let m = 0; for (let x = 1; x < W; x++) m = Math.max(m, Math.abs(t[x] - t[x - 1])); return m; };
const show = () => { for (let y = 4; y < 21; y++) { let l = ''; for (let x = 0; x < W; x++) l += g[y * W + x] ? '#' : '.'; console.log(l); } };
console.log('start: steepest step between neighbours', steepest());
for (let t = 1; t <= 15; t++) { settle(s); if (t === 5 || t === 15) console.log(`tick ${t}: steepest step ${steepest()}`); }
show();
const final = steepest();
console.log(final <= 3 ? 'PASS: the face crumbled' : `FAIL: a ${final}-row step still stands after 15 ticks`);
process.exit(final <= 3 ? 0 : 1);
