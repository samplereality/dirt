// The bury phase on a phone and a desktop viewport: does the dirt reach its fill line without
// pillars, and how long does it take? Prints the metrics and saves bury-phone.png / bury-desktop.png.
//   target        fill line chosen for the run (fraction of the height)
//   maxMean       highest mean surface during the run (should end within ~2 % of target)
//   maxPeak       tallest column at any moment (never more than ~12 % above target)
//   maxSpike      tallest cliff in rows at any moment (a clump mid-impact; transient)
//   endSpike      tallest cliff once the bury is done (≤ 8 is a rounded surface)
import { serve, launch, PHONE, DESKTOP, OUT, sleep } from './_lib.mjs';
const srv = await serve();
let ok = true;
for (const [label, ctxOpts] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  const b = await launch(ctxOpts);
  await b.page.goto(srv.testPage());
  await b.page.evaluate(() => Dirt.start({ biome: 'garden', debug: false }));
  let st, maxPeak = 0, maxMean = 0, maxSpike = 0, t0 = Date.now(), done = false;
  while (Date.now() - t0 < 60000) {
    await sleep(300);
    st = await b.page.evaluate(() => Dirt.stats());
    maxPeak = Math.max(maxPeak, st.fillPeak); maxMean = Math.max(maxMean, st.fillActual); maxSpike = Math.max(maxSpike, st.spike);
    if (st.phase !== 'burying') { done = true; break; }
  }
  await b.page.screenshot({ path: `${OUT}/bury-${label}.png` });
  const r = { target: +st.fill.toFixed(3), maxMean: +maxMean.toFixed(3), maxPeak: +maxPeak.toFixed(3), maxSpike, endSpike: st.spike, seconds: Math.round((Date.now() - t0) / 1000), done };
  const pass = done && r.maxPeak - r.target <= 0.13 && r.endSpike <= 8;
  ok = ok && pass;
  console.log(label, JSON.stringify(r), pass ? 'PASS' : 'FAIL');
  await b.close();
}
srv.close();
process.exit(ok ? 0 : 1);
