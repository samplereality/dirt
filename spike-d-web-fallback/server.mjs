// Spike D — web fallback for readers without iOS or without the app.
//
//   node spike-d-web-fallback/server.mjs            # http://localhost:8787
//   ALLOW_LOCAL=1 node spike-d-web-fallback/server.mjs   # also allow localhost targets (for the probe harness)
//
// Endpoints (all GET):
//   /                      the paste-a-URL page
//   /api/probe?url=        response headers → can this URL be put in an <iframe>?
//   /api/shot?url=         full-page PNG screenshot from a headless iPhone-sized Chromium
//   /test/open|xfo|csp|heavy   synthetic pages so the harness can run offline
//
// Privacy note: this server necessarily sees every URL a reader pastes and fetches the page on
// their behalf. It keeps no logs beyond stdout and caches screenshots on disk for CACHE_TTL_MS.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, devices, request as pwRequest } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(HERE, 'cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_PAGE_PX = 12000;         // cap full-page height; the reader buries the viewport anyway
const NAV_TIMEOUT_MS = 25000;
const ALLOW_LOCAL = process.env.ALLOW_LOCAL === '1';
const DEVICE = devices['iPhone 14'];

fs.mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------- browser pool (one browser, N pages)
let browserPromise = null;
function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch().catch(e => {
      browserPromise = null; // don't cache a failed launch; the next call retries
      if (/Executable doesn't exist/.test(e.message)) {
        throw new Error("headless Chromium is not installed: run `npx playwright install chromium` once, then retry");
      }
      throw e;
    });
  }
  return browserPromise;
}
export async function shutdown() { if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); } }
const MAX_CONCURRENT = 2;
let active = 0; const queue = [];
function slot() { return new Promise(res => { queue.push(res); pump(); }); }
function pump() { while (active < MAX_CONCURRENT && queue.length) { active++; queue.shift()(); } }
function release() { active--; pump(); }

export function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('not a URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  const host = u.hostname;
  const isLocal = host === 'localhost' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]' || host.endsWith('.local');
  if (isLocal && !ALLOW_LOCAL) throw new Error('local addresses are not allowed');
  return u.toString();
}

// ---------------------------------------------------------------- probe: can we iframe it?
export function framingVerdict(headers) {
  const xfo = (headers['x-frame-options'] || '').trim().toUpperCase();
  const csp = headers['content-security-policy'] || '';
  const fa = /frame-ancestors\s+([^;]+)/i.exec(csp);
  const frameAncestors = fa ? fa[1].trim() : null;
  let frameable = true, reason = 'no framing restrictions in headers';
  if (frameAncestors) {
    const v = frameAncestors.toLowerCase();
    if (v === "'none'" || v === "'self'" || !(v.includes('*') || v.includes('http'))) { frameable = false; reason = `CSP frame-ancestors ${frameAncestors}`; }
    else { reason = `CSP frame-ancestors ${frameAncestors} (allows some origins; may still block ours)`; frameable = v.includes('*'); }
  } else if (xfo === 'DENY' || xfo === 'SAMEORIGIN' || xfo.startsWith('ALLOW-FROM')) {
    frameable = false; reason = `X-Frame-Options ${xfo}`;
  }
  return { frameable, reason, xFrameOptions: xfo || null, frameAncestors };
}

export async function probe(url) {
  const t0 = Date.now();
  const ctx = await pwRequest.newContext({ userAgent: DEVICE.userAgent, ignoreHTTPSErrors: true, timeout: 15000 });
  try {
    const res = await ctx.get(url, { maxRedirects: 10 });
    const headers = res.headers();
    return { url, finalUrl: res.url(), status: res.status(), ms: Date.now() - t0, ...framingVerdict(headers) };
  } finally { await ctx.dispose(); }
}

// ---------------------------------------------------------------- screenshot
export async function screenshot(url, { fullPage = true } = {}) {
  const key = crypto.createHash('sha1').update(url + (fullPage ? ':full' : ':view')).digest('hex');
  const file = path.join(CACHE, key + '.png'), meta = path.join(CACHE, key + '.json');
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < CACHE_TTL_MS) {
    return { file, ...JSON.parse(fs.readFileSync(meta, 'utf8')), cached: true };
  }
  await slot();
  const t0 = Date.now();
  const info = { url, fullPage, ms: 0, width: 0, height: 0, title: '', finalUrl: '', error: null, waitUsed: 'load' };
  let context = null;
  try {
    context = await (await browser()).newContext({ ...DEVICE, ignoreHTTPSErrors: true, locale: 'en-US' });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    try { await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }); info.waitUsed = 'networkidle'; }
    catch { try { await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }); } catch (e) { info.error = 'navigation: ' + e.message.split('\n')[0]; } }
    if (!info.error) {
      // Scroll through the page so lazy-loaded images and sticky banners settle, then return to top.
      await page.evaluate(async (maxPx) => {
        const step = Math.max(300, window.innerHeight);
        for (let y = 0; y < Math.min(document.documentElement.scrollHeight, maxPx); y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 90)); }
        window.scrollTo(0, 0);
      }, MAX_PAGE_PX).catch(() => {});
      await page.waitForTimeout(400);
      const dims = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: Math.min(document.documentElement.scrollHeight, 1e6), title: document.title })).catch(() => ({ w: 0, h: 0, title: '' }));
      info.title = dims.title; info.finalUrl = page.url();
      const clipH = Math.min(dims.h || 0, MAX_PAGE_PX);
      const shotOpts = fullPage && clipH > 0 ? { clip: { x: 0, y: 0, width: dims.w || DEVICE.viewport.width, height: clipH }, fullPage: true } : { fullPage: false };
      await page.screenshot({ path: file, type: 'png', ...shotOpts, timeout: 20000 });
      info.width = dims.w || DEVICE.viewport.width; info.height = fullPage ? clipH : DEVICE.viewport.height;
    }
  } catch (e) {
    info.error = (info.error ? info.error + '; ' : '') + e.message.split('\n')[0];
  } finally {
    info.ms = Date.now() - t0;
    if (context) await context.close().catch(() => {});
    release();   // always free the queue slot, even when the browser failed to launch
  }
  if (!info.error) fs.writeFileSync(meta, JSON.stringify(info));
  return { file: info.error ? null : file, ...info, cached: false };
}

// ---------------------------------------------------------------- HTTP
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function serveFile(res, file) {
  fs.readFile(file, (err, data) => err ? send(res, 404, 'not found', 'text/plain') : send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream'));
}

const TEST_PAGES = {
  open: { headers: {}, body: '<h1>Open page</h1><p>No framing headers. Should iframe fine.</p>' },
  xfo: { headers: { 'x-frame-options': 'DENY' }, body: '<h1>X-Frame-Options: DENY</h1>' },
  csp: { headers: { 'content-security-policy': "frame-ancestors 'none'" }, body: "<h1>CSP frame-ancestors 'none'</h1>" },
  sameorigin: { headers: { 'x-frame-options': 'SAMEORIGIN' }, body: '<h1>X-Frame-Options: SAMEORIGIN</h1>' },
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/') return serveFile(res, path.join(HERE, 'public', 'index.html'));
      if (url.pathname === '/dirt-core.js') return serveFile(res, path.join(ROOT, 'dirt-core.js'));
      if (url.pathname.startsWith('/public/')) return serveFile(res, path.join(HERE, url.pathname));
      if (url.pathname === '/test/heavy') return serveFile(res, path.join(ROOT, 'spike-0-core', 'test-page.html'));
      if (url.pathname.startsWith('/test/')) {
        const t = TEST_PAGES[url.pathname.slice(6)];
        if (!t) return send(res, 404, 'no such test page', 'text/plain');
        res.writeHead(200, { 'content-type': 'text/html', ...t.headers });
        return res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:20px sans-serif;padding:24px;background:#eef">${t.body}${'<p>filler</p>'.repeat(60)}`);
      }
      if (url.pathname === '/api/probe') {
        const target = validateTarget(url.searchParams.get('url') || '');
        return send(res, 200, await probe(target));
      }
      if (url.pathname === '/api/shot') {
        const target = validateTarget(url.searchParams.get('url') || '');
        const info = await screenshot(target, { fullPage: url.searchParams.get('view') !== '1' });
        if (url.searchParams.get('meta') === '1') return send(res, 200, info);
        if (!info.file) return send(res, 502, { error: info.error });
        res.writeHead(200, { 'content-type': 'image/png', 'x-dirt-height': String(info.height), 'x-dirt-width': String(info.width), 'x-dirt-ms': String(info.ms), 'cache-control': 'no-store' });
        return fs.createReadStream(info.file).pipe(res);
      }
      send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  createServer().listen(port, () => console.log(`Dirt fallback at http://localhost:${port}/  (ALLOW_LOCAL=${ALLOW_LOCAL})`));
}
