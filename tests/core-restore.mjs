// Export a finished garden, restore it into other viewports (landscape, then portrait again)
// and report the scene size. Saves restore-<biome>-{original,landscape,portrait}.png.
import { serve, launch, PHONE, OUT } from './_lib.mjs';
const srv = await serve();
const out = {};
for (const biome of ['garden', 'forest']) {
  const b = await launch(PHONE);
  await b.page.goto(srv.testPage());
  await b.page.evaluate(x => Dirt.start({ debug: true, biome: x, buryMs: 5000, growMs: 6000 }), biome);
  await b.page.waitForFunction(() => Dirt.phase === 'garden', null, { timeout: 60000 });
  const exported = await b.page.evaluate(() => Dirt.export());
  await b.page.screenshot({ path: `${OUT}/restore-${biome}-original.png` });
  const p2 = await b.ctx.newPage(); await p2.setViewportSize({ width: 844, height: 390 }); await p2.goto(srv.testPage());
  const st = await p2.evaluate(d => { Dirt.restore(d, { debug: true }); return Dirt.stats(); }, exported);
  await p2.waitForTimeout(300); await p2.screenshot({ path: `${OUT}/restore-${biome}-landscape.png` });
  const p3 = await b.ctx.newPage(); await p3.goto(srv.testPage());
  await p3.evaluate(d => Dirt.restore(d, { debug: false }), exported);
  await p3.waitForTimeout(300); await p3.screenshot({ path: `${OUT}/restore-${biome}-portrait.png` });
  out[biome] = { sceneOps: exported.scene.length, bytes: JSON.stringify(exported).length, restoredPhase: st.phase, restoredFill: +st.fillActual.toFixed(3), savedFill: +exported.fill.toFixed(3) };
  await b.close();
}
console.log(JSON.stringify(out, null, 1));
srv.close();
process.exit(Object.values(out).every(o => o.restoredPhase === 'garden' && Math.abs(o.restoredFill - o.savedFill) < 0.05) ? 0 : 1);
