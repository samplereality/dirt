// Extension: two burials → two album cards with thumbnails → forget one → storage cleaned.
// Saves ext-album.png.
import { prepareExtension, launchExtension, serve, OUT, sleep } from './_lib.mjs';
const srv = await serve();
const ext = await launchExtension(prepareExtension('album'));
for (const [q, biome] of [['', 'desert'], ['?biome=forest', 'forest']]) {
  const url = srv.testPage(q);
  const page = await ext.ctx.newPage(); await page.goto(url); await page.bringToFront(); await sleep(500);
  await ext.startOn(url, { debug: true, biome, buryMs: 2500, growMs: 2500 });
  await ext.waitForPhase(url, 'garden', 40); await sleep(1500);
  console.log(biome, 'buried; corner buttons on:', (await ext.stateOf(url)).buttons);
  await page.close();
}
const all = await ext.storage();
const index = all['album:index'] || [];
console.log('index:', JSON.stringify(index.map(e => ({ host: e.host, biome: e.biome, hasThumb: e.hasThumb }))));
console.log('keys:', Object.keys(all).length, JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, JSON.stringify(v).length]))));
const album = await ext.ctx.newPage(); await album.goto(`chrome-extension://${ext.extId}/album.html`); await sleep(1200);
const cards = await album.locator('.card').count(), thumbs = await album.locator('.card img').count();
console.log('album page:', await album.textContent('#count'), '| cards:', cards, '| thumbs:', thumbs);
await album.screenshot({ path: `${OUT}/ext-album.png` });
album.once('dialog', d => d.accept());
await album.locator('.card .danger').first().click(); await sleep(800);
const after = await album.locator('.card').count(), keysAfter = Object.keys(await ext.storage()).length;
console.log('after forget: cards', after, '| keys:', keysAfter);
await ext.close(); srv.close();
const ok = index.length === 2 && cards === 2 && thumbs === 2 && after === 1 && keysAfter === 3;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
