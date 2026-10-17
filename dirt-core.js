/*!
 * dirt-core.js — "Dirt" by Mark Sample. Phase-1 feasibility spike.
 *
 * One self-contained, dependency-free module. It never reads or changes the
 * host page; it only draws on top of it:
 *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM
 *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,
 *     a device-resolution persistent canvas for the plants)
 *   - the dirt buries a third to a half of the viewport from the bottom; the page stays visible above it
 *   - then one biome, chosen at random per run, each with its own dirt colour and flora: garden
 *     (ground flowers), meadow (grass and wildflowers), trellis (vines up both edges), hedgerow
 *     (flowering bushes), forest (tall trees, dark loam), desert (cacti, sandy dirt)
 *   - Dirt.export() / Dirt.restore(data) save and replay a finished garden (the host extension
 *     decides where to keep it; the module itself stores nothing)
 *   - rotation / resize keeps the scene: the pile is rebuilt from its surface profile and the
 *     plants are replayed from a display list at their original sizes
 *   - no data collection, no network requests, no storage
 *
 * Usage:   Dirt.start({ debug: true })   Dirt.stop()   Dirt.stats()   Dirt.phase
 *
 * Plain ES2017 inside an IIFE so the same file can be inlined into a <script>,
 * a Safari Action-extension preprocessing file, a Web Extension content script,
 * or a WKUserScript without any build step.
 */
(function (root) {
  'use strict';
  if (root.Dirt && root.Dirt.__dirt) { return; }

  var VERSION = '0.3.0';
  var MAX_Z = 2147483647;
  var TAG = 'dirt-overlay';

  var DEFAULTS = {
    cellSize: 4,        // CSS px per simulation cell (dirt grid resolution)
    fill: [0.33, 0.5],  // how much of the viewport the dirt buries (fraction of height, picked at random)
    biome: 'random',    // 'garden' | 'meadow' | 'trellis' | 'hedgerow' | 'forest' | 'desert' | 'random'
    flora: null,        // legacy alias: 'flowers' -> garden, 'vines' -> trellis, 'bushes' -> hedgerow; 'none' = dirt only
    buryMs: 20000,      // target time for the dirt to reach its fill line
    growMs: 25000,      // target time for the garden to finish
    simHz: 30,          // sand-simulation tick rate; lower = chunkier, more hand-animated motion
    settled: false,     // true = build the pile instantly (dirt that was already there) instead of throwing it
    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line
    treeHeight: [0.25, 0.42], // forest trees rise this fraction of the viewport height above the soil line
    cactusHeight: [0.12, 0.3],
    maxDpr: 2,          // cap device pixel ratio for the growth canvas
    maxTips: 320,       // concurrent growing bush tips
    shareButton: true,  // show a share button in the lower corner once the garden is complete
    capture: null,      // optional async function → PNG data URL / Blob of the whole tab (host provides, e.g. tabs.captureVisibleTab)
    shareTitle: 'Dirt', // title/text handed to the share sheet
    onAlbum: null,      // optional function; when given, a second corner button opens the host's album
    debug: false,       // show the FPS / heartbeat HUD
    onPhase: null       // function(phase, dirt) — 'burying' | 'growing' | 'garden' | 'stopped'
  };

  // ---------------------------------------------------------------- helpers
  var now = (root.performance && root.performance.now) ? function () { return root.performance.now(); } : function () { return Date.now(); };

  // Small PRNG (xorshift32); Math.random is fine but this is cheaper in hot loops.
  var seed = (Date.now() & 0x7fffffff) || 1;
  function rnd() {
    if (!seed) { seed = 0x9e3779b9; }
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) % 1000000) / 1000000;
  }

  function rgba32(hex) { // '#rrggbb' -> little-endian ABGR uint32 for ImageData buffers
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }

  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

  var PALETTES = {
    loam: ['#5b3a21', '#6b4426', '#4a2e18', '#7a5230', '#3f2713', '#86592f', '#56361f'],
    dark: ['#3e2a17', '#4a3119', '#2f1f10', '#55391f', '#3a2614', '#5e4224', '#33220f'],
    sand: ['#d9c08a', '#c9ad73', '#e3cc9a', '#b89a62', '#cdb37e', '#a98b55', '#d4ba84']
  };
  // Each biome names a dirt palette and a flora system; the flora systems live in FLORA below.
  var BIOMES = {
    garden:   { dirt: 'loam', flora: 'flowers' },
    meadow:   { dirt: 'loam', flora: 'grass' },
    trellis:  { dirt: 'loam', flora: 'vines' },
    hedgerow: { dirt: 'loam', flora: 'bushes' },
    forest:   { dirt: 'dark', flora: 'trees' },
    desert:   { dirt: 'sand', flora: 'cacti' }
  };
  var LEGACY_FLORA = { flowers: 'garden', vines: 'trellis', bushes: 'hedgerow' };
  var STEM_COL = ['#2f6b2a', '#3b8a33', '#4a9c3c', '#5aa84a'];
  var LEAF_COL = ['#55a33b', '#6cbf45', '#8fd45a', '#3f8f36', '#79c94f', '#a3e06a'];
  var FLOWER_COL = ['#fff6d5', '#ffd84a', '#ff8fb1', '#c9a6ff', '#ff6f59', '#ffb347', '#f7f7f7', '#e04f8a'];
  var VINE_FLOWER_COL = ['#7b5cff', '#c66bd6', '#ff8fb1', '#5aa9ff', '#f4f0ff'];
  var BUSH_FLOWER_COL = ['#ff5d8f', '#ffd166', '#ffffff', '#ff8c42', '#d96bff', '#ff4d6d'];
  var GRASS_COL = ['#5f9e3a', '#7bb544', '#9ccc4e', '#86a83a', '#b8c95a', '#6aa23c'];
  var WILD_COL = ['#ffffff', '#ffe066', '#c9a6ff', '#ff8fb1', '#9ad0ff'];
  var TRUNK_COL = ['#5a3a1e', '#6b4423', '#4a2f17', '#7a5230'];
  var CANOPY_COL = ['#1f5a2a', '#2e7d32', '#3b8f3a', '#4caf50', '#6abf5c', '#357a38'];
  var CACTUS_COL = ['#3f7d3a', '#4f8f45', '#5c9a4b', '#2f6b2e', '#6aa85a'];
  var CACTUS_FLOWER_COL = ['#ff5fa2', '#ffd23f', '#ffffff', '#ff8c42'];

  // ---------------------------------------------------------------- state
  var S = null; // live state while running

  function makeState(opts) {
    return {
      opts: opts,
      phase: 'idle',
      host: null, shadow: null, dirtCanvas: null, growCanvas: null, hud: null, btn: null, albumBtn: null, toast: null, sharing: false,
      dctx: null, gctx: null, off: null, octx: null, img: null, buf: null,
      cw: 0, ch: 0, dpr: 1, W: 0, H: 0,
      grid: null, green: null,
      particles: [], tips: [], scene: [],
      shovelAcc: 0, shovelInterval: 70, shovelNext: 70, shovelCells: 60, simAcc: 0,
      coverage: 0, greenCov: 0, filled: 0, tops: null, topFull: 0,
      fillFrac: 0.4, fillActual: 0, fillPeak: 0, targetTop: 0, topMean: 1e9, dirtCells: 0,
      biome: 'garden', flora: 'flowers', pal: PALETTES.loam.map(rgba32),
      vines: [], bushes: [], blooms: [], clusters: [], plants: [], coverTarget: 0, coverCount: 0,
      t0: 0, tPhase: 0, lastT: 0, frames: 0, raf: 0, timer: 0,
      stats: { dts: new Float32Array(120), di: 0, dn: 0, simMs: 0, drawMs: 0, longFrames: 0, p95: 0 },
      running: false
    };
  }

  // ---------------------------------------------------------------- DOM
  function buildDom(s) {
    var doc = root.document;
    var host = doc.createElement(TAG);
    host.setAttribute('aria-hidden', 'true');
    // Inline !important beats any host-page stylesheet short of its own !important on a matching selector.
    host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +
      'width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;' +
      'z-index:' + MAX_Z + '!important;pointer-events:none!important;display:block!important;' +
      'transform:none!important;opacity:1!important;visibility:visible!important;contain:strict;';
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var style = doc.createElement('style');
    style.textContent = ':host{all:initial;display:block}' +
      'canvas{position:absolute;top:0;left:0;width:100%;height:100%;display:block;image-rendering:pixelated;}' +
      '.hud{position:absolute;top:env(safe-area-inset-top,0);left:0;margin:4px;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;' +
      'color:#b8ffb0;background:rgba(0,0,0,.72);border-radius:4px;white-space:pre;pointer-events:none;}' +
      '.share{position:absolute;right:max(14px,env(safe-area-inset-right,0));bottom:max(14px,env(safe-area-inset-bottom,0));' +
      'width:46px;height:46px;border-radius:50%;border:0;padding:0;margin:0;cursor:pointer;pointer-events:auto;' +
      'background:rgba(20,24,16,.78);color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;' +
      'opacity:0;transition:opacity .4s;-webkit-tap-highlight-color:transparent;}' +
      '.share.on{display:flex;opacity:1}.share:active{transform:scale(.94)}' +
      '.share.album{right:calc(max(14px,env(safe-area-inset-right,0)) + 56px)}' +
      '.share svg{width:22px;height:22px;display:block}' +
      '.toast{position:absolute;right:max(14px,env(safe-area-inset-right,0));bottom:calc(max(14px,env(safe-area-inset-bottom,0)) + 56px);' +
      'padding:6px 10px;border-radius:6px;background:rgba(20,24,16,.85);color:#fff;font:13px/1.3 -apple-system,system-ui,sans-serif;' +
      'pointer-events:none;opacity:0;transition:opacity .3s;white-space:nowrap}.toast.on{opacity:1}';
    shadow.appendChild(style);
    var dirtCanvas = doc.createElement('canvas');
    var growCanvas = doc.createElement('canvas');
    shadow.appendChild(dirtCanvas);
    shadow.appendChild(growCanvas);
    if (s.opts.debug) {
      var hud = doc.createElement('div');
      hud.className = 'hud';
      shadow.appendChild(hud);
      s.hud = hud;
    }
    if (s.opts.shareButton) {
      var btn = doc.createElement('button');
      btn.className = 'share'; btn.type = 'button';
      btn.setAttribute('aria-label', 'Share a picture of this garden');
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
      btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); API.share(); });
      shadow.appendChild(btn);
      var toast = doc.createElement('div'); toast.className = 'toast'; shadow.appendChild(toast);
      s.btn = btn; s.toast = toast;
      if (typeof s.opts.onAlbum === 'function') {
        var alb = doc.createElement('button');
        alb.className = 'share album'; alb.type = 'button';
        alb.setAttribute('aria-label', 'Open your album of buried pages');
        alb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
        alb.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); try { s.opts.onAlbum(API); } catch (err) { /* host callback error ignored */ } });
        shadow.appendChild(alb);
        s.albumBtn = alb;
      }
    }
    (doc.documentElement || doc.body).appendChild(host);
    s.host = host; s.shadow = shadow; s.dirtCanvas = dirtCanvas; s.growCanvas = growCanvas;
    s.dctx = dirtCanvas.getContext('2d', { alpha: true });
    s.gctx = growCanvas.getContext('2d', { alpha: true });
  }

  function viewportSize(s) {
    var r = s.host.getBoundingClientRect();
    var w = Math.round(r.width) || root.innerWidth || 320;
    var h = Math.round(r.height) || root.innerHeight || 480;
    return [w, h];
  }

  // Allocate canvases and grid for the current viewport. On a resize the old scene is carried over:
  //   - a modest height-only change (Safari's address bar) translates everything to stay bottom-anchored
  //   - anything else (rotation, window resize) scales anchor positions proportionally, rebuilds the
  //     pile from the old surface profile, and replays the plants at their original sizes
  function layout(s, first) {
    var wh = viewportSize(s), cw = wh[0], ch = wh[1];
    var dpr = Math.min(root.devicePixelRatio || 1, s.opts.maxDpr);
    if (!first && cw === s.cw && ch === s.ch && dpr === s.dpr) { return; }
    var cs = s.opts.cellSize;
    var W = Math.max(8, Math.ceil(cw / cs)), H = Math.max(8, Math.ceil(ch / cs));
    var W0 = s.W, H0 = s.H, cw0 = s.cw, ch0 = s.ch;
    var anchor = !first && cw === cw0 && Math.abs(ch - ch0) < ch0 * 0.3;
    var sx = first ? 1 : cw / cw0, sy = first ? 1 : ch / ch0, dy = ch - ch0;
    var T = anchor ? function (x, y) { return [x, y + dy]; } : function (x, y) { return [x * sx, y * sy]; };

    s.dirtCanvas.width = W * Math.min(dpr, 2); s.dirtCanvas.height = H * Math.min(dpr, 2);
    s.growCanvas.width = Math.round(cw * dpr); s.growCanvas.height = Math.round(ch * dpr);
    s.gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.gctx.lineCap = 'round'; s.gctx.lineJoin = 'round';
    s.dctx.imageSmoothingEnabled = false;

    var grid = new Uint8Array(W * H), green = new Uint8Array(W * H);
    if (s.grid) {
      var x, y, i;
      if (anchor) {
        var dyCells = H - H0;
        for (y = 0; y < H; y++) {
          var srow = y - dyCells;
          if (srow < 0 || srow >= H0) { continue; }
          grid.set(s.grid.subarray(srow * W0, srow * W0 + Math.min(W, W0)), y * W);
          green.set(s.green.subarray(srow * W0, srow * W0 + Math.min(W, W0)), y * W);
        }
        for (i = 0; i < s.particles.length; i++) { s.particles[i].y += dyCells; }
      } else {
        // Rebuild the pile from the old surface profile: same depth fraction per column.
        surfaceScan(s);
        for (x = 0; x < W; x++) {
          var ox = Math.min(W0 - 1, Math.floor(x * W0 / W));
          var depth = Math.round((H0 - s.tops[ox]) * H / H0);
          for (y = H - depth; y < H; y++) { grid[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }
        }
        for (y = 0; y < H; y++) {
          var oy = Math.min(H0 - 1, Math.floor(y * H0 / H));
          for (x = 0; x < W; x++) { green[y * W + x] = s.green[oy * W0 + Math.min(W0 - 1, Math.floor(x * W0 / W))]; }
        }
        for (i = 0; i < s.particles.length; i++) { s.particles[i].x *= W / W0; s.particles[i].y *= H / H0; }
      }
      // Everything that remembers a CSS-px position moves through the same transform.
      var p;
      for (i = 0; i < s.tips.length; i++) { p = T(s.tips[i].x, s.tips[i].y); s.tips[i].x = p[0]; s.tips[i].y = p[1]; }
      for (i = 0; i < s.vines.length; i++) {
        var v = s.vines[i];
        p = T(v.x, v.y); v.x = p[0]; v.y = p[1];
        p = T(v.px, v.py); v.px = p[0]; v.py = p[1];
        v.baseX = T(v.baseX, 0)[0];
        v.v = anchor ? v.v : v.v * sy;
      }
      for (i = 0; i < s.bushes.length; i++) {
        var b = s.bushes[i];
        b.x = T(b.x, 0)[0]; b.sy = T(0, b.sy)[1]; b.top = T(0, b.top)[1]; b.h = b.sy - b.top;
        b.v = anchor ? b.v : b.v * sy;
      }
      for (i = 0; i < s.plants.length; i++) {
        var pl = s.plants[i];
        pl.x = T(pl.x, 0)[0]; pl.sy = T(0, pl.sy)[1]; if (pl.h) { pl.h = anchor ? pl.h : pl.h * sy; }
        p = T(pl.px, pl.py); pl.px = p[0]; pl.py = p[1];
      }
      for (i = 0; i < s.blooms.length; i++) { p = T(s.blooms[i].x, s.blooms[i].y); s.blooms[i].x = p[0]; s.blooms[i].y = p[1]; }
      for (i = 0; i < s.clusters.length; i++) { p = T(s.clusters[i].x, s.clusters[i].y); s.clusters[i].x = p[0]; s.clusters[i].y = p[1]; }
    }
    s.cw = cw; s.ch = ch; s.dpr = dpr; s.W = W; s.H = H; s.grid = grid; s.green = green; s.tops = new Int16Array(W);
    s.targetTop = Math.max(1, H - Math.round(H * s.fillFrac)); // row the dirt surface must reach
    s.off = s.off || root.document.createElement('canvas');
    s.off.width = W; s.off.height = H;
    s.octx = s.off.getContext('2d');
    s.img = s.octx.createImageData(W, H);
    s.buf = new Uint32Array(s.img.data.buffer);

    // Shovelfuls: big clumps (150–450 grains), slung in from the edges; roughly fifty of them
    // fill a phone screen. Wide windows get more, not bigger. A quarter extra for grains lost to slides.
    var need = W * (H - s.targetTop) * 1.25;
    s.shovelCells = Math.max(150, Math.min(450, Math.round(need / 50)));
    s.shovelInterval = Math.max(60, s.opts.buryMs * s.shovelCells / need);

    if (!first) {
      surfaceScan(s);
      countFilled(s);
      if (s.phase !== 'burying') { s.dirtCells = s.filled; }
      drawDirt(s);              // resizing a canvas clears it
      replayScene(s, T);        // plants: replay the display list through the transform
      if (s.hud) { s.hud.textContent = hudText(s); }
    }
  }

  function checkSize(s) {
    // Resize events do not reach every injection context (Safari's share-sheet script, for one),
    // so the size is also polled from the frame loop and from a timer.
    var wh = viewportSize(s);
    if (wh[0] !== s.cw || wh[1] !== s.ch) { layout(s, false); }
  }

  // ---------------------------------------------------------------- dirt phase
  function columnTop(s, x) { // index of highest dirt cell in column (H if empty)
    var g = s.grid, W = s.W, H = s.H;
    for (var y = 0; y < H; y++) { if (g[y * W + x]) { return y; } }
    return H;
  }

  function surfaceScan(s) { // tops[x] = row of highest dirt cell (H if empty); also mean/fraction done
    var W = s.W, H = s.H, tops = s.tops || (s.tops = new Int16Array(W)), full = 0, sum = 0;
    for (var x = 0; x < W; x++) { var t = columnTop(s, x); tops[x] = t; sum += t; if (t <= s.targetTop) { full++; } }
    s.topFull = full / W;
    s.topMean = sum / W;
    s.fillActual = 1 - s.topMean / H;
    var mn = H; for (var q = 0; q < W; q++) { if (tops[q] < mn) { mn = tops[q]; } }
    s.fillPeak = 1 - mn / H;   // the tallest column, as a fraction of the height
    return tops;
  }

  function spawnShovel(s) {
    var W = s.W, H = s.H, tops = surfaceScan(s);
    var tx;
    if (rnd() < 0.5 + 0.5 * s.topFull) {
      // Aim at a low point in the surface: pick the deepest of several random probes.
      var probes = 6 + Math.round(s.topFull * 24), bt = -1;
      for (var k = 0; k < probes; k++) {
        var cx = Math.floor(rnd() * W);
        if (tops[cx] > bt) { bt = tops[cx]; tx = cx; }
      }
      if (bt <= s.targetTop) { return false; } // every probe hit a finished column
    } else {
      tx = Math.floor(rnd() * W);
    }
    var ty = Math.min(H - 1, tops[tx]);
    var n = Math.round(s.shovelCells * (0.6 + rnd() * 0.8));
    var spread = 1.5 + Math.sqrt(n) * 0.33;
    // The shoveller stands off the left or right edge, level with the bottom of the page: the
    // throw enters the frame just above the dirt at that edge and lobs across to the landing spot.
    var side = rnd() < 0.5 ? -1 : 1;
    // clear the pile along the whole entry strip, not just the edge column, or grains that enter
    // inside the dirt land there and ratchet the edge column upward
    var strip = Math.ceil(spread) + 3, edgeTop = H;
    for (var e = 0; e < strip && e < W; e++) { var col = side < 0 ? e : W - 1 - e; if (tops[col] < edgeTop) { edgeTop = tops[col]; } }
    edgeTop = Math.min(H - 2, edgeTop);
    var x0 = side < 0 ? -spread - 2 : W + spread + 2;
    var y0 = edgeTop - spread * 1.3 - 4 - rnd() * 4;
    // Ballistic solve for the clump's shared velocity: reach (tx, ty) in T sim ticks. Longer
    // flights lob higher. The arc must clear the terrain on the way, or the clump lands on a
    // mound's face and that mound grows into every later throw; so lob higher, then try the
    // other side, before giving up and throwing anyway.
    var kk = 60 / s.opts.simHz, dist = Math.abs(tx - x0) / W, T = (36 + dist * 30 + rnd() * 16) * kk, g = 0.03;
    var vx, vy, tries = 0;
    for (;;) {
      vx = (tx - x0) / T; vy = (ty - y0) / T - 0.5 * g * T;
      if (arcClear(s, x0, y0, vx, vy, g, T, tx, spread)) { break; }
      tries++;
      if (tries === 4) {
        side = -side; x0 = side < 0 ? -spread - 2 : W + spread + 2;
        edgeTop = H; for (e = 0; e < strip && e < W; e++) { col = side < 0 ? e : W - 1 - e; if (tops[col] < edgeTop) { edgeTop = tops[col]; } }
        y0 = Math.min(H - 2, edgeTop) - spread * 1.3 - 4 - rnd() * 4;
        T = (36 + Math.abs(tx - x0) / W * 30) * kk;
      } else if (tries > 7) { break; }
      else { T *= 1.25; }
    }
    var c0 = 1 + Math.floor(rnd() * s.pal.length);
    for (var i = 0; i < n; i++) {
      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;
      s.particles.push({
        x: x0 + Math.cos(ang) * rad, y: y0 + Math.sin(ang) * rad * 0.7,
        vx: vx + (rnd() - 0.5) * 0.05, vy: vy + (rnd() - 0.5) * 0.05, g: g, vmax: 3,
        c: rnd() < 0.7 ? c0 : 1 + Math.floor(rnd() * s.pal.length), seen: false, bounced: false, rolling: false
      });
    }
    return true;
  }

  // Does the parabola from (x0,y0) with velocity (vx,vy) stay above the terrain until it is
  // within a clump's width of the target column?
  function arcClear(s, x0, y0, vx, vy, g, T, tx, spread) {
    var W = s.W, tops = s.tops, steps = 24;
    for (var i = 1; i < steps; i++) {
      var t = T * i / steps, x = x0 + vx * t, y = y0 + vy * t + 0.5 * g * t * t;
      if (x < 0 || x >= W) { continue; }
      if (Math.abs(x - tx) <= spread + 1) { return true; }
      if (y > tops[Math.floor(x)] - spread - 1) { return false; }
    }
    return true;
  }

  function land(s, p) {
    var W = s.W, H = s.H, g = s.grid;
    var cx = Math.max(0, Math.min(W - 1, Math.floor(p.x)));
    var cy = Math.min(H - 1, Math.floor(p.y));
    while (cy >= 0 && g[cy * W + cx]) { cy--; }
    if (cy < 0) { return; }
    // Safety valve: nothing settles far above the fill line. A grain that would, slips to the
    // nearest column that still has room (invisible at grain scale, keeps towers impossible).
    if (cy < s.targetTop - s.H * 0.12) {
      for (var d = 1; d < W; d++) {
        var l = cx - d, r = cx + d;
        if (l >= 0 && s.tops[l] > s.targetTop - 2) { cx = l; break; }
        if (r < W && s.tops[r] > s.targetTop - 2) { cx = r; break; }
      }
      cy = Math.min(H - 1, s.tops[cx]); while (cy >= 0 && g[cy * W + cx]) { cy--; }
      if (cy < 0) { return; }
      s.tops[cx] = cy;
    }
    g[cy * W + cx] = p.c;
  }

  // Row of the empty cell sitting on top of column cx at or above row cy.
  function surfaceAt(s, cx, cy) {
    var W = s.W, g = s.grid;
    while (cy >= 0 && g[cy * W + cx]) { cy--; }
    return cy;
  }

  function stepParticles(s, k) {
    var ps = s.particles, W = s.W, H = s.H, g = s.grid;
    var w = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i], cx, cy;
      if (p.rolling) {
        // Splash: skid along the surface away from the impact. Falls where the ground drops,
        // stops where it rises; never climbs.
        var ox2 = p.x;
        p.x += p.vx * k; p.vx *= Math.pow(0.88, k);
        if (p.x < 0 || p.x >= W) { continue; }                                  // rolled off the page
        cx = Math.floor(p.x); cy = Math.floor(p.y);
        if (g[cy * W + cx]) { p.x = ox2; land(s, p); continue; }             // ran into a rise
        if (cy + 1 < H && !g[(cy + 1) * W + cx]) { p.rolling = false; p.vy = 0.15; ps[w++] = p; continue; } // rolled off a drop
        if (Math.abs(p.vx) < 0.25 || cy + 1 >= H) { land(s, p); continue; }
        ps[w++] = p; continue;
      }
      p.vx += (rnd() - 0.5) * 0.012 * k;        // grains drift apart a little in flight
      p.vy = Math.min(p.vmax, p.vy + p.g * k);
      var ox = p.x, oy = p.y;
      p.x += p.vx * k; p.y += p.vy * k;
      if (p.x >= 0 && p.x < W) { p.seen = true; }
      else if (p.seen ? (p.x < -4 || p.x > W + 4) : (p.x < -W || p.x > 2 * W || p.y > H + 10)) { continue; }   // left the page: gone
      cy = Math.floor(p.y); cx = Math.floor(p.x);
      var hit = p.seen && cx >= 0 && cx < W && (cy >= H - 1 || (cy >= 0 && (g[cy * W + cx] || g[(cy + 1) * W + cx])));
      if (hit) {
        // Flew into the side of a slope: stop where it came from rather than inside the pile.
        if (cy >= 0 && cy < H && g[cy * W + cx] && ox >= 0 && ox < W) { p.x = ox; p.y = oy; cy = Math.floor(oy); cx = Math.floor(ox); }
        if (!p.bounced && rnd() < 0.75 && cy >= 0) {
          var sy = surfaceAt(s, cx, Math.min(H - 1, cy));
          if (sy >= 0) {
            p.bounced = true; p.rolling = true;
            p.y = sy + 0.5; p.vx = (rnd() - 0.5) * 3.6 + p.vx * 0.3; p.vy = 0;
            ps[w++] = p; continue;
          }
        }
        land(s, p); continue;
      }
      ps[w++] = p;
    }
    ps.length = w;
  }

  // Falling-sand step, bottom row up. Two slide rules: the usual 45° diagonal slide, plus a
  // shallower one (sideways when the ground two cells down on that side is empty) applied at
  // random, which rounds the peaks instead of leaving sharp 45° ridges.
  function settle(s) {
    var g = s.grid, W = s.W, H = s.H;
    for (var y = H - 2; y >= 0; y--) {
      var row = y * W, below = row + W, below2 = below + W;
      for (var x = 0; x < W; x++) {
        var i = row + x, v = g[i];
        if (!v) { continue; }
        if (!g[below + x]) { g[below + x] = v; g[i] = 0; continue; }
        seed = (seed * 1103515245 + 12345) | 0;
        var dir = seed & 1 ? 1 : -1, moved = false;
        for (var t = 0; t < 2 && !moved; t++, dir = -dir) {
          var nx = x + dir;
          if (nx < 0 || nx >= W || g[row + nx]) { continue; }
          if (!g[below + nx]) { g[below + nx] = v; g[i] = 0; moved = true; }
          else if (y === 0 || !g[row - W + x]) {
            // surface grain with a lower neighbour: step sideways, fall next tick. Often when the
            // drop is two or more cells (shallow slope), rarely when it is one (slow relaxation
            // that rounds the humps without flattening them). Above the fill line: always, so no
            // mound or tower can stand higher than the page is meant to be buried.
            var high = y < s.targetTop - 1;
            if (high || (y + 2 < H && !g[below2 + nx])) { if ((seed & 3) !== 0) { g[row + nx] = v; g[i] = 0; moved = true; } }
            else if ((seed & 63) === 0) { g[row + nx] = v; g[i] = 0; moved = true; }
          }
        }
      }
    }
  }

  // Build the pile instantly: a gently bumpy surface at the fill line, as if the dirt landed
  // earlier. Used for spill-over on neighbouring pages (and anywhere a throw would be wrong).
  function buildPile(s) {
    var W = s.W, H = s.H, g = s.grid, rows = H - s.targetTop;
    var p1 = rnd() * 6.28, p2 = rnd() * 6.28, p3 = rnd() * 6.28;
    for (var x = 0; x < W; x++) {
      var r = rows * (1 + 0.2 * Math.sin(x * 0.07 + p1) + 0.1 * Math.sin(x * 0.19 + p2) + 0.06 * Math.sin(x * 0.43 + p3)) + (rnd() - 0.5) * 1.5;
      r = Math.max(1, Math.min(H, Math.round(r)));
      for (var y = H - r; y < H; y++) { g[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }
    }
    surfaceScan(s); countFilled(s); drawDirt(s);
  }

  // Rebuild the soil from a saved per-column depth profile (fractions of the height).
  function pileFromProfile(s, prof) {
    var W = s.W, H = s.H, g = s.grid, x, y;
    for (x = 0; x < W; x++) {
      var depth = Math.round(prof[Math.min(prof.length - 1, Math.floor(x * prof.length / W))] * H);
      for (y = H - depth; y < H; y++) { g[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }
    }
    surfaceScan(s); countFilled(s); s.dirtCells = s.filled; drawDirt(s);
  }

  function countFilled(s) {
    var g = s.grid, n = 0;
    for (var i = 0; i < g.length; i++) { if (g[i]) { n++; } }
    s.filled = n; s.coverage = n / g.length;
    return n;
  }

  function drawDirt(s) {
    var g = s.grid, buf = s.buf, n = g.length;
    var pal = s.pal;
    for (var i = 0; i < n; i++) { buf[i] = g[i] ? pal[g[i] - 1] : 0; }
    var ps = s.particles, W = s.W, H = s.H;
    for (var j = 0; j < ps.length; j++) {
      var p = ps[j], cy = Math.floor(p.y), cx = Math.floor(p.x);
      if (cy >= 0 && cy < H && cx >= 0 && cx < W) { buf[cy * W + cx] = pal[p.c - 1]; }
    }
    s.octx.putImageData(s.img, 0, 0);
    s.dctx.clearRect(0, 0, s.dirtCanvas.width, s.dirtCanvas.height);
    s.dctx.drawImage(s.off, 0, 0, s.dirtCanvas.width, s.dirtCanvas.height);
  }

  function stepBury(s, dt) {
    var elapsed = now() - s.tPhase;
    // Shovel rhythm: irregular, averaging shovelInterval.
    s.shovelAcc += dt;
    while (s.shovelAcc >= s.shovelNext) {
      s.shovelAcc -= s.shovelNext;
      s.shovelNext = s.shovelInterval * (0.35 + rnd() * 1.3);
      // Count grains still in the air as landed, or the fill overshoots the line by a dozen rows.
      if (s.topMean - s.particles.length / s.W > s.targetTop) { spawnShovel(s); }
    }
    // Fixed-rate simulation ticks (simHz), rendered every frame.
    var tick = 1000 / s.opts.simHz, k = 60 / s.opts.simHz, ticks = 0;
    s.simAcc += dt;
    while (s.simAcc >= tick && ticks < 4) {
      s.simAcc -= tick; ticks++;
      stepParticles(s, k);
      settle(s);
    }
    if (ticks && (s.frames & 7) === 0) { countFilled(s); surfaceScan(s); }
    var done = (s.topMean <= s.targetTop && s.particles.length === 0) || elapsed > s.opts.buryMs * 2.5;
    if (done) {
      // Tamp down: fill air pockets beneath the surface so the dirt reads as solid ground.
      var g = s.grid, W = s.W, H = s.H;
      surfaceScan(s);
      for (var x = 0; x < W; x++) { for (var y = s.tops[x]; y < H; y++) { var i = y * W + x; if (!g[i]) { g[i] = 1 + (i % s.pal.length); } } }
      s.particles.length = 0;
      countFilled(s);
      drawDirt(s);
      initGarden(s);
      setPhase(s, 'growing');
      return;
    }
    if (ticks) { drawDirt(s); }
  }

  // ---------------------------------------------------------------- growth phase
  // One of three plant systems grows after the dirt settles (picked at random unless forced):
  //   flowers — ground flowers fill the dirt itself
  //   vines   — climb the left and right edges of the window, as if on a trellis
  //   bushes  — rise from the soil line to fill roughly the next quarter of the window
  // Everything drawn is also recorded in s.scene so a resize can replay it into the new shape.

  function soilY(s, px) { // CSS-px y of the dirt surface under CSS-px x
    var cs = s.opts.cellSize, x = Math.max(0, Math.min(s.W - 1, Math.floor(px / cs)));
    return s.tops[x] * cs;
  }

  function markGreen(s, px, py, r) {
    var cs = s.opts.cellSize, W = s.W, H = s.H, gr = s.green;
    var x0 = Math.max(0, Math.floor((px - r) / cs)), x1 = Math.min(W - 1, Math.floor((px + r) / cs));
    var y0 = Math.max(0, Math.floor((py - r) / cs)), y1 = Math.min(H - 1, Math.floor((py + r) / cs));
    for (var y = y0; y <= y1; y++) { for (var x = x0; x <= x1; x++) { gr[y * W + x] = 1; } }
  }

  // ---- primitives: draw now, remember for replay
  function paintLeaf(c, x, y, ang, size, col) {
    c.save(); c.translate(x, y); c.rotate(ang);
    c.fillStyle = col;
    c.beginPath(); c.ellipse(size * 0.6, 0, size, size * 0.45, 0, 0, 6.2832); c.fill();
    c.restore();
  }
  function drawLeaf(s, x, y, ang, size, col) {
    paintLeaf(s.gctx, x, y, ang, size, col);
    s.scene.push({ t: 1, x: x, y: y, a: ang, r: size, col: col });
  }

  function paintFlower(c, x, y, r, col, centerCol, n, rot) {
    c.fillStyle = col;
    for (var i = 0; i < n; i++) {
      var a = rot + i * 6.2832 / n;
      c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55, r * 0.35, a, 0, 6.2832); c.fill();
    }
    c.fillStyle = centerCol;
    c.beginPath(); c.arc(x, y, r * 0.3, 0, 6.2832); c.fill();
  }
  function drawFlower(s, x, y, r, col, centerCol, n, rot) {
    n = n || 5 + (rnd() < 0.3 ? 1 : 0); rot = rot === undefined ? rnd() * 6.2832 : rot;
    centerCol = centerCol || '#ffd84a';
    paintFlower(s.gctx, x, y, r, col, centerCol, n, rot);
    s.scene.push({ t: 2, x: x, y: y, r: r, col: col, c2: centerCol, n: n, rot: rot });
  }

  function paintTendril(c, x, y, dir, len, wob, col) {
    c.strokeStyle = col; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x, y);
    c.quadraticCurveTo(x + dir * len * 0.7, y - len * 0.5, x + dir * len, y + wob * len * 0.6);
    c.stroke();
  }
  function drawTendril(s, x, y, dir, len, col) {
    var wob = rnd() - 0.5;
    paintTendril(s.gctx, x, y, dir, len, wob, col);
    s.scene.push({ t: 3, x: x, y: y, dir: dir, len: len, wob: wob, col: col });
  }

  // Stems are polylines: drawn live segment by segment, recorded as sparse points.
  function startStroke(s, x, y, w, col) {
    var op = { t: 0, pts: [x, y], w0: w, w1: w, col: col };
    s.scene.push(op);
    return op;
  }
  function extendStroke(s, op, x0, y0, x1, y1, w) {
    var c = s.gctx;
    c.strokeStyle = op.col; c.lineWidth = w;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    var n = op.pts.length, dx = x1 - op.pts[n - 2], dyy = y1 - op.pts[n - 1];
    if (dx * dx + dyy * dyy >= 9) { op.pts.push(x1, y1); op.w1 = w; }
  }
  function paintStroke(c, op, T) {
    var pts = op.pts, n = pts.length / 2;
    if (n < 2) { return; }
    for (var i = 1; i < n; i++) {
      var a = T(pts[i * 2 - 2], pts[i * 2 - 1]), b = T(pts[i * 2], pts[i * 2 + 1]);
      c.strokeStyle = op.col; c.lineWidth = op.w0 + (op.w1 - op.w0) * (i / (n - 1));
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
    }
  }

  function replayScene(s, T) {
    var c = s.gctx, sc = s.scene;
    c.clearRect(0, 0, s.cw, s.ch);
    for (var i = 0; i < sc.length; i++) {
      var op = sc[i], p;
      if (op.t === 0) { paintStroke(c, op, T); continue; }
      p = T(op.x, op.y);
      if (op.t === 1) { paintLeaf(c, p[0], p[1], op.a, op.r, op.col); }
      else if (op.t === 2) { paintFlower(c, p[0], p[1], op.r, op.col, op.c2, op.n, op.rot); }
      else if (op.t === 3) { paintTendril(c, p[0], p[1], op.dir, op.len, op.wob, op.col); }
    }
    // Bake the transform into the record so the next resize composes correctly.
    for (i = 0; i < sc.length; i++) {
      op = sc[i];
      if (op.t === 0) { for (var j = 0; j < op.pts.length; j += 2) { p = T(op.pts[j], op.pts[j + 1]); op.pts[j] = p[0]; op.pts[j + 1] = p[1]; } }
      else { p = T(op.x, op.y); op.x = p[0]; op.y = p[1]; }
    }
  }

  function sproutTip(s, bush, x, y, ang, depth, maxLen, w) {
    if (s.tips.length >= s.opts.maxTips) { return; }
    s.tips.push({ bush: bush, x: x, y: y, a: ang, len: 0, maxLen: maxLen, w: w, depth: depth, stroke: startStroke(s, x, y, w, bush.stemCol) });
  }

  function stepBushes(s, dt, k, elapsed) {
    var tips = s.tips, cw = s.cw, i, w = 0;
    for (i = 0; i < s.bushes.length; i++) {
      var bsh = s.bushes[i];
      if (!bsh.started && elapsed >= bsh.delay) {
        bsh.started = true;
        var trunks = 1 + (rnd() < 0.6 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);
        for (var t = 0; t < trunks; t++) {
          sproutTip(s, bsh, bsh.x + (rnd() - 0.5) * 10, bsh.sy + 2, -1.5708 + (rnd() - 0.5) * 0.7, 0, bsh.h * (0.8 + rnd() * 0.25), 3);
        }
      }
    }
    for (i = 0; i < tips.length; i++) {
      var tp = tips[i], bush = tp.bush;
      var step = bush.v * dt;
      var nx = tp.x + Math.cos(tp.a) * step, ny = tp.y + Math.sin(tp.a) * step;
      extendStroke(s, tp.stroke, tp.x, tp.y, nx, ny, tp.w * (1 - 0.55 * tp.len / tp.maxLen));
      tp.x = nx; tp.y = ny; tp.len += step;
      tp.a += (rnd() - 0.5) * 0.3 * k;
      tp.a += (-1.5708 - tp.a) * 0.03 * k;
      if (rnd() < 0.08 * k) {
        var side = rnd() < 0.5 ? 1 : -1;
        drawLeaf(s, nx, ny, tp.a + side * (1.0 + rnd() * 0.6), 3.5 + rnd() * 4, rnd() < 0.5 ? bush.leafCol : bush.leafCol2);
      }
      if (rnd() < 0.025 * k && tp.depth < 3) { drawFlower(s, nx + (rnd() - 0.5) * 6, ny, 2.5 + rnd() * 2.5, bush.flowerCol); }
      if (tp.len > 6 && tp.depth < 4 && rnd() < 0.07 * k) {
        var bs = rnd() < 0.5 ? 1 : -1;
        sproutTip(s, bush, nx, ny, tp.a + bs * (0.5 + rnd() * 0.6), tp.depth + 1, (tp.maxLen - tp.len) * (0.35 + rnd() * 0.35), tp.w * 0.7);
      }
      var alive = tp.len < tp.maxLen && ny > bush.top && ny < bush.sy + 4 && nx > -8 && nx < cw + 8;
      if (!alive) {
        // Bloom at the end of every branch; big flowers on the main stems.
        tp.stroke.pts.push(nx, ny);
        drawLeaf(s, nx, ny, tp.a + 0.8, 4 + rnd() * 4, bush.leafCol);
        drawLeaf(s, nx, ny, tp.a - 0.8, 4 + rnd() * 4, bush.leafCol2);
        if (tp.depth <= 1 || rnd() < 0.6) { drawFlower(s, nx, ny, (tp.depth === 0 ? 6 : 3.5) + rnd() * 3, bush.flowerCol); }
        continue;
      }
      tips[w++] = tp;
    }
    tips.length = w;
  }

  function stepVines(s, dt, k, elapsed) {
    var cw = s.cw;
    for (var i = 0; i < s.vines.length; i++) {
      var v = s.vines[i];
      if (v.done || elapsed < v.delay) { continue; }
      if (!v.stroke) { v.stroke = startStroke(s, v.x, v.y, 2.6, v.col); }
      var dy = v.v * dt;
      v.y -= dy;
      v.x = v.baseX + Math.sin(v.y * v.freq + v.phase) * v.amp - v.side * Math.abs(Math.cos(v.y * v.freq * 0.5)) * 4;
      extendStroke(s, v.stroke, v.px, v.py, v.x, v.y, 2.6);
      v.px = v.x; v.py = v.y;
      v.leafAcc += dy; v.flowerAcc += dy;
      if (v.leafAcc >= v.nextLeaf) {
        v.leafAcc = 0; v.nextLeaf = 9 + rnd() * 9; v.alt ^= 1;
        var inward = v.side < 0 ? 0 : 3.1416;
        drawLeaf(s, v.x, v.y, inward + (v.alt ? 0.75 : -0.75) * -v.side, 5 + rnd() * 5, v.leafCol);
        if (rnd() < 0.25) { drawTendril(s, v.x, v.y, -v.side, 14 + rnd() * 26, v.col); }
      }
      if (v.flowerAcc >= v.nextFlower) {
        v.flowerAcc = 0; v.nextFlower = 22 + rnd() * 34;
        drawFlower(s, v.x - v.side * (4 + rnd() * 8), v.y, 4.5 + rnd() * 2.5, v.flowerCol, '#fff7cc');
      }
      if (v.y < -8 || v.x < -20 || v.x > cw + 20) { v.done = true; v.stroke.pts.push(v.x, v.y); }
    }
  }

  // ---- staged blooms: a flower or leaf pair that grows over 0.8–3.5 s at its own rate.
  // Drawn progressively (each stage painted over the last), recorded once when complete.
  function addBloom(s, b) { b.t = 0; b.rate = 1 / (800 + rnd() * 2700); b.drawn = 0; s.blooms.push(b); }

  function stepBlooms(s, dt) {
    var c = s.gctx, bl = s.blooms, w = 0;
    for (var i = 0; i < bl.length; i++) {
      var b = bl[i];
      b.t = Math.min(1, b.t + b.rate * dt);
      var ease = b.t * b.t * (3 - 2 * b.t);
      if (ease - b.drawn >= 0.18 || (b.t === 1 && b.drawn < 1)) {
        b.drawn = b.t === 1 ? 1 : ease;
        if (b.kind === 'flower') {
          if (b.t === 1) { drawFlower(s, b.x, b.y, b.r, b.col, b.c2, b.n, b.rot); }
          else { paintFlower(c, b.x, b.y, b.r * ease, b.col, b.c2, b.n, b.rot); }
        } else {
          if (b.t === 1) { drawLeaf(s, b.x, b.y, b.a, b.r, b.col); drawLeaf(s, b.x, b.y, b.a + 2.4, b.r * 0.9, b.col2); }
          else { paintLeaf(c, b.x, b.y, b.a, b.r * ease, b.col); paintLeaf(c, b.x, b.y, b.a + 2.4, b.r * 0.9 * ease, b.col2); }
        }
      }
      if (b.t === 1) { markGreen(s, b.x, b.y, b.r * 1.1); continue; }
      bl[w++] = b;
    }
    bl.length = w;
  }

  // Pick a bare dirt cell, preferring the neighbourhood of a few wandering cluster centres so
  // growth spreads in drifts rather than evenly. Returns [px, py] or null.
  function bareDirtSpot(s) {
    var W = s.W, H = s.H, cs = s.opts.cellSize, g = s.grid, gr = s.green, tops = s.tops;
    for (var t = 0; t < 8; t++) {
      var x, y;
      if (s.clusters.length && rnd() < 0.7) {
        var cl = pick(s.clusters);
        x = Math.floor((cl.x + (rnd() + rnd() - 1) * 40) / cs); y = Math.floor((cl.y + (rnd() + rnd() - 1) * 40) / cs);
        if (x < 0 || x >= W || y < 0 || y >= H) { continue; }
      } else {
        x = Math.floor(rnd() * W); var top = tops[x]; if (top >= H) { continue; }
        y = top + Math.floor(rnd() * (H - top));
      }
      var ci = y * W + x;
      if (!g[ci] || gr[ci]) { continue; }
      return [(x + 0.5) * cs, (y + 0.5) * cs];
    }
    return null;
  }

  function stepClusters(s, dt) {
    var cw = s.cw, ch = s.ch;
    for (var i = 0; i < s.clusters.length; i++) {
      var cl = s.clusters[i];
      cl.x += cl.vx * dt; cl.y += cl.vy * dt;
      if (cl.x < 0 || cl.x > cw) { cl.vx = -cl.vx; cl.x = Math.max(0, Math.min(cw, cl.x)); }
      var sy = soilY(s, cl.x);
      if (cl.y < sy || cl.y > ch) { cl.vy = -cl.vy; cl.y = Math.max(sy, Math.min(ch, cl.y)); }
      if (rnd() < 0.004) { cl.vx = (rnd() - 0.5) * 0.08; cl.vy = (rnd() - 0.5) * 0.06; }
    }
  }

  function initClusters(s, n) {
    s.clusters = [];
    for (var i = 0; i < n; i++) {
      var x = rnd() * s.cw, sy = soilY(s, x);
      s.clusters.push({ x: x, y: sy + rnd() * (s.ch - sy), vx: (rnd() - 0.5) * 0.08, vy: (rnd() - 0.5) * 0.06 });
    }
  }

  function dirtCoverage(s) {
    var g = s.grid, gr = s.green, n = 0;
    for (var i = 0; i < gr.length; i++) { if (g[i] && gr[i]) { n++; } }
    s.greenCov = s.dirtCells ? n / s.dirtCells : 1;
    return s.greenCov;
  }

  // ---- the flora systems. Each: init(s), step(s, dt, k, elapsed), done(s) -> bool
  var FLORA = {};

  // garden: ground flowers and leaf pairs carpet the dirt, in drifts, each blooming at its own pace
  FLORA.flowers = {
    init: function (s) { initClusters(s, 3 + Math.floor(rnd() * 3)); },
    step: function (s, dt, k) {
      stepClusters(s, dt);
      if (s.greenCov < 0.75) {
        var want = rnd() < 0.5 * k ? 1 : 0, elapsed = now() - s.tPhase;
        if (elapsed < s.opts.growMs * 0.4 && rnd() < 0.5 * k) { want++; }
        for (var n = 0; n < want; n++) {
          var sp = bareDirtSpot(s); if (!sp) { continue; }
          if (rnd() < 0.55) {
            var r = 2.5 + rnd() * 3.5;
            var st = startStroke(s, sp[0], sp[1] + r * 1.6, 1, pick(STEM_COL));
            st.pts.push(sp[0], sp[1]); extendStroke(s, st, sp[0], sp[1] + r * 1.6, sp[0], sp[1], 1);
            addBloom(s, { kind: 'flower', x: sp[0], y: sp[1], r: r, col: pick(FLOWER_COL), c2: '#ffd84a', n: 5 + (rnd() < 0.3 ? 1 : 0), rot: rnd() * 6.2832 });
          } else {
            addBloom(s, { kind: 'leaf', x: sp[0], y: sp[1], r: 3 + rnd() * 3, a: rnd() * 6.2832, col: pick(LEAF_COL), col2: pick(LEAF_COL) });
          }
          markGreen(s, sp[0], sp[1], 1); // reserve the spot so the next pick lands elsewhere
        }
      }
      stepBlooms(s, dt);
      if ((s.frames & 15) === 0) { dirtCoverage(s); }
    },
    done: function (s) { return s.greenCov >= 0.75 && s.blooms.length === 0; }
  };

  // meadow: grass blades (curved strokes that grow at their own speed) with scattered wildflowers
  FLORA.grass = {
    init: function (s) { initClusters(s, 4 + Math.floor(rnd() * 3)); },
    step: function (s, dt, k) {
      stepClusters(s, dt);
      if (s.greenCov < 0.72) {
        var want = (rnd() < 0.9 * k ? 1 : 0) + (rnd() < 0.5 * k ? 1 : 0);
        for (var n = 0; n < want; n++) {
          var sp = bareDirtSpot(s); if (!sp) { continue; }
          if (rnd() < 0.07) {
            addBloom(s, { kind: 'flower', x: sp[0], y: sp[1] - 4, r: 2 + rnd() * 1.8, col: pick(WILD_COL), c2: '#ffd84a', n: 5, rot: rnd() * 6.2832 });
            var st = startStroke(s, sp[0], sp[1] + 2, 0.9, pick(GRASS_COL)); st.pts.push(sp[0], sp[1] - 4); extendStroke(s, st, sp[0], sp[1] + 2, sp[0], sp[1] - 4, 0.9);
          } else {
            var h = 9 + rnd() * 24, lean = (rnd() - 0.5) * 1.1;
            s.plants.push({ kind: 'blade', x: sp[0], sy: sp[1], h: h, lean: lean, t: 0, rate: 1 / (700 + rnd() * 2200),
              stroke: startStroke(s, sp[0], sp[1], 1.8, pick(GRASS_COL)), px: sp[0], py: sp[1] });
          }
          markGreen(s, sp[0], sp[1], 2.5);
        }
      }
      var pl = s.plants, w = 0;
      for (var i = 0; i < pl.length; i++) {
        var b = pl[i];
        b.t = Math.min(1, b.t + b.rate * dt);
        var u = b.t, cx = b.x + b.lean * b.h * 0.2, cy = b.sy - b.h * 0.6, tx = b.x + b.lean * b.h, ty = b.sy - b.h;
        var nx = (1 - u) * (1 - u) * b.x + 2 * (1 - u) * u * cx + u * u * tx, ny = (1 - u) * (1 - u) * b.sy + 2 * (1 - u) * u * cy + u * u * ty;
        extendStroke(s, b.stroke, b.px, b.py, nx, ny, 1.8 - 1.2 * u);
        b.px = nx; b.py = ny;
        if (b.t === 1) { b.stroke.pts.push(nx, ny); b.stroke.w1 = 0.6; continue; }
        pl[w++] = b;
      }
      pl.length = w;
      stepBlooms(s, dt);
      if ((s.frames & 15) === 0) { dirtCoverage(s); }
    },
    done: function (s) { return s.greenCov >= 0.72 && s.plants.length === 0 && s.blooms.length === 0; }
  };

  // trellis: vines climb both edges
  FLORA.vines = {
    init: function (s) {
      var cw = s.cw, growMs = s.opts.growMs;
      for (var side = -1; side <= 1; side += 2) {
        var n = 3 + Math.floor(rnd() * 3);
        for (var i = 0; i < n; i++) {
          var baseX = side < 0 ? 6 + rnd() * 16 : cw - 6 - rnd() * 16;
          var y0 = soilY(s, baseX) + 4;
          s.vines.push({
            side: side, baseX: baseX, x: baseX, y: y0, px: baseX, py: y0,
            amp: 14 + rnd() * 20, freq: 0.02 + rnd() * 0.025, phase: rnd() * 6.2832,
            v: (y0 + 12) / (growMs * (0.55 + rnd() * 0.45)),
            delay: i * growMs * 0.1 + rnd() * 1500,
            leafAcc: 0, nextLeaf: 10 + rnd() * 8, flowerAcc: 0, nextFlower: 25 + rnd() * 30, alt: 0,
            col: pick(STEM_COL), leafCol: pick(LEAF_COL), flowerCol: pick(VINE_FLOWER_COL), done: false, stroke: null
          });
        }
      }
    },
    step: function (s, dt, k, elapsed) { stepVines(s, dt, k, elapsed); },
    done: function (s) { for (var i = 0; i < s.vines.length; i++) { if (!s.vines[i].done) { return false; } } return true; }
  };

  // hedgerow: flowering bushes, with more spread in growth speed than before
  FLORA.bushes = {
    init: function (s) {
      var cw = s.cw, ch = s.ch, growMs = s.opts.growMs;
      var count = Math.max(3, Math.round(cw / 72)), bh = s.opts.bushHeight;
      for (var b = 0; b < count; b++) {
        var bx = (b + 0.3 + rnd() * 0.4) * cw / count;
        var sy = soilY(s, bx);
        var h = Math.min(sy - 6, (bh[0] + rnd() * (bh[1] - bh[0])) * ch);
        s.bushes.push({
          x: bx, sy: sy, top: sy - h, h: h, delay: rnd() * growMs * 0.35, started: false,
          v: h / (growMs * (0.3 + rnd() * 0.4)), stemCol: pick(STEM_COL), leafCol: pick(LEAF_COL), leafCol2: pick(LEAF_COL),
          flowerCol: pick(BUSH_FLOWER_COL)
        });
      }
    },
    step: function (s, dt, k, elapsed) { stepBushes(s, dt, k, elapsed); },
    done: function (s) { if (s.tips.length) { return false; } for (var i = 0; i < s.bushes.length; i++) { if (!s.bushes[i].started) { return false; } } return true; }
  };

  // forest: trunk first, then branches in turn with leaves along each branch as it extends, then
  // a cluster spreading outward from each branch tip. Some trees are evergreens: tiers of
  // down-swept branches with needles, growing from the bottom tier up.
  var EVERGREEN_COL = ['#1f4d2b', '#2a6b3a', '#245c33', '#1b5e20', '#2e7d32'];
  FLORA.trees = {
    init: function (s) {
      var cw = s.cw, ch = s.ch, th = s.opts.treeHeight, growMs = s.opts.growMs;
      var count = Math.max(2, Math.round(cw / 140));
      for (var i = 0; i < count; i++) {
        var x = (i + 0.25 + rnd() * 0.5) * cw / count, sy = soilY(s, x);
        var h = Math.min(sy - 10, (th[0] + rnd() * (th[1] - th[0])) * ch);
        var ever = rnd() < 0.4, plan = [], b;
        if (ever) {
          var tiers = 6 + Math.floor(rnd() * 4);
          for (b = 0; b < tiers; b++) {
            var frac = 0.22 + (b / tiers) * 0.72, len = h * 0.3 * (1 - frac * 0.8) + 3;
            plan.push({ at: frac, ang: 3.1416 - 0.35 - rnd() * 0.2, len: len });   // left, swept down
            plan.push({ at: frac, ang: 0.35 + rnd() * 0.2, len: len });            // right, swept down
          }
          plan.push({ at: 1, ang: -1.5708, len: h * 0.08 + 3 });                   // leader
        } else {
          var nb = 3 + Math.floor(rnd() * 3);
          for (b = 0; b < nb; b++) {
            var side = b % 2 ? 1 : -1;
            plan.push({ at: 0.5 + (b / nb) * 0.45 + rnd() * 0.05, ang: -1.5708 + side * (0.5 + rnd() * 0.55), len: h * (0.18 + rnd() * 0.16) });
          }
          plan.push({ at: 1, ang: -1.5708 + (rnd() - 0.5) * 0.5, len: h * (0.12 + rnd() * 0.08) });
        }
        plan.sort(function (p1, p2) { return p1.at - p2.at; });
        s.plants.push({
          kind: 'tree', ever: ever, x: x, sy: sy, h: h, w: 4 + rnd() * 5, t: 0, delay: rnd() * growMs * 0.25,
          rate: 1 / (growMs * (0.22 + rnd() * 0.2)), sway: (rnd() - 0.5) * 0.25, trunkCol: ever ? '#4a2f17' : pick(TRUNK_COL),
          leafCols: ever ? [pick(EVERGREEN_COL), pick(EVERGREEN_COL), pick(EVERGREEN_COL)] : [pick(CANOPY_COL), pick(CANOPY_COL), pick(CANOPY_COL)],
          plan: plan, branches: [], stroke: null, px: x, py: sy
        });
      }
    },
    step: function (s, dt, k, elapsed) {
      var pl = s.plants;
      for (var i = 0; i < pl.length; i++) {
        var tr = pl[i];
        if (elapsed < tr.delay) { continue; }
        if (!tr.stroke) { tr.stroke = startStroke(s, tr.x, tr.sy + 2, tr.w, tr.trunkCol); tr.stroke.w1 = tr.w * 0.45; }
        // 1. trunk
        if (tr.t < 1) {
          tr.t = Math.min(1, tr.t + tr.rate * dt);
          var ny = tr.sy - tr.h * tr.t, nx = tr.x + Math.sin(tr.t * 3.1) * tr.sway * tr.h * 0.15;
          extendStroke(s, tr.stroke, tr.px, tr.py, nx, ny, tr.w * (1 - 0.55 * tr.t));
          tr.px = nx; tr.py = ny;
          if (tr.t === 1) { tr.stroke.pts.push(nx, ny); }
          continue;
        }
        // 2. branches, in order from the trunk base up; the next starts once the previous is half grown
        var last = tr.branches[tr.branches.length - 1];
        if (tr.plan.length && (!last || last.t > 0.5)) {
          var pn = tr.plan.shift();
          var bx0 = tr.x + Math.sin(pn.at * 3.1) * tr.sway * tr.h * 0.15, by0 = tr.sy - tr.h * pn.at;
          tr.branches.push({ x: bx0, y: by0, ang: pn.ang, len: pn.len, t: 0, px: bx0, py: by0, leaves: 0,
            leafTarget: tr.ever ? 0 : Math.round(10 + pn.len * 0.5), stroke: startStroke(s, bx0, by0, tr.w * 0.5, tr.trunkCol), needleAcc: 0 });
        }
        for (var b = 0; b < tr.branches.length; b++) {
          var br = tr.branches[b];
          if (br.t < 1) {
            br.t = Math.min(1, br.t + tr.rate * 2.2 * dt);
            var bx = br.x + Math.cos(br.ang) * br.len * br.t, by = br.y + Math.sin(br.ang) * br.len * br.t;
            extendStroke(s, br.stroke, br.px, br.py, bx, by, tr.w * 0.5 * (1 - 0.6 * br.t));
            var moved = Math.sqrt((bx - br.px) * (bx - br.px) + (by - br.py) * (by - br.py));
            br.px = bx; br.py = by;
            // 3a. leaves (or needles) along the branch as it extends
            if (tr.ever) {
              br.needleAcc += moved;
              while (br.needleAcc >= 2.2) {
                br.needleAcc -= 2.2;
                var ns = rnd() < 0.5 ? 1 : -1;
                drawLeaf(s, bx, by, br.ang + ns * (1.1 + rnd() * 0.5) + 0.6, 2.2 + rnd() * 1.6, pick(tr.leafCols));
              }
            } else if (rnd() < 0.35 * k) {
              drawLeaf(s, bx, by, br.ang + (rnd() < 0.5 ? 1 : -1) * (0.8 + rnd() * 0.7), 3.5 + rnd() * 3.5, pick(tr.leafCols));
            }
            if (br.t === 1) { br.stroke.pts.push(bx, by); }
          } else if (br.leaves < br.leafTarget) {
            // 3b. a cluster spreading outward from the branch tip
            var n = 1 + Math.floor(rnd() * 2 * k), R = br.len * 0.55 + 6;
            for (var j = 0; j < n && br.leaves < br.leafTarget; j++, br.leaves++) {
              var a = rnd() * 6.2832, rr = R * Math.sqrt((br.leaves + rnd()) / br.leafTarget);
              drawLeaf(s, br.px + Math.cos(a) * rr, br.py + Math.sin(a) * rr * 0.8, rnd() * 6.2832, 4.5 + rnd() * 4.5, pick(tr.leafCols));
            }
          }
        }
      }
    },
    done: function (s) {
      for (var i = 0; i < s.plants.length; i++) {
        var t = s.plants[i];
        if (t.t < 1 || t.plan.length) { return false; }
        for (var b = 0; b < t.branches.length; b++) { var br = t.branches[b]; if (br.t < 1 || br.leaves < br.leafTarget) { return false; } }
      }
      return true;
    }
  };

  // desert: columnar cacti with arms and spines, the odd flower on top, on sandy dirt
  FLORA.cacti = {
    init: function (s) {
      var cw = s.cw, ch = s.ch, chh = s.opts.cactusHeight, growMs = s.opts.growMs;
      var count = Math.max(2, Math.round(cw / 110));
      for (var i = 0; i < count; i++) {
        var x = (i + 0.2 + rnd() * 0.6) * cw / count, sy = soilY(s, x);
        var barrel = rnd() < 0.3;
        var h = barrel ? 14 + rnd() * 10 : Math.min(sy - 8, (chh[0] + rnd() * (chh[1] - chh[0])) * ch);
        var arms = [];
        if (!barrel) { var na = Math.floor(rnd() * 3); for (var a = 0; a < na; a++) { arms.push({ side: a % 2 ? 1 : -1, at: 0.35 + rnd() * 0.35, len: 10 + rnd() * 16, t: 0, stroke: null, px: 0, py: 0 }); } }
        s.plants.push({
          kind: 'cactus', x: x, sy: sy, h: h, w: barrel ? 14 + rnd() * 6 : 7 + rnd() * 6, t: 0, delay: rnd() * growMs * 0.3,
          rate: 1 / (growMs * (0.3 + rnd() * 0.45)), col: pick(CACTUS_COL), arms: arms, spineAcc: 0,
          flower: rnd() < 0.5 ? pick(CACTUS_FLOWER_COL) : null, stroke: null, px: x, py: sy, bloomed: false
        });
      }
    },
    step: function (s, dt, k, elapsed) {
      var pl = s.plants;
      for (var i = 0; i < pl.length; i++) {
        var ca = pl[i];
        if (elapsed < ca.delay) { continue; }
        if (!ca.stroke) { ca.stroke = startStroke(s, ca.x, ca.sy + 2, ca.w, ca.col); }
        if (ca.t < 1) {
          ca.t = Math.min(1, ca.t + ca.rate * dt);
          var ny = ca.sy - ca.h * ca.t;
          extendStroke(s, ca.stroke, ca.px, ca.py, ca.x, ny, ca.w);
          ca.spineAcc += ca.py - ny; ca.py = ny;
          while (ca.spineAcc >= 6) { // spines: tiny pale strokes either side
            ca.spineAcc -= 6;
            for (var sd = -1; sd <= 1; sd += 2) {
              var sx = ca.x + sd * ca.w * 0.5, sp = startStroke(s, sx, ny, 0.8, '#f3f0d8');
              sp.pts.push(sx + sd * 2.5, ny - 1.5); extendStroke(s, sp, sx, ny, sx + sd * 2.5, ny - 1.5, 0.8);
            }
          }
          if (ca.t === 1) { ca.stroke.pts.push(ca.x, ny); }
        }
        for (var a = 0; a < ca.arms.length; a++) {
          var arm = ca.arms[a];
          if (ca.t < arm.at) { continue; }
          if (!arm.stroke) { arm.px = ca.x + arm.side * ca.w * 0.4; arm.py = ca.sy - ca.h * arm.at; arm.stroke = startStroke(s, arm.px, arm.py, ca.w * 0.7, ca.col); }
          if (arm.t < 1) {
            arm.t = Math.min(1, arm.t + ca.rate * 1.5 * dt);
            // out sideways for the first 40%, then up
            var u = arm.t, ox = ca.x + arm.side * ca.w * 0.4, oy = ca.sy - ca.h * arm.at;
            var ax = u < 0.4 ? ox + arm.side * arm.len * (u / 0.4) : ox + arm.side * arm.len;
            var ay = u < 0.4 ? oy : oy - arm.len * 1.2 * ((u - 0.4) / 0.6);
            extendStroke(s, arm.stroke, arm.px, arm.py, ax, ay, ca.w * 0.7);
            arm.px = ax; arm.py = ay;
            if (arm.t === 1) { arm.stroke.pts.push(ax, ay); }
          }
        }
        if (ca.t === 1 && ca.flower && !ca.bloomed) {
          ca.bloomed = true;
          addBloom(s, { kind: 'flower', x: ca.x, y: ca.sy - ca.h - ca.w * 0.3, r: 3.5 + rnd() * 2.5, col: ca.flower, c2: '#fff1a8', n: 6, rot: rnd() * 6.2832 });
        }
      }
      stepBlooms(s, dt);
    },
    done: function (s) {
      if (s.blooms.length) { return false; }
      for (var i = 0; i < s.plants.length; i++) { var ca = s.plants[i]; if (ca.t < 1) { return false; } for (var a = 0; a < ca.arms.length; a++) { if (ca.arms[a].t < 1) { return false; } } }
      return true;
    }
  };

  // ---- groundcover: low tufts and clover over the dirt itself, in most biomes
  var COVER_DENSITY = { garden: 0.5, meadow: 0, trellis: 1, hedgerow: 1, forest: 0.9, desert: 0 };
  var COVER_COL = ['#4f7f3a', '#5e8f44', '#6f9a4a', '#3f6e33', '#7aa052'];

  function initCover(s) {
    var d = s.flora === 'none' ? 0 : (COVER_DENSITY[s.biome] || 0);
    s.coverTarget = Math.round(s.dirtCells / 40 * d); s.coverCount = 0;
  }

  function stepCover(s, k) {
    if (s.coverCount >= s.coverTarget) { return; }
    var W = s.W, H = s.H, cs = s.opts.cellSize, g = s.grid, tops = s.tops;
    var want = (rnd() < 0.7 * k ? 1 : 0) + (rnd() < 0.3 * k ? 1 : 0);
    for (var n = 0; n < want && s.coverCount < s.coverTarget; n++) {
      var x = Math.floor(rnd() * W), top = tops[x]; if (top >= H) { continue; }
      var y = top + Math.floor(rnd() * (H - top)); if (!g[y * W + x]) { continue; }
      var px = (x + 0.5) * cs, py = (y + 0.5) * cs, col = pick(COVER_COL);
      if (rnd() < 0.7) {
        var blades = 2 + Math.floor(rnd() * 3);
        for (var b = 0; b < blades; b++) {
          var h = 4 + rnd() * 7, lean = (rnd() - 0.5) * 1.2, bx = px + (rnd() - 0.5) * 3;
          var st = startStroke(s, bx, py, 0.9, col);
          st.w1 = 0.4; st.pts.push(bx + lean * h * 0.3, py - h * 0.55, bx + lean * h, py - h);
          paintStroke(s.gctx, st, function (a, b2) { return [a, b2]; });
        }
      } else {
        drawLeaf(s, px, py, rnd() * 6.2832, 2 + rnd() * 1.5, col);
        drawLeaf(s, px, py, rnd() * 6.2832, 2 + rnd() * 1.5, col);
      }
      s.coverCount++;
    }
  }

  // dirt only: the spill-over that lands on the pages after a buried one
  FLORA.none = { init: function () {}, step: function () {}, done: function () { return true; } };

  function initGarden(s) {
    s.tips = []; s.vines = []; s.bushes = []; s.plants = []; s.blooms = []; s.clusters = []; s.scene = [];
    s.dirtCells = s.filled;
    initCover(s);
    FLORA[s.flora].init(s);
  }

  function stepGrow(s, dt, k) {
    var elapsed = now() - s.tPhase;
    stepCover(s, k);
    FLORA[s.flora].step(s, dt, k, elapsed);
    if ((s.frames & 15) === 0 && ((FLORA[s.flora].done(s) && s.coverCount >= s.coverTarget) || elapsed > s.opts.growMs * 1.8)) {
      setPhase(s, 'garden');
      s.running = false; // the garden stays on screen; nothing left to animate
    }
  }

  // ---------------------------------------------------------------- loop
  function setPhase(s, p) {
    s.phase = p; s.tPhase = now();
    [s.btn, s.albumBtn].forEach(function (b) { if (b) { if (p === 'garden') { b.classList.add('on'); } else { b.classList.remove('on'); } } });
    if (typeof s.opts.onPhase === 'function') { try { s.opts.onPhase(p, API); } catch (e) { /* host callback error ignored */ } }
  }

  function recordStats(s, dt, simMs, drawMs) {
    var st = s.stats;
    st.dts[st.di] = dt; st.di = (st.di + 1) % st.dts.length; if (st.dn < st.dts.length) { st.dn++; }
    st.simMs = st.simMs * 0.9 + simMs * 0.1;
    st.drawMs = st.drawMs * 0.9 + drawMs * 0.1;
    if (dt > 34) { st.longFrames++; }
    if ((s.frames % 30) === 0 && st.dn > 10) {
      var a = Array.prototype.slice.call(st.dts, 0, st.dn).sort(function (p, q) { return p - q; });
      st.p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    }
  }

  function frame(t) {
    var s = S;
    if (!s || !s.running) { return; }
    s.raf = root.requestAnimationFrame(frame);
    var dt = s.lastT ? Math.min(t - s.lastT, 100) : 16.7;
    s.lastT = t; s.frames++;
    var k = Math.min(dt / 16.667, 3); // time-scale so motion is frame-rate independent
    if ((s.frames & 7) === 0) { checkSize(s); }
    var t1 = now();
    if (s.phase === 'burying') { stepBury(s, dt); }
    var t2 = now();
    if (s.phase === 'growing') { stepGrow(s, dt, k); }
    var t3 = now();
    recordStats(s, dt, t2 - t1, t3 - t2);
    if (s.hud && (s.frames % 15) === 0) { s.hud.textContent = hudText(s); }
    if (!s.running) { s.raf = 0; }
  }

  function hudText(s) {
    var st = API.stats();
    return 'Dirt ' + VERSION + '  ' + s.phase + ' (' + s.biome + ')  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\n' +
      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\n' +
      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.fillActual * 100).toFixed(0) + '/' + (st.fill * 100).toFixed(0) + '%  flowers ' + (st.greenCoverage * 100).toFixed(0) + '%\n' +
      't ' + st.elapsed.toFixed(1) + 's  heartbeat ' + st.frames + (s.running ? '' : '  (done; loop idle, clock still ticking)');
  }

  function onResize() { if (S && S.host) { checkSize(S); } }

  // ---------------------------------------------------------------- snapshot & share
  function nextPaint() { return new Promise(function (res) { root.requestAnimationFrame(function () { root.requestAnimationFrame(res); }); }); }

  function dataUrlToBlob(u) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(u);
    if (!m) { return null; }
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
    return new Blob([arr], { type: m[1] });
  }

  // Picture of the garden alone (no page), composited by the module itself: needs no permission.
  function composeOverlay(s) {
    return new Promise(function (res) {
      var c = root.document.createElement('canvas');
      c.width = s.growCanvas.width; c.height = s.growCanvas.height;
      var x = c.getContext('2d');
      x.fillStyle = '#f7f4ee'; x.fillRect(0, 0, c.width, c.height);
      x.imageSmoothingEnabled = false;
      x.drawImage(s.dirtCanvas, 0, 0, c.width, c.height);
      x.imageSmoothingEnabled = true;
      x.drawImage(s.growCanvas, 0, 0);
      c.toBlob(function (b) { res(b); }, 'image/png');
    });
  }

  function showToast(s, text) {
    if (!s.toast) { return; }
    s.toast.textContent = text; s.toast.classList.add('on');
    clearTimeout(s.toastTimer);
    s.toastTimer = setTimeout(function () { if (s.toast) { s.toast.classList.remove('on'); } }, 1800);
  }

  function deliver(s, blob) {
    var nav = root.navigator, name = 'dirt-' + s.biome + '-' + new Date().toISOString().slice(0, 10) + '.png';
    var file = (typeof File !== 'undefined') ? new File([blob], name, { type: 'image/png' }) : null;
    if (file && nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      return nav.share({ files: [file], title: s.opts.shareTitle }).then(function () { showToast(s, 'Shared'); }, function (e) {
        if (!(e && e.name === 'AbortError')) { download(s, blob, name); }
      });
    }
    download(s, blob, name);
    return Promise.resolve();
  }

  function download(s, blob, name) {
    var doc = root.document, url = URL.createObjectURL(blob), a = doc.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
    showToast(s, 'Picture saved');
  }

  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }

  function setBiome(s, biome, legacyFlora) {
    var names = Object.keys(BIOMES);
    if (legacyFlora && LEGACY_FLORA[legacyFlora]) { biome = LEGACY_FLORA[legacyFlora]; }
    s.biome = BIOMES[biome] ? biome : names[Math.floor(rnd() * names.length)];
    s.flora = legacyFlora === 'none' ? 'none' : BIOMES[s.biome].flora;
    s.pal = PALETTES[BIOMES[s.biome].dirt].map(rgba32);
  }

  // Shared by start() and restore(): DOM, layout, listeners, size poll.
  function begin(s) {
    buildDom(s);
    layout(s, true);
    s.t0 = now(); s.running = true;
    root.addEventListener('resize', onResize);
    if (root.visualViewport) { root.visualViewport.addEventListener('resize', onResize); }
    // Size poll + HUD clock; keeps working after the loop idles and in contexts without resize events.
    s.timer = setInterval(function () {
      if (S !== s) { return; }
      checkSize(s);
      if (s.hud && !s.running) { s.hud.textContent = hudText(s); }
    }, 400);
  }


  // ---------------------------------------------------------------- API
  var API = {
    __dirt: true,
    version: VERSION,
    get phase() { return S ? S.phase : 'idle'; },
    get running() { return !!(S && S.running); },
    start: function (opts) {
      if (S && S.running) { return API; }
      if (S) { API.stop(); }
      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }
      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }
      var s = S = makeState(o);
      s.fillFrac = o.fill[0] + rnd() * (o.fill[1] - o.fill[0]);
      setBiome(s, o.biome, o.flora);
      begin(s);
      if (o.settled) {
        buildPile(s);
        initGarden(s);
        if (s.flora === 'none') { s.running = false; setPhase(s, 'garden'); if (s.hud) { s.hud.textContent = hudText(s); } return API; }
        setPhase(s, 'growing');
      } else {
        setPhase(s, 'burying');
      }
      s.raf = root.requestAnimationFrame(frame);
      return API;
    },
    // Serialise the current scene: biome, fill, soil profile and every plant primitive. A few
    // thousand numbers; the host (extension, app) decides where to keep it. Nothing is stored here.
    export: function () {
      var s = S; if (!s || s.phase === 'idle') { return null; }
      surfaceScan(s);
      var prof = [], i;
      for (i = 0; i < s.W; i++) { prof.push(Math.round((1 - s.tops[i] / s.H) * 1000) / 1000); }
      var ops = [];
      for (i = 0; i < s.scene.length; i++) {
        var op = s.scene[i];
        if (op.t === 0) { ops.push([0, r1(op.w0), r1(op.w1), op.col].concat(op.pts.map(r1))); }
        else if (op.t === 1) { ops.push([1, r1(op.x), r1(op.y), r2(op.a), r1(op.r), op.col]); }
        else if (op.t === 2) { ops.push([2, r1(op.x), r1(op.y), r1(op.r), op.col, op.c2, op.n, r2(op.rot)]); }
        else if (op.t === 3) { ops.push([3, r1(op.x), r1(op.y), op.dir, r1(op.len), r2(op.wob), op.col]); }
      }
      return { v: 1, version: VERSION, biome: s.biome, fill: s.fillFrac, viewport: [s.cw, s.ch], profile: prof, scene: ops, savedAt: Date.now() };
    },
    // A small mid-run snapshot (no plants): enough to continue the routine after the page is left
    // and returned to. The host saves it every couple of seconds and on page hide.
    checkpoint: function () {
      var s = S; if (!s || (s.phase !== 'burying' && s.phase !== 'growing')) { return null; }
      surfaceScan(s);
      var prof = [];
      for (var i = 0; i < s.W; i++) { prof.push(Math.round((1 - s.tops[i] / s.H) * 1000) / 1000); }
      return { v: 1, partial: true, version: VERSION, phase: s.phase, biome: s.biome, flora: s.flora, fill: s.fillFrac, viewport: [s.cw, s.ch], profile: prof, savedAt: Date.now() };
    },
    // Continue from a checkpoint: rebuild the pile so far, then keep throwing (if it was mid-bury)
    // or grow the garden (if the dirt had settled). A finished scene is simply restored.
    resume: function (data, opts) {
      if (!data || data.v !== 1) { return API; }
      if (!data.partial) { return API.restore(data, opts); }
      if (S) { API.stop(); }
      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }
      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }
      var s = S = makeState(o);
      s.fillFrac = data.fill;
      setBiome(s, data.biome, data.flora === 'none' ? 'none' : null);
      begin(s);
      pileFromProfile(s, data.profile);
      if (data.phase === 'burying') { setPhase(s, 'burying'); }
      else { initGarden(s); setPhase(s, 'growing'); }
      s.raf = root.requestAnimationFrame(frame);
      return API;
    },
    // Rebuild a saved scene in the current viewport, as a finished garden (no animation).
    restore: function (data, opts) {
      if (!data || data.v !== 1) { return API; }
      if (S) { API.stop(); }
      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }
      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }
      var s = S = makeState(o);
      s.fillFrac = data.fill;
      setBiome(s, data.biome, null);
      begin(s);
      pileFromProfile(s, data.profile);
      // plants, replayed through the viewport change
      var sc = data.scene, ops = [], i;
      for (i = 0; i < sc.length; i++) {
        var a = sc[i];
        if (a[0] === 0) { ops.push({ t: 0, w0: a[1], w1: a[2], col: a[3], pts: a.slice(4) }); }
        else if (a[0] === 1) { ops.push({ t: 1, x: a[1], y: a[2], a: a[3], r: a[4], col: a[5] }); }
        else if (a[0] === 2) { ops.push({ t: 2, x: a[1], y: a[2], r: a[3], col: a[4], c2: a[5], n: a[6], rot: a[7] }); }
        else if (a[0] === 3) { ops.push({ t: 3, x: a[1], y: a[2], dir: a[3], len: a[4], wob: a[5], col: a[6] }); }
      }
      s.scene = ops;
      var sx = s.cw / data.viewport[0], sy = s.ch / data.viewport[1];
      replayScene(s, function (px, py) { return [px * sx, py * sy]; });
      s.greenCov = 1;
      s.running = false;
      setPhase(s, 'garden');
      if (s.hud) { s.hud.textContent = hudText(s); }
      return API;
    },

    stop: function () {
      var s = S; if (!s) { return API; }
      s.running = false;
      if (s.raf) { root.cancelAnimationFrame(s.raf); }
      if (s.timer) { clearInterval(s.timer); }
      root.removeEventListener('resize', onResize);
      if (root.visualViewport) { root.visualViewport.removeEventListener('resize', onResize); }
      if (s.host && s.host.parentNode) { s.host.parentNode.removeChild(s.host); }
      setPhase(s, 'stopped');
      S = null;
      return API;
    },
    toggle: function (opts) { return (S && S.running) ? API.stop() : API.start(opts); },
    stats: function () {
      var s = S; if (!s) { return null; }
      var st = s.stats, sum = 0;
      for (var i = 0; i < st.dn; i++) { sum += st.dts[i]; }
      var avg = st.dn ? sum / st.dn : 0;
      return {
        version: VERSION, phase: s.phase, biome: s.biome, flora: s.flora, running: s.running,
        grid: [s.W, s.H], viewport: [s.cw, s.ch], dpr: s.dpr,
        fps: avg ? 1000 / avg : 0, avgFrameMs: avg, p95FrameMs: st.p95,
        simMs: st.simMs, drawMs: st.drawMs, longFrames: st.longFrames,
        frames: s.frames, elapsed: (now() - s.t0) / 1000,
        coverage: s.coverage, fill: s.fillFrac, fillActual: s.fillActual, fillPeak: s.fillPeak || 0, greenCoverage: s.greenCov,
        particles: s.particles.length, tips: s.tips.length, sceneOps: s.scene.length,
        vines: s.vines.filter(function (v) { return !v.done; }).length
      };
    },
    // Heartbeat for the extension spikes: call from outside (e.g. WKWebView.evaluateJavaScript)
    // a few seconds apart; if the number keeps rising, the loop survived.
    ping: function () { return S ? S.frames : -1; },
    // A PNG Blob of the garden alone (no page), composed by the module; needs no permission.
    picture: function () { return S ? composeOverlay(S) : Promise.resolve(null); },
    // Snapshot the page with its garden and hand it to the share sheet (or download it).
    // Uses opts.capture (whole tab, provided by the host) when available, else the garden alone.
    share: function () {
      var s = S; if (!s || s.sharing) { return Promise.resolve(false); }
      s.sharing = true;
      var hidden = [s.btn, s.albumBtn, s.hud, s.toast].filter(Boolean);
      hidden.forEach(function (el) { el.style.visibility = 'hidden'; });
      var cap = s.opts.capture;
      return nextPaint()
        .then(function () { return cap ? Promise.resolve().then(cap).catch(function () { return null; }) : null; })
        .then(function (shot) {
          if (typeof shot === 'string') { shot = dataUrlToBlob(shot); }
          return (shot && shot.size) ? shot : composeOverlay(s);
        })
        .then(function (blob) { hidden.forEach(function (el) { el.style.visibility = ''; }); return deliver(s, blob); })
        .then(function () { s.sharing = false; return true; }, function () { hidden.forEach(function (el) { el.style.visibility = ''; }); s.sharing = false; showToast(s, 'Could not share'); return false; });
    }
  };

  root.Dirt = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
