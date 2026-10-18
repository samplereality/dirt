// A height-only change (address bar) keeps the dirt in place; a rotation replays the scene into
// the new size. Saves resize-height.png and resize-rotate.png.
import { serve, launch, PHONE, OUT } from './_lib.mjs';
const srv = await serve();
const b = await launch(PHONE);
const page = b.page;
await page.goto(srv.testPage());
await page.evaluate(() => Dirt.start({ debug: true, biome: 'trellis', buryMs: 6000, growMs: 6000 }));
await page.waitForFunction(() => Dirt.phase === 'garden', null, { timeout: 60000 });
const before = await page.evaluate(() => Dirt.stats());
await page.setViewportSize({ width: 390, height: 600 }); await page.waitForTimeout(500);
const afterH = await page.evaluate(() => Dirt.stats());
await page.screenshot({ path: `${OUT}/resize-height.png` });
await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(800);
const afterRot = await page.evaluate(() => Dirt.stats());
await page.screenshot({ path: `${OUT}/resize-rotate.png` });
console.log(JSON.stringify({ before: [before.phase, before.viewport, before.sceneOps], afterHeightChange: [afterH.phase, afterH.viewport, afterH.sceneOps], afterRotation: [afterRot.phase, afterRot.viewport, afterRot.sceneOps, +afterRot.fillActual.toFixed(2)] }));
await b.close(); srv.close();
const ok = afterH.phase === 'garden' && afterRot.phase === 'garden' && afterRot.viewport[0] === 844 && afterRot.sceneOps === before.sceneOps;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
