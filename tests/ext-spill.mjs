// Extension: dirt follows links. Leave page A while it is still burying → page B already has a
// settled layer (45 % of A's fill); back on A the bury resumes; after the garden, C and D get
// 22 % and 10 %, E nothing. Run twice: with the content scripts (allowed site) and without them
// (the background injects on navigation).
import { prepareExtension, launchExtension, serve, sleep } from './_lib.mjs';
const srv = await serve();
let allOk = true;
for (const contentScripts of [true, false]) {
  console.log(contentScripts ? '== content-script path' : '== background-injection path (no content_scripts)');
  const ext = await launchExtension(prepareExtension(contentScripts ? 'spill-cs' : 'spill-bg', { contentScripts }));
  const A = srv.testPage();
  const page = await ext.ctx.newPage(); await page.goto(A); await page.bringToFront(); await sleep(500);
  await ext.startOn(A, { debug: false, biome: 'forest', buryMs: 6000, growMs: 4000 });
  await sleep(1500);
  const a0 = await ext.stateOf(A); console.log('A mid-bury:', JSON.stringify(a0));
  await page.goto(srv.testPage('?p=b')); await sleep(1500);
  const b = await ext.stateOf(srv.testPage('?p=b')); console.log('B (left A mid-bury):', JSON.stringify(b));
  await page.goto(A); await sleep(800);
  const a1 = await ext.stateOf(A); console.log('A again:', JSON.stringify(a1));
  await ext.waitForPhase(A, 'garden', 40); await sleep(1500);
  const rest = [];
  for (const q of ['?p=c', '?p=d', '?p=e']) { await page.goto(srv.testPage(q)); await sleep(1500); rest.push(await ext.stateOf(srv.testPage(q))); }
  console.log('after garden (C, D, E):', JSON.stringify(rest));
  const ratio = (st) => st && st.fill ? st.fill / a0.fill : 0;
  const ok = a0.phase === 'burying' && b.phase === 'garden' && b.flora === 'none' && Math.abs(ratio(b) - 0.45) < 0.03
    && a1.phase === 'burying' && Math.abs(ratio(rest[0]) - 0.22) < 0.03 && Math.abs(ratio(rest[1]) - 0.1) < 0.03 && rest[2].phase === 'idle';
  console.log(ok ? 'PASS' : 'FAIL');
  allOk = allOk && ok;
  await ext.close();
}
srv.close();
process.exit(allOk ? 0 : 1);
