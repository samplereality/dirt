// Spike 0 benchmark: run Dirt over the heavy test page in headless Chromium with iPhone
// emulation and optional CPU throttling, sampling Dirt.stats() until the garden phase.
//
//   node spike-0-core/bench.mjs                # no throttle
//   node spike-0-core/bench.mjs --throttle 4   # 4x CPU slowdown (rough stand-in for a phone)
//   node spike-0-core/bench.mjs --throttle 8 --baseline   # host page alone, no overlay
//   node spike-0-core/bench.mjs --flora vines           # force one flora kind (flowers | vines | bushes)
//   node spike-0-core/bench.mjs --cell 3 --throttle 6 --json out.json --shots ./shots
//
// Headless Chromium on a server is NOT an iPhone; see FINDINGS.md for how to read these numbers.
import { chromium, devices } from 'playwright';
import { createStaticServer } from './serve.mjs';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(Boolean));
const throttle = Number(args.throttle || 1);
const cellSize = Number(args.cell || 4);
const maxDpr = Number(args.dpr || 2);
const flora = args.flora || 'random';
const maxSeconds = Number(args.max || 120);

const server = createStaticServer();
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--enable-gpu-rasterization'] });
const context = await browser.newContext({ ...devices['iPhone 14'] });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

page.on('console', m => { if (m.text().startsWith('[dirt]')) process.stderr.write(m.text() + '\n'); });
await page.goto(`http://localhost:${port}/spike-0-core/test-page.html`, { waitUntil: 'load' });
const dom = await page.evaluate(() => document.querySelectorAll('*').length);
if (args.baseline) {
  // Measure the host page's own frame cost with no overlay, for comparison.
  const base = await page.evaluate(() => new Promise(res => {
    const dts = []; let last = performance.now(), n = 0;
    function f(t) { dts.push(t - last); last = t; if (++n < 300) requestAnimationFrame(f); else res(dts); }
    requestAnimationFrame(f);
  }));
  const sorted = [...base].sort((a, b) => a - b), avg = base.reduce((a, b) => a + b, 0) / base.length;
  console.log(JSON.stringify({ baseline: true, throttle, domNodes: dom, frames: base.length, avgFrameMs: avg, fps: 1000 / avg, p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] }, null, 2));
  await browser.close(); server.close(); process.exit(0);
}
await page.evaluate(([cs, dpr, fl]) => Dirt.start({ debug: true, cellSize: cs, maxDpr: dpr, flora: fl }), [cellSize, maxDpr, flora]);

const samples = [];
const t0 = Date.now();
let phaseTimes = {};
while (Date.now() - t0 < maxSeconds * 1000) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => Dirt.stats());
  if (!st) break;
  samples.push(st);
  if (!phaseTimes[st.phase]) phaseTimes[st.phase] = st.elapsed;
  if (args.shots && samples.length % 5 === 0) await page.screenshot({ path: `${args.shots}/t${Math.round(st.elapsed)}s-${st.phase}.png` });
  process.stderr.write(`${st.elapsed.toFixed(0).padStart(3)}s ${st.phase.padEnd(8)} fps ${st.fps.toFixed(0).padStart(3)} frame ${st.avgFrameMs.toFixed(1)}ms p95 ${st.p95FrameMs.toFixed(1)}ms sim ${st.simMs.toFixed(2)} draw ${st.drawMs.toFixed(2)} dirt ${(st.coverage * 100).toFixed(0)}% green ${(st.greenCoverage * 100).toFixed(0)}% tips ${st.tips}\n`);
  if (st.phase === 'garden' && !st.running) break;
}
const shot = args.shot || null;
if (shot) await page.screenshot({ path: shot });
await browser.close();
server.close();

const byPhase = {};
for (const s of samples) { (byPhase[s.phase] ||= []).push(s); }
const summary = {
  throttle, cellSize, maxDpr, flora: samples.at(-1)?.flora, domNodes: dom, grid: samples.at(-1)?.grid, viewport: samples.at(-1)?.viewport, dpr: samples.at(-1)?.dpr,
  totalSeconds: samples.at(-1)?.elapsed, longFrames: samples.at(-1)?.longFrames, phaseStart: phaseTimes,
  phases: Object.fromEntries(Object.entries(byPhase).map(([p, arr]) => [p, {
    samples: arr.length,
    fpsMin: Math.min(...arr.map(s => s.fps)), fpsMean: arr.reduce((a, s) => a + s.fps, 0) / arr.length,
    p95FrameMsMax: Math.max(...arr.map(s => s.p95FrameMs)),
    simMsMean: arr.reduce((a, s) => a + s.simMs, 0) / arr.length, drawMsMean: arr.reduce((a, s) => a + s.drawMs, 0) / arr.length,
  }])),
};
console.log(JSON.stringify(summary, null, 2));
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ summary, samples }, null, 2));
