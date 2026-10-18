// Shared helpers for the headless checks in this folder. Node 18+, Playwright from package.json.
import { chromium, devices } from 'playwright';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../spike-0-core/serve.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });

export const PHONE = devices['iPhone 14'];                       // 390×664 CSS px @2x
export const DESKTOP = { viewport: { width: 1440, height: 900 } };

// Serve the repo root on a free port; returns { url(path), close() }.
export async function serve() {
  const server = createStaticServer();
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  return {
    port,
    testPage: (q = '') => `http://localhost:${port}/spike-0-core/test-page.html${q}`,
    close: () => server.close(),
  };
}

export async function launch(ctxOpts = PHONE) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  return { browser, ctx, page, close: () => browser.close() };
}

// A copy of dist/chrome that headless Chromium can test. The per-site permission prompt cannot
// be clicked headless, so the copy pre-grants localhost. `contentScripts: false` removes the
// page-load content scripts, which exercises the background's own injection path instead.
export function prepareExtension(name, { contentScripts = true } = {}) {
  execSync('sh build.sh', { cwd: ROOT, stdio: 'ignore' });
  const dir = path.join(OUT, `ext-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'dist', 'chrome'), dir, { recursive: true });
  const mf = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.host_permissions = ['http://localhost/*'];
  if (!contentScripts) delete m.content_scripts;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  return dir;
}

// Launch Chromium with the extension loaded; returns the context, its service worker and helpers
// that run code in a tab's isolated world through the background (where the extension APIs live).
export async function launchExtension(extDir, viewport = { width: 390, height: 664 }) {
  const profile = fs.mkdtempSync(path.join(OUT, 'profile-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  // NB: the service worker's CSP forbids `new Function`, so code for a tab is passed as a real
  // function to scripting.executeScript; and tabs.query({url}) does not match URLs with a port,
  // so tabs are found by comparing t.url.
  const stateOf = (url) => sw.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === u);
    if (!tab) return 'no tab';
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        if (typeof Dirt === 'undefined') return { phase: 'no core' };
        const st = Dirt.stats();
        const sh = document.querySelector('dirt-overlay');
        return st ? { phase: st.phase, biome: st.biome, flora: st.flora, fill: +st.fill.toFixed(3), fillActual: +st.fillActual.toFixed(3),
          buttons: sh ? sh.shadowRoot.querySelectorAll('.share.on').length : 0 } : { phase: Dirt.phase };
      } });
      return r.result;
    } catch (e) { return 'err ' + e.message; }
  }, url);
  // Run the click path as the toolbar button would: core + shared + inject.js.
  const clickOn = (url, saved = null) => sw.evaluate(async ([u, s]) => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === u);
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: ['dirt-core.js', 'shared.js'] });
    await chrome.scripting.executeScript({ target, func: (s) => { globalThis.__dirtSaved = s; globalThis.__dirtSiteAllowed = true; }, args: [s] });
    await chrome.scripting.executeScript({ target, files: ['inject.js'] });
  }, [url, saved]);
  // Start a run with chosen options (short timings for tests), wired to the extension like inject.js does.
  const startOn = (url, opts) => sw.evaluate(async ([u, o]) => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === u);
    const target = { tabId: tab.id };
    await chrome.scripting.executeScript({ target, files: ['dirt-core.js', 'shared.js'] });
    await chrome.scripting.executeScript({ target, func: (o) => { Dirt.start(DirtExt.opts(o)); DirtExt.watch(); }, args: [o] });
  }, [url, opts]);
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));
  const waitForPhase = async (url, phase, seconds = 60) => {
    for (let i = 0; i < seconds; i++) { await new Promise(r => setTimeout(r, 1000)); const st = await stateOf(url); if (st && st.phase === phase) return st; }
    throw new Error(`timed out waiting for ${phase} on ${url}`);
  };
  return { ctx, sw, extId, stateOf, clickOn, startOn, storage, waitForPhase, close: () => ctx.close() };
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
