// The share button appears when the garden is done; without a host capture or Web Share it
// downloads a PNG of the garden alone. Saves share-button.png and share-fallback.png.
import fs from 'node:fs';
import { serve, launch, PHONE, OUT, pngSize } from './_lib.mjs';
const srv = await serve();
const b = await launch({ ...PHONE, acceptDownloads: true });
const page = b.page;
await page.goto(srv.testPage());
await page.evaluate(() => Dirt.start({ debug: true, biome: 'hedgerow', buryMs: 4000, growMs: 5000 }));
await page.waitForFunction(() => Dirt.phase === 'garden', null, { timeout: 60000 });
await page.waitForTimeout(600);
const btn = await page.evaluate(() => { const el = document.querySelector('dirt-overlay').shadowRoot.querySelector('.share'); const r = el.getBoundingClientRect(); return { visible: el.classList.contains('on'), x: r.x, y: r.y, w: r.width, h: r.height }; });
console.log('button:', JSON.stringify(btn));
await page.screenshot({ path: `${OUT}/share-button.png` });
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.mouse.click(btn.x + btn.w / 2, btn.y + btn.h / 2)]);
const buf = fs.readFileSync(await dl.path());
const size = pngSize(buf);
fs.writeFileSync(`${OUT}/share-fallback.png`, buf);
console.log('download:', dl.suggestedFilename(), buf.length, 'bytes', `${size.w}x${size.h}`);
await b.close(); srv.close();
const ok = btn.visible && buf.slice(1, 4).toString() === 'PNG' && size.w > 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
