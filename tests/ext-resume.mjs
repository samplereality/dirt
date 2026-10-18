// Extension: leave a page mid-bury, come back; the checkpoint in storage.local must make the
// routine continue from where it was, and the finished garden still lands in the album.
import { prepareExtension, launchExtension, serve, sleep } from './_lib.mjs';
const srv = await serve();
const ext = await launchExtension(prepareExtension('resume'));
const url = srv.testPage();
const page = await ext.ctx.newPage(); await page.goto(url); await page.bringToFront(); await sleep(500);
await ext.clickOn(url);                       // the toolbar click: full-length timings
await sleep(7000);
const mid = await ext.stateOf(url); console.log('mid-bury:', JSON.stringify(mid));
await page.goto(url + '?elsewhere'); await sleep(800);
const all = await ext.storage();
const stored = all['garden:' + new URL(url).origin + new URL(url).pathname];
console.log('stored while away:', JSON.stringify(stored ? { partial: stored.partial, phase: stored.phase } : null));
await page.goto(url); await sleep(1500);
const back = await ext.stateOf(url); console.log('back on the page:', JSON.stringify(back));
const fin = await ext.waitForPhase(url, 'garden', 110);
console.log('finished after resume:', JSON.stringify(fin));
const index = ((await ext.storage())['album:index'] || []).length;
console.log('album entries:', index);
await ext.close(); srv.close();
const ok = mid.phase === 'burying' && stored && stored.partial && back.phase === 'burying' && Math.abs(back.fillActual - mid.fillActual) < 0.08 && index === 1;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
