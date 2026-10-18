// Extension: bury through the click path, then reload; the garden must come back with no click
// (autorestore.js content script on an allowed site). Saves ext-autorestore.png.
import { prepareExtension, launchExtension, serve, OUT, sleep } from './_lib.mjs';
const srv = await serve();
const ext = await launchExtension(prepareExtension('autorestore'));
const url = srv.testPage();
const page = await ext.ctx.newPage(); await page.goto(url); await page.bringToFront(); await sleep(800);
console.log('fresh page:', JSON.stringify(await ext.stateOf(url)));
await ext.startOn(url, { debug: false, biome: 'meadow', buryMs: 2500, growMs: 2500 });
await ext.waitForPhase(url, 'garden', 40); await sleep(1500);
const keys = Object.keys(await ext.storage()).sort();
console.log('storage keys after the garden:', keys);
const page2 = await ext.ctx.newPage(); await page2.goto(url); await sleep(1500); await page.close();
const back = await ext.stateOf(url);
console.log('after reload, no click:', JSON.stringify(back));
await page2.screenshot({ path: `${OUT}/ext-autorestore.png` });
await ext.close(); srv.close();
const ok = back.phase === 'garden' && back.biome === 'meadow' && keys.some(k => k.startsWith('garden:')) && keys.some(k => k.startsWith('thumb:'));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
