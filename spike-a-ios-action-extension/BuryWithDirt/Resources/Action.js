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
    flora: null,        // legacy alias: 'flowers' -> garden, 'vines' -> trellis, 'bushes' -> hedgerow
    buryMs: 20000,      // target time for the dirt to reach its fill line
    growMs: 25000,      // target time for the garden to finish
    simHz: 30,          // sand-simulation tick rate; lower = chunkier, more hand-animated motion
    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line
    treeHeight: [0.25, 0.42], // forest trees rise this fraction of the viewport height above the soil line
    cactusHeight: [0.12, 0.3],
    maxDpr: 2,          // cap device pixel ratio for the growth canvas
    maxTips: 320,       // concurrent growing bush tips
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
      host: null, shadow: null, dirtCanvas: null, growCanvas: null, hud: null,
      dctx: null, gctx: null, off: null, octx: null, img: null, buf: null,
      cw: 0, ch: 0, dpr: 1, W: 0, H: 0,
      grid: null, green: null,
      particles: [], tips: [], scene: [],
      shovelAcc: 0, shovelInterval: 70, shovelNext: 70, shovelCells: 60, simAcc: 0,
      coverage: 0, greenCov: 0, filled: 0, tops: null, topFull: 0,
      fillFrac: 0.4, fillActual: 0, targetTop: 0, topMean: 1e9, dirtCells: 0,
      biome: 'garden', flora: 'flowers', pal: PALETTES.loam.map(rgba32),
      vines: [], bushes: [], blooms: [], clusters: [], plants: [],
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
      'color:#b8ffb0;background:rgba(0,0,0,.72);border-radius:4px;white-space:pre;pointer-events:none;}';
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

    // Shovelfuls stay phone-sized (24–80 grains) and come more often on wide windows, so the
    // pile grows as many small heaps rather than a few towers. A quarter extra for grains lost to slides.
    var need = W * (H - s.targetTop) * 1.25;
    s.shovelCells = Math.max(24, Math.min(80, Math.round(need / 300)));
    s.shovelInterval = Math.max(12, s.opts.buryMs * s.shovelCells / need);

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
    return tops;
  }

  function spawnShovel(s) {
    var W = s.W, tops = surfaceScan(s);
    var bx;
    if (rnd() < 0.5 + 0.5 * s.topFull) {
      // Aim at a low point in the surface: pick the deepest of several random probes.
      var probes = 6 + Math.round(s.topFull * 24), bt = -1;
      for (var k = 0; k < probes; k++) {
        var cx = Math.floor(rnd() * W);
        if (tops[cx] > bt) { bt = tops[cx]; bx = cx; }
      }
      if (bt <= s.targetTop) { return false; } // every probe hit a finished column
    } else {
      bx = Math.floor(rnd() * W);
    }
    // Shovelfuls vary: some small and quick, some big and lazy; each clump has its own weight.
    var n = Math.round(s.shovelCells * (0.5 + rnd() * 1.1));
    var vx = (rnd() - 0.5) * 0.5, vy = 0.2 + rnd() * 0.5;
    var g = 0.02 + rnd() * 0.025, vmax = 0.9 + rnd() * 0.6;
    var spread = 2 + Math.sqrt(n) * 0.5;
    for (var i = 0; i < n; i++) {
      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;
      s.particles.push({
        x: bx + Math.cos(ang) * rad, y: -3 - Math.abs(Math.sin(ang) * rad) - rnd() * 6,
        vx: vx + (rnd() - 0.5) * 0.3, vy: vy + (rnd() - 0.5) * 0.2, g: g, vmax: vmax,
        c: 1 + Math.floor(rnd() * s.pal.length)
      });
    }
    return true;
  }

  function land(s, p) {
    var W = s.W, H = s.H, g = s.grid;
    var cx = Math.max(0, Math.min(W - 1, Math.floor(p.x)));
    var cy = Math.min(H - 1, Math.floor(p.y));
    while (cy >= 0 && g[cy * W + cx]) { cy--; }
    if (cy >= 0) { g[cy * W + cx] = p.c; }
  }

  function stepParticles(s, k) {
    var ps = s.particles, W = s.W, H = s.H, g = s.grid;
    var w = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      p.vx += (rnd() - 0.5) * 0.02 * k;         // a little turbulence so clumps loosen as they fall
      p.vx *= 1 - 0.02 * k;
      p.vy = Math.min(p.vmax, p.vy + p.g * k);  // terminal velocity: no bullet-fast grains
      p.x += p.vx * k; p.y += p.vy * k;
      if (p.x < 0) { p.x = 0; p.vx = -p.vx * 0.3; } else if (p.x >= W) { p.x = W - 0.01; p.vx = -p.vx * 0.3; }
      var cy = Math.floor(p.y), cx = Math.floor(p.x);
      if (cy >= H - 1 || (cy >= 0 && (g[cy * W + cx] || g[(cy + 1) * W + cx]))) { land(s, p); continue; }
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
          else if (y + 2 < H && !g[below2 + nx] && (y === 0 || !g[row - W + x]) && (seed & 4) === 0) {
            g[row + nx] = v; g[i] = 0; moved = true;   // shallow slope: step sideways, fall next tick
          }
        }
      }
    }
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

  // forest: tall trunks with a few branches and a leafy canopy, on dark loam
  FLORA.trees = {
    init: function (s) {
      var cw = s.cw, ch = s.ch, th = s.opts.treeHeight, growMs = s.opts.growMs;
      var count = Math.max(2, Math.round(cw / 140));
      for (var i = 0; i < count; i++) {
        var x = (i + 0.25 + rnd() * 0.5) * cw / count, sy = soilY(s, x);
        var h = Math.min(sy - 10, (th[0] + rnd() * (th[1] - th[0])) * ch);
        s.plants.push({
          kind: 'tree', x: x, sy: sy, h: h, w: 4 + rnd() * 5, t: 0, delay: rnd() * growMs * 0.3,
          rate: 1 / (growMs * (0.35 + rnd() * 0.4)), sway: (rnd() - 0.5) * 0.25, trunkCol: pick(TRUNK_COL),
          leafCols: [pick(CANOPY_COL), pick(CANOPY_COL), pick(CANOPY_COL)], leaves: 0,
          leafTarget: Math.round(90 + h * 0.9), branches: [], stroke: null, px: x, py: sy
        });
      }
    },
    step: function (s, dt, k, elapsed) {
      var pl = s.plants;
      for (var i = 0; i < pl.length; i++) {
        var tr = pl[i];
        if (elapsed < tr.delay) { continue; }
        if (!tr.stroke) { tr.stroke = startStroke(s, tr.x, tr.sy + 2, tr.w, tr.trunkCol); tr.stroke.w1 = tr.w * 0.5; }
        if (tr.t < 1) {
          tr.t = Math.min(1, tr.t + tr.rate * dt);
          var ny = tr.sy - tr.h * tr.t, nx = tr.x + Math.sin(tr.t * 3.1) * tr.sway * tr.h * 0.15;
          extendStroke(s, tr.stroke, tr.px, tr.py, nx, ny, tr.w * (1 - 0.5 * tr.t));
          tr.px = nx; tr.py = ny;
          // branches start partway up and grow with the trunk
          if (tr.t > 0.5 && tr.branches.length < 3 && rnd() < 0.03 * k) {
            var side = tr.branches.length % 2 ? 1 : -1, len = tr.h * (0.18 + rnd() * 0.14), ang = -1.5708 + side * (0.6 + rnd() * 0.5);
            tr.branches.push({ x: nx, y: ny, ang: ang, len: len, t: 0, stroke: startStroke(s, nx, ny, tr.w * 0.45, tr.trunkCol), px: nx, py: ny });
          }
        }
        for (var b = 0; b < tr.branches.length; b++) {
          var br = tr.branches[b];
          if (br.t < 1) {
            br.t = Math.min(1, br.t + tr.rate * 1.6 * dt);
            var bx = br.x + Math.cos(br.ang) * br.len * br.t, by = br.y + Math.sin(br.ang) * br.len * br.t;
            extendStroke(s, br.stroke, br.px, br.py, bx, by, tr.w * 0.45 * (1 - 0.5 * br.t));
            br.px = bx; br.py = by;
            if (rnd() < 0.25 * k) { drawLeaf(s, bx, by, br.ang + (rnd() < 0.5 ? 1 : -1) * (0.9 + rnd() * 0.6), 4 + rnd() * 4, pick(tr.leafCols)); }
          }
        }
        // canopy grows outward from the top of the trunk: leaf j of N sits at radius R*sqrt(j/N),
        // so each ring fills before the next, like a crown spreading from the inside
        if (tr.t > 0.6 && tr.leaves < tr.leafTarget) {
          var n = 1 + Math.floor(rnd() * 3 * k), cyc = tr.sy - tr.h * 0.78, rx = tr.h * 0.3, ry = tr.h * 0.26;
          for (var j = 0; j < n && tr.leaves < tr.leafTarget; j++, tr.leaves++) {
            var a = rnd() * 6.2832, rr = Math.sqrt((tr.leaves + rnd()) / tr.leafTarget);
            drawLeaf(s, tr.x + Math.cos(a) * rx * rr, cyc + Math.sin(a) * ry * rr, rnd() * 6.2832, 5 + rnd() * 5, pick(tr.leafCols));
          }
        }
      }
    },
    done: function (s) { for (var i = 0; i < s.plants.length; i++) { var t = s.plants[i]; if (t.t < 1 || t.leaves < t.leafTarget) { return false; } } return true; }
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

  function initGarden(s) {
    s.tips = []; s.vines = []; s.bushes = []; s.plants = []; s.blooms = []; s.clusters = []; s.scene = [];
    s.dirtCells = s.filled;
    FLORA[s.flora].init(s);
  }

  function stepGrow(s, dt, k) {
    var elapsed = now() - s.tPhase;
    FLORA[s.flora].step(s, dt, k, elapsed);
    if ((s.frames & 15) === 0 && (FLORA[s.flora].done(s) || elapsed > s.opts.growMs * 1.8)) {
      setPhase(s, 'garden');
      s.running = false; // the garden stays on screen; nothing left to animate
    }
  }

  // ---------------------------------------------------------------- loop
  function setPhase(s, p) {
    s.phase = p; s.tPhase = now();
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

  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }

  function setBiome(s, biome, legacyFlora) {
    var names = Object.keys(BIOMES);
    if (legacyFlora && LEGACY_FLORA[legacyFlora]) { biome = LEGACY_FLORA[legacyFlora]; }
    s.biome = BIOMES[biome] ? biome : names[Math.floor(rnd() * names.length)];
    s.flora = BIOMES[s.biome].flora;
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
      setPhase(s, 'burying');
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
      // soil from the saved per-column depth profile
      var W = s.W, H = s.H, prof = data.profile, g = s.grid, x, y;
      for (x = 0; x < W; x++) {
        var depth = Math.round(prof[Math.min(prof.length - 1, Math.floor(x * prof.length / W))] * H);
        for (y = H - depth; y < H; y++) { g[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }
      }
      surfaceScan(s); countFilled(s); s.dirtCells = s.filled; drawDirt(s);
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
        coverage: s.coverage, fill: s.fillFrac, fillActual: s.fillActual, greenCoverage: s.greenCov,
        particles: s.particles.length, tips: s.tips.length, sceneOps: s.scene.length,
        vines: s.vines.filter(function (v) { return !v.done; }).length
      };
    },
    // Heartbeat for the extension spikes: call from outside (e.g. WKWebView.evaluateJavaScript)
    // a few seconds apart; if the number keeps rising, the loop survived.
    ping: function () { return S ? S.frames : -1; }
  };

  root.Dirt = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));

// ---- embedded copy of the module source, for the script-tag fallback ----
var DIRT_CORE_SOURCE = "/*!\n * dirt-core.js — \"Dirt\" by Mark Sample. Phase-1 feasibility spike.\n *\n * One self-contained, dependency-free module. It never reads or changes the\n * host page; it only draws on top of it:\n *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM\n *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,\n *     a device-resolution persistent canvas for the plants)\n *   - the dirt buries a third to a half of the viewport from the bottom; the page stays visible above it\n *   - then one biome, chosen at random per run, each with its own dirt colour and flora: garden\n *     (ground flowers), meadow (grass and wildflowers), trellis (vines up both edges), hedgerow\n *     (flowering bushes), forest (tall trees, dark loam), desert (cacti, sandy dirt)\n *   - Dirt.export() / Dirt.restore(data) save and replay a finished garden (the host extension\n *     decides where to keep it; the module itself stores nothing)\n *   - rotation / resize keeps the scene: the pile is rebuilt from its surface profile and the\n *     plants are replayed from a display list at their original sizes\n *   - no data collection, no network requests, no storage\n *\n * Usage:   Dirt.start({ debug: true })   Dirt.stop()   Dirt.stats()   Dirt.phase\n *\n * Plain ES2017 inside an IIFE so the same file can be inlined into a <script>,\n * a Safari Action-extension preprocessing file, a Web Extension content script,\n * or a WKUserScript without any build step.\n */\n(function (root) {\n  'use strict';\n  if (root.Dirt && root.Dirt.__dirt) { return; }\n\n  var VERSION = '0.3.0';\n  var MAX_Z = 2147483647;\n  var TAG = 'dirt-overlay';\n\n  var DEFAULTS = {\n    cellSize: 4,        // CSS px per simulation cell (dirt grid resolution)\n    fill: [0.33, 0.5],  // how much of the viewport the dirt buries (fraction of height, picked at random)\n    biome: 'random',    // 'garden' | 'meadow' | 'trellis' | 'hedgerow' | 'forest' | 'desert' | 'random'\n    flora: null,        // legacy alias: 'flowers' -> garden, 'vines' -> trellis, 'bushes' -> hedgerow\n    buryMs: 20000,      // target time for the dirt to reach its fill line\n    growMs: 25000,      // target time for the garden to finish\n    simHz: 30,          // sand-simulation tick rate; lower = chunkier, more hand-animated motion\n    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line\n    treeHeight: [0.25, 0.42], // forest trees rise this fraction of the viewport height above the soil line\n    cactusHeight: [0.12, 0.3],\n    maxDpr: 2,          // cap device pixel ratio for the growth canvas\n    maxTips: 320,       // concurrent growing bush tips\n    debug: false,       // show the FPS / heartbeat HUD\n    onPhase: null       // function(phase, dirt) — 'burying' | 'growing' | 'garden' | 'stopped'\n  };\n\n  // ---------------------------------------------------------------- helpers\n  var now = (root.performance && root.performance.now) ? function () { return root.performance.now(); } : function () { return Date.now(); };\n\n  // Small PRNG (xorshift32); Math.random is fine but this is cheaper in hot loops.\n  var seed = (Date.now() & 0x7fffffff) || 1;\n  function rnd() {\n    if (!seed) { seed = 0x9e3779b9; }\n    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;\n    return ((seed >>> 0) % 1000000) / 1000000;\n  }\n\n  function rgba32(hex) { // '#rrggbb' -> little-endian ABGR uint32 for ImageData buffers\n    var n = parseInt(hex.slice(1), 16);\n    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;\n    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;\n  }\n\n  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }\n\n  var PALETTES = {\n    loam: ['#5b3a21', '#6b4426', '#4a2e18', '#7a5230', '#3f2713', '#86592f', '#56361f'],\n    dark: ['#3e2a17', '#4a3119', '#2f1f10', '#55391f', '#3a2614', '#5e4224', '#33220f'],\n    sand: ['#d9c08a', '#c9ad73', '#e3cc9a', '#b89a62', '#cdb37e', '#a98b55', '#d4ba84']\n  };\n  // Each biome names a dirt palette and a flora system; the flora systems live in FLORA below.\n  var BIOMES = {\n    garden:   { dirt: 'loam', flora: 'flowers' },\n    meadow:   { dirt: 'loam', flora: 'grass' },\n    trellis:  { dirt: 'loam', flora: 'vines' },\n    hedgerow: { dirt: 'loam', flora: 'bushes' },\n    forest:   { dirt: 'dark', flora: 'trees' },\n    desert:   { dirt: 'sand', flora: 'cacti' }\n  };\n  var LEGACY_FLORA = { flowers: 'garden', vines: 'trellis', bushes: 'hedgerow' };\n  var STEM_COL = ['#2f6b2a', '#3b8a33', '#4a9c3c', '#5aa84a'];\n  var LEAF_COL = ['#55a33b', '#6cbf45', '#8fd45a', '#3f8f36', '#79c94f', '#a3e06a'];\n  var FLOWER_COL = ['#fff6d5', '#ffd84a', '#ff8fb1', '#c9a6ff', '#ff6f59', '#ffb347', '#f7f7f7', '#e04f8a'];\n  var VINE_FLOWER_COL = ['#7b5cff', '#c66bd6', '#ff8fb1', '#5aa9ff', '#f4f0ff'];\n  var BUSH_FLOWER_COL = ['#ff5d8f', '#ffd166', '#ffffff', '#ff8c42', '#d96bff', '#ff4d6d'];\n  var GRASS_COL = ['#5f9e3a', '#7bb544', '#9ccc4e', '#86a83a', '#b8c95a', '#6aa23c'];\n  var WILD_COL = ['#ffffff', '#ffe066', '#c9a6ff', '#ff8fb1', '#9ad0ff'];\n  var TRUNK_COL = ['#5a3a1e', '#6b4423', '#4a2f17', '#7a5230'];\n  var CANOPY_COL = ['#1f5a2a', '#2e7d32', '#3b8f3a', '#4caf50', '#6abf5c', '#357a38'];\n  var CACTUS_COL = ['#3f7d3a', '#4f8f45', '#5c9a4b', '#2f6b2e', '#6aa85a'];\n  var CACTUS_FLOWER_COL = ['#ff5fa2', '#ffd23f', '#ffffff', '#ff8c42'];\n\n  // ---------------------------------------------------------------- state\n  var S = null; // live state while running\n\n  function makeState(opts) {\n    return {\n      opts: opts,\n      phase: 'idle',\n      host: null, shadow: null, dirtCanvas: null, growCanvas: null, hud: null,\n      dctx: null, gctx: null, off: null, octx: null, img: null, buf: null,\n      cw: 0, ch: 0, dpr: 1, W: 0, H: 0,\n      grid: null, green: null,\n      particles: [], tips: [], scene: [],\n      shovelAcc: 0, shovelInterval: 70, shovelNext: 70, shovelCells: 60, simAcc: 0,\n      coverage: 0, greenCov: 0, filled: 0, tops: null, topFull: 0,\n      fillFrac: 0.4, fillActual: 0, targetTop: 0, topMean: 1e9, dirtCells: 0,\n      biome: 'garden', flora: 'flowers', pal: PALETTES.loam.map(rgba32),\n      vines: [], bushes: [], blooms: [], clusters: [], plants: [],\n      t0: 0, tPhase: 0, lastT: 0, frames: 0, raf: 0, timer: 0,\n      stats: { dts: new Float32Array(120), di: 0, dn: 0, simMs: 0, drawMs: 0, longFrames: 0, p95: 0 },\n      running: false\n    };\n  }\n\n  // ---------------------------------------------------------------- DOM\n  function buildDom(s) {\n    var doc = root.document;\n    var host = doc.createElement(TAG);\n    host.setAttribute('aria-hidden', 'true');\n    // Inline !important beats any host-page stylesheet short of its own !important on a matching selector.\n    host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +\n      'width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;' +\n      'z-index:' + MAX_Z + '!important;pointer-events:none!important;display:block!important;' +\n      'transform:none!important;opacity:1!important;visibility:visible!important;contain:strict;';\n    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;\n    var style = doc.createElement('style');\n    style.textContent = ':host{all:initial;display:block}' +\n      'canvas{position:absolute;top:0;left:0;width:100%;height:100%;display:block;image-rendering:pixelated;}' +\n      '.hud{position:absolute;top:env(safe-area-inset-top,0);left:0;margin:4px;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;' +\n      'color:#b8ffb0;background:rgba(0,0,0,.72);border-radius:4px;white-space:pre;pointer-events:none;}';\n    shadow.appendChild(style);\n    var dirtCanvas = doc.createElement('canvas');\n    var growCanvas = doc.createElement('canvas');\n    shadow.appendChild(dirtCanvas);\n    shadow.appendChild(growCanvas);\n    if (s.opts.debug) {\n      var hud = doc.createElement('div');\n      hud.className = 'hud';\n      shadow.appendChild(hud);\n      s.hud = hud;\n    }\n    (doc.documentElement || doc.body).appendChild(host);\n    s.host = host; s.shadow = shadow; s.dirtCanvas = dirtCanvas; s.growCanvas = growCanvas;\n    s.dctx = dirtCanvas.getContext('2d', { alpha: true });\n    s.gctx = growCanvas.getContext('2d', { alpha: true });\n  }\n\n  function viewportSize(s) {\n    var r = s.host.getBoundingClientRect();\n    var w = Math.round(r.width) || root.innerWidth || 320;\n    var h = Math.round(r.height) || root.innerHeight || 480;\n    return [w, h];\n  }\n\n  // Allocate canvases and grid for the current viewport. On a resize the old scene is carried over:\n  //   - a modest height-only change (Safari's address bar) translates everything to stay bottom-anchored\n  //   - anything else (rotation, window resize) scales anchor positions proportionally, rebuilds the\n  //     pile from the old surface profile, and replays the plants at their original sizes\n  function layout(s, first) {\n    var wh = viewportSize(s), cw = wh[0], ch = wh[1];\n    var dpr = Math.min(root.devicePixelRatio || 1, s.opts.maxDpr);\n    if (!first && cw === s.cw && ch === s.ch && dpr === s.dpr) { return; }\n    var cs = s.opts.cellSize;\n    var W = Math.max(8, Math.ceil(cw / cs)), H = Math.max(8, Math.ceil(ch / cs));\n    var W0 = s.W, H0 = s.H, cw0 = s.cw, ch0 = s.ch;\n    var anchor = !first && cw === cw0 && Math.abs(ch - ch0) < ch0 * 0.3;\n    var sx = first ? 1 : cw / cw0, sy = first ? 1 : ch / ch0, dy = ch - ch0;\n    var T = anchor ? function (x, y) { return [x, y + dy]; } : function (x, y) { return [x * sx, y * sy]; };\n\n    s.dirtCanvas.width = W * Math.min(dpr, 2); s.dirtCanvas.height = H * Math.min(dpr, 2);\n    s.growCanvas.width = Math.round(cw * dpr); s.growCanvas.height = Math.round(ch * dpr);\n    s.gctx.setTransform(dpr, 0, 0, dpr, 0, 0);\n    s.gctx.lineCap = 'round'; s.gctx.lineJoin = 'round';\n    s.dctx.imageSmoothingEnabled = false;\n\n    var grid = new Uint8Array(W * H), green = new Uint8Array(W * H);\n    if (s.grid) {\n      var x, y, i;\n      if (anchor) {\n        var dyCells = H - H0;\n        for (y = 0; y < H; y++) {\n          var srow = y - dyCells;\n          if (srow < 0 || srow >= H0) { continue; }\n          grid.set(s.grid.subarray(srow * W0, srow * W0 + Math.min(W, W0)), y * W);\n          green.set(s.green.subarray(srow * W0, srow * W0 + Math.min(W, W0)), y * W);\n        }\n        for (i = 0; i < s.particles.length; i++) { s.particles[i].y += dyCells; }\n      } else {\n        // Rebuild the pile from the old surface profile: same depth fraction per column.\n        surfaceScan(s);\n        for (x = 0; x < W; x++) {\n          var ox = Math.min(W0 - 1, Math.floor(x * W0 / W));\n          var depth = Math.round((H0 - s.tops[ox]) * H / H0);\n          for (y = H - depth; y < H; y++) { grid[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }\n        }\n        for (y = 0; y < H; y++) {\n          var oy = Math.min(H0 - 1, Math.floor(y * H0 / H));\n          for (x = 0; x < W; x++) { green[y * W + x] = s.green[oy * W0 + Math.min(W0 - 1, Math.floor(x * W0 / W))]; }\n        }\n        for (i = 0; i < s.particles.length; i++) { s.particles[i].x *= W / W0; s.particles[i].y *= H / H0; }\n      }\n      // Everything that remembers a CSS-px position moves through the same transform.\n      var p;\n      for (i = 0; i < s.tips.length; i++) { p = T(s.tips[i].x, s.tips[i].y); s.tips[i].x = p[0]; s.tips[i].y = p[1]; }\n      for (i = 0; i < s.vines.length; i++) {\n        var v = s.vines[i];\n        p = T(v.x, v.y); v.x = p[0]; v.y = p[1];\n        p = T(v.px, v.py); v.px = p[0]; v.py = p[1];\n        v.baseX = T(v.baseX, 0)[0];\n        v.v = anchor ? v.v : v.v * sy;\n      }\n      for (i = 0; i < s.bushes.length; i++) {\n        var b = s.bushes[i];\n        b.x = T(b.x, 0)[0]; b.sy = T(0, b.sy)[1]; b.top = T(0, b.top)[1]; b.h = b.sy - b.top;\n        b.v = anchor ? b.v : b.v * sy;\n      }\n      for (i = 0; i < s.plants.length; i++) {\n        var pl = s.plants[i];\n        pl.x = T(pl.x, 0)[0]; pl.sy = T(0, pl.sy)[1]; if (pl.h) { pl.h = anchor ? pl.h : pl.h * sy; }\n        p = T(pl.px, pl.py); pl.px = p[0]; pl.py = p[1];\n      }\n      for (i = 0; i < s.blooms.length; i++) { p = T(s.blooms[i].x, s.blooms[i].y); s.blooms[i].x = p[0]; s.blooms[i].y = p[1]; }\n      for (i = 0; i < s.clusters.length; i++) { p = T(s.clusters[i].x, s.clusters[i].y); s.clusters[i].x = p[0]; s.clusters[i].y = p[1]; }\n    }\n    s.cw = cw; s.ch = ch; s.dpr = dpr; s.W = W; s.H = H; s.grid = grid; s.green = green; s.tops = new Int16Array(W);\n    s.targetTop = Math.max(1, H - Math.round(H * s.fillFrac)); // row the dirt surface must reach\n    s.off = s.off || root.document.createElement('canvas');\n    s.off.width = W; s.off.height = H;\n    s.octx = s.off.getContext('2d');\n    s.img = s.octx.createImageData(W, H);\n    s.buf = new Uint32Array(s.img.data.buffer);\n\n    // Shovelfuls stay phone-sized (24–80 grains) and come more often on wide windows, so the\n    // pile grows as many small heaps rather than a few towers. A quarter extra for grains lost to slides.\n    var need = W * (H - s.targetTop) * 1.25;\n    s.shovelCells = Math.max(24, Math.min(80, Math.round(need / 300)));\n    s.shovelInterval = Math.max(12, s.opts.buryMs * s.shovelCells / need);\n\n    if (!first) {\n      surfaceScan(s);\n      countFilled(s);\n      if (s.phase !== 'burying') { s.dirtCells = s.filled; }\n      drawDirt(s);              // resizing a canvas clears it\n      replayScene(s, T);        // plants: replay the display list through the transform\n      if (s.hud) { s.hud.textContent = hudText(s); }\n    }\n  }\n\n  function checkSize(s) {\n    // Resize events do not reach every injection context (Safari's share-sheet script, for one),\n    // so the size is also polled from the frame loop and from a timer.\n    var wh = viewportSize(s);\n    if (wh[0] !== s.cw || wh[1] !== s.ch) { layout(s, false); }\n  }\n\n  // ---------------------------------------------------------------- dirt phase\n  function columnTop(s, x) { // index of highest dirt cell in column (H if empty)\n    var g = s.grid, W = s.W, H = s.H;\n    for (var y = 0; y < H; y++) { if (g[y * W + x]) { return y; } }\n    return H;\n  }\n\n  function surfaceScan(s) { // tops[x] = row of highest dirt cell (H if empty); also mean/fraction done\n    var W = s.W, H = s.H, tops = s.tops || (s.tops = new Int16Array(W)), full = 0, sum = 0;\n    for (var x = 0; x < W; x++) { var t = columnTop(s, x); tops[x] = t; sum += t; if (t <= s.targetTop) { full++; } }\n    s.topFull = full / W;\n    s.topMean = sum / W;\n    s.fillActual = 1 - s.topMean / H;\n    return tops;\n  }\n\n  function spawnShovel(s) {\n    var W = s.W, tops = surfaceScan(s);\n    var bx;\n    if (rnd() < 0.5 + 0.5 * s.topFull) {\n      // Aim at a low point in the surface: pick the deepest of several random probes.\n      var probes = 6 + Math.round(s.topFull * 24), bt = -1;\n      for (var k = 0; k < probes; k++) {\n        var cx = Math.floor(rnd() * W);\n        if (tops[cx] > bt) { bt = tops[cx]; bx = cx; }\n      }\n      if (bt <= s.targetTop) { return false; } // every probe hit a finished column\n    } else {\n      bx = Math.floor(rnd() * W);\n    }\n    // Shovelfuls vary: some small and quick, some big and lazy; each clump has its own weight.\n    var n = Math.round(s.shovelCells * (0.5 + rnd() * 1.1));\n    var vx = (rnd() - 0.5) * 0.5, vy = 0.2 + rnd() * 0.5;\n    var g = 0.02 + rnd() * 0.025, vmax = 0.9 + rnd() * 0.6;\n    var spread = 2 + Math.sqrt(n) * 0.5;\n    for (var i = 0; i < n; i++) {\n      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;\n      s.particles.push({\n        x: bx + Math.cos(ang) * rad, y: -3 - Math.abs(Math.sin(ang) * rad) - rnd() * 6,\n        vx: vx + (rnd() - 0.5) * 0.3, vy: vy + (rnd() - 0.5) * 0.2, g: g, vmax: vmax,\n        c: 1 + Math.floor(rnd() * s.pal.length)\n      });\n    }\n    return true;\n  }\n\n  function land(s, p) {\n    var W = s.W, H = s.H, g = s.grid;\n    var cx = Math.max(0, Math.min(W - 1, Math.floor(p.x)));\n    var cy = Math.min(H - 1, Math.floor(p.y));\n    while (cy >= 0 && g[cy * W + cx]) { cy--; }\n    if (cy >= 0) { g[cy * W + cx] = p.c; }\n  }\n\n  function stepParticles(s, k) {\n    var ps = s.particles, W = s.W, H = s.H, g = s.grid;\n    var w = 0;\n    for (var i = 0; i < ps.length; i++) {\n      var p = ps[i];\n      p.vx += (rnd() - 0.5) * 0.02 * k;         // a little turbulence so clumps loosen as they fall\n      p.vx *= 1 - 0.02 * k;\n      p.vy = Math.min(p.vmax, p.vy + p.g * k);  // terminal velocity: no bullet-fast grains\n      p.x += p.vx * k; p.y += p.vy * k;\n      if (p.x < 0) { p.x = 0; p.vx = -p.vx * 0.3; } else if (p.x >= W) { p.x = W - 0.01; p.vx = -p.vx * 0.3; }\n      var cy = Math.floor(p.y), cx = Math.floor(p.x);\n      if (cy >= H - 1 || (cy >= 0 && (g[cy * W + cx] || g[(cy + 1) * W + cx]))) { land(s, p); continue; }\n      ps[w++] = p;\n    }\n    ps.length = w;\n  }\n\n  // Falling-sand step, bottom row up. Two slide rules: the usual 45° diagonal slide, plus a\n  // shallower one (sideways when the ground two cells down on that side is empty) applied at\n  // random, which rounds the peaks instead of leaving sharp 45° ridges.\n  function settle(s) {\n    var g = s.grid, W = s.W, H = s.H;\n    for (var y = H - 2; y >= 0; y--) {\n      var row = y * W, below = row + W, below2 = below + W;\n      for (var x = 0; x < W; x++) {\n        var i = row + x, v = g[i];\n        if (!v) { continue; }\n        if (!g[below + x]) { g[below + x] = v; g[i] = 0; continue; }\n        seed = (seed * 1103515245 + 12345) | 0;\n        var dir = seed & 1 ? 1 : -1, moved = false;\n        for (var t = 0; t < 2 && !moved; t++, dir = -dir) {\n          var nx = x + dir;\n          if (nx < 0 || nx >= W || g[row + nx]) { continue; }\n          if (!g[below + nx]) { g[below + nx] = v; g[i] = 0; moved = true; }\n          else if (y + 2 < H && !g[below2 + nx] && (y === 0 || !g[row - W + x]) && (seed & 4) === 0) {\n            g[row + nx] = v; g[i] = 0; moved = true;   // shallow slope: step sideways, fall next tick\n          }\n        }\n      }\n    }\n  }\n\n  function countFilled(s) {\n    var g = s.grid, n = 0;\n    for (var i = 0; i < g.length; i++) { if (g[i]) { n++; } }\n    s.filled = n; s.coverage = n / g.length;\n    return n;\n  }\n\n  function drawDirt(s) {\n    var g = s.grid, buf = s.buf, n = g.length;\n    var pal = s.pal;\n    for (var i = 0; i < n; i++) { buf[i] = g[i] ? pal[g[i] - 1] : 0; }\n    var ps = s.particles, W = s.W, H = s.H;\n    for (var j = 0; j < ps.length; j++) {\n      var p = ps[j], cy = Math.floor(p.y), cx = Math.floor(p.x);\n      if (cy >= 0 && cy < H && cx >= 0 && cx < W) { buf[cy * W + cx] = pal[p.c - 1]; }\n    }\n    s.octx.putImageData(s.img, 0, 0);\n    s.dctx.clearRect(0, 0, s.dirtCanvas.width, s.dirtCanvas.height);\n    s.dctx.drawImage(s.off, 0, 0, s.dirtCanvas.width, s.dirtCanvas.height);\n  }\n\n  function stepBury(s, dt) {\n    var elapsed = now() - s.tPhase;\n    // Shovel rhythm: irregular, averaging shovelInterval.\n    s.shovelAcc += dt;\n    while (s.shovelAcc >= s.shovelNext) {\n      s.shovelAcc -= s.shovelNext;\n      s.shovelNext = s.shovelInterval * (0.35 + rnd() * 1.3);\n      // Count grains still in the air as landed, or the fill overshoots the line by a dozen rows.\n      if (s.topMean - s.particles.length / s.W > s.targetTop) { spawnShovel(s); }\n    }\n    // Fixed-rate simulation ticks (simHz), rendered every frame.\n    var tick = 1000 / s.opts.simHz, k = 60 / s.opts.simHz, ticks = 0;\n    s.simAcc += dt;\n    while (s.simAcc >= tick && ticks < 4) {\n      s.simAcc -= tick; ticks++;\n      stepParticles(s, k);\n      settle(s);\n    }\n    if (ticks && (s.frames & 7) === 0) { countFilled(s); surfaceScan(s); }\n    var done = (s.topMean <= s.targetTop && s.particles.length === 0) || elapsed > s.opts.buryMs * 2.5;\n    if (done) {\n      // Tamp down: fill air pockets beneath the surface so the dirt reads as solid ground.\n      var g = s.grid, W = s.W, H = s.H;\n      surfaceScan(s);\n      for (var x = 0; x < W; x++) { for (var y = s.tops[x]; y < H; y++) { var i = y * W + x; if (!g[i]) { g[i] = 1 + (i % s.pal.length); } } }\n      s.particles.length = 0;\n      countFilled(s);\n      drawDirt(s);\n      initGarden(s);\n      setPhase(s, 'growing');\n      return;\n    }\n    if (ticks) { drawDirt(s); }\n  }\n\n  // ---------------------------------------------------------------- growth phase\n  // One of three plant systems grows after the dirt settles (picked at random unless forced):\n  //   flowers — ground flowers fill the dirt itself\n  //   vines   — climb the left and right edges of the window, as if on a trellis\n  //   bushes  — rise from the soil line to fill roughly the next quarter of the window\n  // Everything drawn is also recorded in s.scene so a resize can replay it into the new shape.\n\n  function soilY(s, px) { // CSS-px y of the dirt surface under CSS-px x\n    var cs = s.opts.cellSize, x = Math.max(0, Math.min(s.W - 1, Math.floor(px / cs)));\n    return s.tops[x] * cs;\n  }\n\n  function markGreen(s, px, py, r) {\n    var cs = s.opts.cellSize, W = s.W, H = s.H, gr = s.green;\n    var x0 = Math.max(0, Math.floor((px - r) / cs)), x1 = Math.min(W - 1, Math.floor((px + r) / cs));\n    var y0 = Math.max(0, Math.floor((py - r) / cs)), y1 = Math.min(H - 1, Math.floor((py + r) / cs));\n    for (var y = y0; y <= y1; y++) { for (var x = x0; x <= x1; x++) { gr[y * W + x] = 1; } }\n  }\n\n  // ---- primitives: draw now, remember for replay\n  function paintLeaf(c, x, y, ang, size, col) {\n    c.save(); c.translate(x, y); c.rotate(ang);\n    c.fillStyle = col;\n    c.beginPath(); c.ellipse(size * 0.6, 0, size, size * 0.45, 0, 0, 6.2832); c.fill();\n    c.restore();\n  }\n  function drawLeaf(s, x, y, ang, size, col) {\n    paintLeaf(s.gctx, x, y, ang, size, col);\n    s.scene.push({ t: 1, x: x, y: y, a: ang, r: size, col: col });\n  }\n\n  function paintFlower(c, x, y, r, col, centerCol, n, rot) {\n    c.fillStyle = col;\n    for (var i = 0; i < n; i++) {\n      var a = rot + i * 6.2832 / n;\n      c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55, r * 0.35, a, 0, 6.2832); c.fill();\n    }\n    c.fillStyle = centerCol;\n    c.beginPath(); c.arc(x, y, r * 0.3, 0, 6.2832); c.fill();\n  }\n  function drawFlower(s, x, y, r, col, centerCol, n, rot) {\n    n = n || 5 + (rnd() < 0.3 ? 1 : 0); rot = rot === undefined ? rnd() * 6.2832 : rot;\n    centerCol = centerCol || '#ffd84a';\n    paintFlower(s.gctx, x, y, r, col, centerCol, n, rot);\n    s.scene.push({ t: 2, x: x, y: y, r: r, col: col, c2: centerCol, n: n, rot: rot });\n  }\n\n  function paintTendril(c, x, y, dir, len, wob, col) {\n    c.strokeStyle = col; c.lineWidth = 1.2;\n    c.beginPath(); c.moveTo(x, y);\n    c.quadraticCurveTo(x + dir * len * 0.7, y - len * 0.5, x + dir * len, y + wob * len * 0.6);\n    c.stroke();\n  }\n  function drawTendril(s, x, y, dir, len, col) {\n    var wob = rnd() - 0.5;\n    paintTendril(s.gctx, x, y, dir, len, wob, col);\n    s.scene.push({ t: 3, x: x, y: y, dir: dir, len: len, wob: wob, col: col });\n  }\n\n  // Stems are polylines: drawn live segment by segment, recorded as sparse points.\n  function startStroke(s, x, y, w, col) {\n    var op = { t: 0, pts: [x, y], w0: w, w1: w, col: col };\n    s.scene.push(op);\n    return op;\n  }\n  function extendStroke(s, op, x0, y0, x1, y1, w) {\n    var c = s.gctx;\n    c.strokeStyle = op.col; c.lineWidth = w;\n    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();\n    var n = op.pts.length, dx = x1 - op.pts[n - 2], dyy = y1 - op.pts[n - 1];\n    if (dx * dx + dyy * dyy >= 9) { op.pts.push(x1, y1); op.w1 = w; }\n  }\n  function paintStroke(c, op, T) {\n    var pts = op.pts, n = pts.length / 2;\n    if (n < 2) { return; }\n    for (var i = 1; i < n; i++) {\n      var a = T(pts[i * 2 - 2], pts[i * 2 - 1]), b = T(pts[i * 2], pts[i * 2 + 1]);\n      c.strokeStyle = op.col; c.lineWidth = op.w0 + (op.w1 - op.w0) * (i / (n - 1));\n      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();\n    }\n  }\n\n  function replayScene(s, T) {\n    var c = s.gctx, sc = s.scene;\n    c.clearRect(0, 0, s.cw, s.ch);\n    for (var i = 0; i < sc.length; i++) {\n      var op = sc[i], p;\n      if (op.t === 0) { paintStroke(c, op, T); continue; }\n      p = T(op.x, op.y);\n      if (op.t === 1) { paintLeaf(c, p[0], p[1], op.a, op.r, op.col); }\n      else if (op.t === 2) { paintFlower(c, p[0], p[1], op.r, op.col, op.c2, op.n, op.rot); }\n      else if (op.t === 3) { paintTendril(c, p[0], p[1], op.dir, op.len, op.wob, op.col); }\n    }\n    // Bake the transform into the record so the next resize composes correctly.\n    for (i = 0; i < sc.length; i++) {\n      op = sc[i];\n      if (op.t === 0) { for (var j = 0; j < op.pts.length; j += 2) { p = T(op.pts[j], op.pts[j + 1]); op.pts[j] = p[0]; op.pts[j + 1] = p[1]; } }\n      else { p = T(op.x, op.y); op.x = p[0]; op.y = p[1]; }\n    }\n  }\n\n  function sproutTip(s, bush, x, y, ang, depth, maxLen, w) {\n    if (s.tips.length >= s.opts.maxTips) { return; }\n    s.tips.push({ bush: bush, x: x, y: y, a: ang, len: 0, maxLen: maxLen, w: w, depth: depth, stroke: startStroke(s, x, y, w, bush.stemCol) });\n  }\n\n  function stepBushes(s, dt, k, elapsed) {\n    var tips = s.tips, cw = s.cw, i, w = 0;\n    for (i = 0; i < s.bushes.length; i++) {\n      var bsh = s.bushes[i];\n      if (!bsh.started && elapsed >= bsh.delay) {\n        bsh.started = true;\n        var trunks = 1 + (rnd() < 0.6 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);\n        for (var t = 0; t < trunks; t++) {\n          sproutTip(s, bsh, bsh.x + (rnd() - 0.5) * 10, bsh.sy + 2, -1.5708 + (rnd() - 0.5) * 0.7, 0, bsh.h * (0.8 + rnd() * 0.25), 3);\n        }\n      }\n    }\n    for (i = 0; i < tips.length; i++) {\n      var tp = tips[i], bush = tp.bush;\n      var step = bush.v * dt;\n      var nx = tp.x + Math.cos(tp.a) * step, ny = tp.y + Math.sin(tp.a) * step;\n      extendStroke(s, tp.stroke, tp.x, tp.y, nx, ny, tp.w * (1 - 0.55 * tp.len / tp.maxLen));\n      tp.x = nx; tp.y = ny; tp.len += step;\n      tp.a += (rnd() - 0.5) * 0.3 * k;\n      tp.a += (-1.5708 - tp.a) * 0.03 * k;\n      if (rnd() < 0.08 * k) {\n        var side = rnd() < 0.5 ? 1 : -1;\n        drawLeaf(s, nx, ny, tp.a + side * (1.0 + rnd() * 0.6), 3.5 + rnd() * 4, rnd() < 0.5 ? bush.leafCol : bush.leafCol2);\n      }\n      if (rnd() < 0.025 * k && tp.depth < 3) { drawFlower(s, nx + (rnd() - 0.5) * 6, ny, 2.5 + rnd() * 2.5, bush.flowerCol); }\n      if (tp.len > 6 && tp.depth < 4 && rnd() < 0.07 * k) {\n        var bs = rnd() < 0.5 ? 1 : -1;\n        sproutTip(s, bush, nx, ny, tp.a + bs * (0.5 + rnd() * 0.6), tp.depth + 1, (tp.maxLen - tp.len) * (0.35 + rnd() * 0.35), tp.w * 0.7);\n      }\n      var alive = tp.len < tp.maxLen && ny > bush.top && ny < bush.sy + 4 && nx > -8 && nx < cw + 8;\n      if (!alive) {\n        // Bloom at the end of every branch; big flowers on the main stems.\n        tp.stroke.pts.push(nx, ny);\n        drawLeaf(s, nx, ny, tp.a + 0.8, 4 + rnd() * 4, bush.leafCol);\n        drawLeaf(s, nx, ny, tp.a - 0.8, 4 + rnd() * 4, bush.leafCol2);\n        if (tp.depth <= 1 || rnd() < 0.6) { drawFlower(s, nx, ny, (tp.depth === 0 ? 6 : 3.5) + rnd() * 3, bush.flowerCol); }\n        continue;\n      }\n      tips[w++] = tp;\n    }\n    tips.length = w;\n  }\n\n  function stepVines(s, dt, k, elapsed) {\n    var cw = s.cw;\n    for (var i = 0; i < s.vines.length; i++) {\n      var v = s.vines[i];\n      if (v.done || elapsed < v.delay) { continue; }\n      if (!v.stroke) { v.stroke = startStroke(s, v.x, v.y, 2.6, v.col); }\n      var dy = v.v * dt;\n      v.y -= dy;\n      v.x = v.baseX + Math.sin(v.y * v.freq + v.phase) * v.amp - v.side * Math.abs(Math.cos(v.y * v.freq * 0.5)) * 4;\n      extendStroke(s, v.stroke, v.px, v.py, v.x, v.y, 2.6);\n      v.px = v.x; v.py = v.y;\n      v.leafAcc += dy; v.flowerAcc += dy;\n      if (v.leafAcc >= v.nextLeaf) {\n        v.leafAcc = 0; v.nextLeaf = 9 + rnd() * 9; v.alt ^= 1;\n        var inward = v.side < 0 ? 0 : 3.1416;\n        drawLeaf(s, v.x, v.y, inward + (v.alt ? 0.75 : -0.75) * -v.side, 5 + rnd() * 5, v.leafCol);\n        if (rnd() < 0.25) { drawTendril(s, v.x, v.y, -v.side, 14 + rnd() * 26, v.col); }\n      }\n      if (v.flowerAcc >= v.nextFlower) {\n        v.flowerAcc = 0; v.nextFlower = 22 + rnd() * 34;\n        drawFlower(s, v.x - v.side * (4 + rnd() * 8), v.y, 4.5 + rnd() * 2.5, v.flowerCol, '#fff7cc');\n      }\n      if (v.y < -8 || v.x < -20 || v.x > cw + 20) { v.done = true; v.stroke.pts.push(v.x, v.y); }\n    }\n  }\n\n  // ---- staged blooms: a flower or leaf pair that grows over 0.8–3.5 s at its own rate.\n  // Drawn progressively (each stage painted over the last), recorded once when complete.\n  function addBloom(s, b) { b.t = 0; b.rate = 1 / (800 + rnd() * 2700); b.drawn = 0; s.blooms.push(b); }\n\n  function stepBlooms(s, dt) {\n    var c = s.gctx, bl = s.blooms, w = 0;\n    for (var i = 0; i < bl.length; i++) {\n      var b = bl[i];\n      b.t = Math.min(1, b.t + b.rate * dt);\n      var ease = b.t * b.t * (3 - 2 * b.t);\n      if (ease - b.drawn >= 0.18 || (b.t === 1 && b.drawn < 1)) {\n        b.drawn = b.t === 1 ? 1 : ease;\n        if (b.kind === 'flower') {\n          if (b.t === 1) { drawFlower(s, b.x, b.y, b.r, b.col, b.c2, b.n, b.rot); }\n          else { paintFlower(c, b.x, b.y, b.r * ease, b.col, b.c2, b.n, b.rot); }\n        } else {\n          if (b.t === 1) { drawLeaf(s, b.x, b.y, b.a, b.r, b.col); drawLeaf(s, b.x, b.y, b.a + 2.4, b.r * 0.9, b.col2); }\n          else { paintLeaf(c, b.x, b.y, b.a, b.r * ease, b.col); paintLeaf(c, b.x, b.y, b.a + 2.4, b.r * 0.9 * ease, b.col2); }\n        }\n      }\n      if (b.t === 1) { markGreen(s, b.x, b.y, b.r * 1.1); continue; }\n      bl[w++] = b;\n    }\n    bl.length = w;\n  }\n\n  // Pick a bare dirt cell, preferring the neighbourhood of a few wandering cluster centres so\n  // growth spreads in drifts rather than evenly. Returns [px, py] or null.\n  function bareDirtSpot(s) {\n    var W = s.W, H = s.H, cs = s.opts.cellSize, g = s.grid, gr = s.green, tops = s.tops;\n    for (var t = 0; t < 8; t++) {\n      var x, y;\n      if (s.clusters.length && rnd() < 0.7) {\n        var cl = pick(s.clusters);\n        x = Math.floor((cl.x + (rnd() + rnd() - 1) * 40) / cs); y = Math.floor((cl.y + (rnd() + rnd() - 1) * 40) / cs);\n        if (x < 0 || x >= W || y < 0 || y >= H) { continue; }\n      } else {\n        x = Math.floor(rnd() * W); var top = tops[x]; if (top >= H) { continue; }\n        y = top + Math.floor(rnd() * (H - top));\n      }\n      var ci = y * W + x;\n      if (!g[ci] || gr[ci]) { continue; }\n      return [(x + 0.5) * cs, (y + 0.5) * cs];\n    }\n    return null;\n  }\n\n  function stepClusters(s, dt) {\n    var cw = s.cw, ch = s.ch;\n    for (var i = 0; i < s.clusters.length; i++) {\n      var cl = s.clusters[i];\n      cl.x += cl.vx * dt; cl.y += cl.vy * dt;\n      if (cl.x < 0 || cl.x > cw) { cl.vx = -cl.vx; cl.x = Math.max(0, Math.min(cw, cl.x)); }\n      var sy = soilY(s, cl.x);\n      if (cl.y < sy || cl.y > ch) { cl.vy = -cl.vy; cl.y = Math.max(sy, Math.min(ch, cl.y)); }\n      if (rnd() < 0.004) { cl.vx = (rnd() - 0.5) * 0.08; cl.vy = (rnd() - 0.5) * 0.06; }\n    }\n  }\n\n  function initClusters(s, n) {\n    s.clusters = [];\n    for (var i = 0; i < n; i++) {\n      var x = rnd() * s.cw, sy = soilY(s, x);\n      s.clusters.push({ x: x, y: sy + rnd() * (s.ch - sy), vx: (rnd() - 0.5) * 0.08, vy: (rnd() - 0.5) * 0.06 });\n    }\n  }\n\n  function dirtCoverage(s) {\n    var g = s.grid, gr = s.green, n = 0;\n    for (var i = 0; i < gr.length; i++) { if (g[i] && gr[i]) { n++; } }\n    s.greenCov = s.dirtCells ? n / s.dirtCells : 1;\n    return s.greenCov;\n  }\n\n  // ---- the flora systems. Each: init(s), step(s, dt, k, elapsed), done(s) -> bool\n  var FLORA = {};\n\n  // garden: ground flowers and leaf pairs carpet the dirt, in drifts, each blooming at its own pace\n  FLORA.flowers = {\n    init: function (s) { initClusters(s, 3 + Math.floor(rnd() * 3)); },\n    step: function (s, dt, k) {\n      stepClusters(s, dt);\n      if (s.greenCov < 0.75) {\n        var want = rnd() < 0.5 * k ? 1 : 0, elapsed = now() - s.tPhase;\n        if (elapsed < s.opts.growMs * 0.4 && rnd() < 0.5 * k) { want++; }\n        for (var n = 0; n < want; n++) {\n          var sp = bareDirtSpot(s); if (!sp) { continue; }\n          if (rnd() < 0.55) {\n            var r = 2.5 + rnd() * 3.5;\n            var st = startStroke(s, sp[0], sp[1] + r * 1.6, 1, pick(STEM_COL));\n            st.pts.push(sp[0], sp[1]); extendStroke(s, st, sp[0], sp[1] + r * 1.6, sp[0], sp[1], 1);\n            addBloom(s, { kind: 'flower', x: sp[0], y: sp[1], r: r, col: pick(FLOWER_COL), c2: '#ffd84a', n: 5 + (rnd() < 0.3 ? 1 : 0), rot: rnd() * 6.2832 });\n          } else {\n            addBloom(s, { kind: 'leaf', x: sp[0], y: sp[1], r: 3 + rnd() * 3, a: rnd() * 6.2832, col: pick(LEAF_COL), col2: pick(LEAF_COL) });\n          }\n          markGreen(s, sp[0], sp[1], 1); // reserve the spot so the next pick lands elsewhere\n        }\n      }\n      stepBlooms(s, dt);\n      if ((s.frames & 15) === 0) { dirtCoverage(s); }\n    },\n    done: function (s) { return s.greenCov >= 0.75 && s.blooms.length === 0; }\n  };\n\n  // meadow: grass blades (curved strokes that grow at their own speed) with scattered wildflowers\n  FLORA.grass = {\n    init: function (s) { initClusters(s, 4 + Math.floor(rnd() * 3)); },\n    step: function (s, dt, k) {\n      stepClusters(s, dt);\n      if (s.greenCov < 0.72) {\n        var want = (rnd() < 0.9 * k ? 1 : 0) + (rnd() < 0.5 * k ? 1 : 0);\n        for (var n = 0; n < want; n++) {\n          var sp = bareDirtSpot(s); if (!sp) { continue; }\n          if (rnd() < 0.07) {\n            addBloom(s, { kind: 'flower', x: sp[0], y: sp[1] - 4, r: 2 + rnd() * 1.8, col: pick(WILD_COL), c2: '#ffd84a', n: 5, rot: rnd() * 6.2832 });\n            var st = startStroke(s, sp[0], sp[1] + 2, 0.9, pick(GRASS_COL)); st.pts.push(sp[0], sp[1] - 4); extendStroke(s, st, sp[0], sp[1] + 2, sp[0], sp[1] - 4, 0.9);\n          } else {\n            var h = 9 + rnd() * 24, lean = (rnd() - 0.5) * 1.1;\n            s.plants.push({ kind: 'blade', x: sp[0], sy: sp[1], h: h, lean: lean, t: 0, rate: 1 / (700 + rnd() * 2200),\n              stroke: startStroke(s, sp[0], sp[1], 1.8, pick(GRASS_COL)), px: sp[0], py: sp[1] });\n          }\n          markGreen(s, sp[0], sp[1], 2.5);\n        }\n      }\n      var pl = s.plants, w = 0;\n      for (var i = 0; i < pl.length; i++) {\n        var b = pl[i];\n        b.t = Math.min(1, b.t + b.rate * dt);\n        var u = b.t, cx = b.x + b.lean * b.h * 0.2, cy = b.sy - b.h * 0.6, tx = b.x + b.lean * b.h, ty = b.sy - b.h;\n        var nx = (1 - u) * (1 - u) * b.x + 2 * (1 - u) * u * cx + u * u * tx, ny = (1 - u) * (1 - u) * b.sy + 2 * (1 - u) * u * cy + u * u * ty;\n        extendStroke(s, b.stroke, b.px, b.py, nx, ny, 1.8 - 1.2 * u);\n        b.px = nx; b.py = ny;\n        if (b.t === 1) { b.stroke.pts.push(nx, ny); b.stroke.w1 = 0.6; continue; }\n        pl[w++] = b;\n      }\n      pl.length = w;\n      stepBlooms(s, dt);\n      if ((s.frames & 15) === 0) { dirtCoverage(s); }\n    },\n    done: function (s) { return s.greenCov >= 0.72 && s.plants.length === 0 && s.blooms.length === 0; }\n  };\n\n  // trellis: vines climb both edges\n  FLORA.vines = {\n    init: function (s) {\n      var cw = s.cw, growMs = s.opts.growMs;\n      for (var side = -1; side <= 1; side += 2) {\n        var n = 3 + Math.floor(rnd() * 3);\n        for (var i = 0; i < n; i++) {\n          var baseX = side < 0 ? 6 + rnd() * 16 : cw - 6 - rnd() * 16;\n          var y0 = soilY(s, baseX) + 4;\n          s.vines.push({\n            side: side, baseX: baseX, x: baseX, y: y0, px: baseX, py: y0,\n            amp: 14 + rnd() * 20, freq: 0.02 + rnd() * 0.025, phase: rnd() * 6.2832,\n            v: (y0 + 12) / (growMs * (0.55 + rnd() * 0.45)),\n            delay: i * growMs * 0.1 + rnd() * 1500,\n            leafAcc: 0, nextLeaf: 10 + rnd() * 8, flowerAcc: 0, nextFlower: 25 + rnd() * 30, alt: 0,\n            col: pick(STEM_COL), leafCol: pick(LEAF_COL), flowerCol: pick(VINE_FLOWER_COL), done: false, stroke: null\n          });\n        }\n      }\n    },\n    step: function (s, dt, k, elapsed) { stepVines(s, dt, k, elapsed); },\n    done: function (s) { for (var i = 0; i < s.vines.length; i++) { if (!s.vines[i].done) { return false; } } return true; }\n  };\n\n  // hedgerow: flowering bushes, with more spread in growth speed than before\n  FLORA.bushes = {\n    init: function (s) {\n      var cw = s.cw, ch = s.ch, growMs = s.opts.growMs;\n      var count = Math.max(3, Math.round(cw / 72)), bh = s.opts.bushHeight;\n      for (var b = 0; b < count; b++) {\n        var bx = (b + 0.3 + rnd() * 0.4) * cw / count;\n        var sy = soilY(s, bx);\n        var h = Math.min(sy - 6, (bh[0] + rnd() * (bh[1] - bh[0])) * ch);\n        s.bushes.push({\n          x: bx, sy: sy, top: sy - h, h: h, delay: rnd() * growMs * 0.35, started: false,\n          v: h / (growMs * (0.3 + rnd() * 0.4)), stemCol: pick(STEM_COL), leafCol: pick(LEAF_COL), leafCol2: pick(LEAF_COL),\n          flowerCol: pick(BUSH_FLOWER_COL)\n        });\n      }\n    },\n    step: function (s, dt, k, elapsed) { stepBushes(s, dt, k, elapsed); },\n    done: function (s) { if (s.tips.length) { return false; } for (var i = 0; i < s.bushes.length; i++) { if (!s.bushes[i].started) { return false; } } return true; }\n  };\n\n  // forest: tall trunks with a few branches and a leafy canopy, on dark loam\n  FLORA.trees = {\n    init: function (s) {\n      var cw = s.cw, ch = s.ch, th = s.opts.treeHeight, growMs = s.opts.growMs;\n      var count = Math.max(2, Math.round(cw / 140));\n      for (var i = 0; i < count; i++) {\n        var x = (i + 0.25 + rnd() * 0.5) * cw / count, sy = soilY(s, x);\n        var h = Math.min(sy - 10, (th[0] + rnd() * (th[1] - th[0])) * ch);\n        s.plants.push({\n          kind: 'tree', x: x, sy: sy, h: h, w: 4 + rnd() * 5, t: 0, delay: rnd() * growMs * 0.3,\n          rate: 1 / (growMs * (0.35 + rnd() * 0.4)), sway: (rnd() - 0.5) * 0.25, trunkCol: pick(TRUNK_COL),\n          leafCols: [pick(CANOPY_COL), pick(CANOPY_COL), pick(CANOPY_COL)], leaves: 0,\n          leafTarget: Math.round(90 + h * 0.9), branches: [], stroke: null, px: x, py: sy\n        });\n      }\n    },\n    step: function (s, dt, k, elapsed) {\n      var pl = s.plants;\n      for (var i = 0; i < pl.length; i++) {\n        var tr = pl[i];\n        if (elapsed < tr.delay) { continue; }\n        if (!tr.stroke) { tr.stroke = startStroke(s, tr.x, tr.sy + 2, tr.w, tr.trunkCol); tr.stroke.w1 = tr.w * 0.5; }\n        if (tr.t < 1) {\n          tr.t = Math.min(1, tr.t + tr.rate * dt);\n          var ny = tr.sy - tr.h * tr.t, nx = tr.x + Math.sin(tr.t * 3.1) * tr.sway * tr.h * 0.15;\n          extendStroke(s, tr.stroke, tr.px, tr.py, nx, ny, tr.w * (1 - 0.5 * tr.t));\n          tr.px = nx; tr.py = ny;\n          // branches start partway up and grow with the trunk\n          if (tr.t > 0.5 && tr.branches.length < 3 && rnd() < 0.03 * k) {\n            var side = tr.branches.length % 2 ? 1 : -1, len = tr.h * (0.18 + rnd() * 0.14), ang = -1.5708 + side * (0.6 + rnd() * 0.5);\n            tr.branches.push({ x: nx, y: ny, ang: ang, len: len, t: 0, stroke: startStroke(s, nx, ny, tr.w * 0.45, tr.trunkCol), px: nx, py: ny });\n          }\n        }\n        for (var b = 0; b < tr.branches.length; b++) {\n          var br = tr.branches[b];\n          if (br.t < 1) {\n            br.t = Math.min(1, br.t + tr.rate * 1.6 * dt);\n            var bx = br.x + Math.cos(br.ang) * br.len * br.t, by = br.y + Math.sin(br.ang) * br.len * br.t;\n            extendStroke(s, br.stroke, br.px, br.py, bx, by, tr.w * 0.45 * (1 - 0.5 * br.t));\n            br.px = bx; br.py = by;\n            if (rnd() < 0.25 * k) { drawLeaf(s, bx, by, br.ang + (rnd() < 0.5 ? 1 : -1) * (0.9 + rnd() * 0.6), 4 + rnd() * 4, pick(tr.leafCols)); }\n          }\n        }\n        // canopy grows outward from the top of the trunk: leaf j of N sits at radius R*sqrt(j/N),\n        // so each ring fills before the next, like a crown spreading from the inside\n        if (tr.t > 0.6 && tr.leaves < tr.leafTarget) {\n          var n = 1 + Math.floor(rnd() * 3 * k), cyc = tr.sy - tr.h * 0.78, rx = tr.h * 0.3, ry = tr.h * 0.26;\n          for (var j = 0; j < n && tr.leaves < tr.leafTarget; j++, tr.leaves++) {\n            var a = rnd() * 6.2832, rr = Math.sqrt((tr.leaves + rnd()) / tr.leafTarget);\n            drawLeaf(s, tr.x + Math.cos(a) * rx * rr, cyc + Math.sin(a) * ry * rr, rnd() * 6.2832, 5 + rnd() * 5, pick(tr.leafCols));\n          }\n        }\n      }\n    },\n    done: function (s) { for (var i = 0; i < s.plants.length; i++) { var t = s.plants[i]; if (t.t < 1 || t.leaves < t.leafTarget) { return false; } } return true; }\n  };\n\n  // desert: columnar cacti with arms and spines, the odd flower on top, on sandy dirt\n  FLORA.cacti = {\n    init: function (s) {\n      var cw = s.cw, ch = s.ch, chh = s.opts.cactusHeight, growMs = s.opts.growMs;\n      var count = Math.max(2, Math.round(cw / 110));\n      for (var i = 0; i < count; i++) {\n        var x = (i + 0.2 + rnd() * 0.6) * cw / count, sy = soilY(s, x);\n        var barrel = rnd() < 0.3;\n        var h = barrel ? 14 + rnd() * 10 : Math.min(sy - 8, (chh[0] + rnd() * (chh[1] - chh[0])) * ch);\n        var arms = [];\n        if (!barrel) { var na = Math.floor(rnd() * 3); for (var a = 0; a < na; a++) { arms.push({ side: a % 2 ? 1 : -1, at: 0.35 + rnd() * 0.35, len: 10 + rnd() * 16, t: 0, stroke: null, px: 0, py: 0 }); } }\n        s.plants.push({\n          kind: 'cactus', x: x, sy: sy, h: h, w: barrel ? 14 + rnd() * 6 : 7 + rnd() * 6, t: 0, delay: rnd() * growMs * 0.3,\n          rate: 1 / (growMs * (0.3 + rnd() * 0.45)), col: pick(CACTUS_COL), arms: arms, spineAcc: 0,\n          flower: rnd() < 0.5 ? pick(CACTUS_FLOWER_COL) : null, stroke: null, px: x, py: sy, bloomed: false\n        });\n      }\n    },\n    step: function (s, dt, k, elapsed) {\n      var pl = s.plants;\n      for (var i = 0; i < pl.length; i++) {\n        var ca = pl[i];\n        if (elapsed < ca.delay) { continue; }\n        if (!ca.stroke) { ca.stroke = startStroke(s, ca.x, ca.sy + 2, ca.w, ca.col); }\n        if (ca.t < 1) {\n          ca.t = Math.min(1, ca.t + ca.rate * dt);\n          var ny = ca.sy - ca.h * ca.t;\n          extendStroke(s, ca.stroke, ca.px, ca.py, ca.x, ny, ca.w);\n          ca.spineAcc += ca.py - ny; ca.py = ny;\n          while (ca.spineAcc >= 6) { // spines: tiny pale strokes either side\n            ca.spineAcc -= 6;\n            for (var sd = -1; sd <= 1; sd += 2) {\n              var sx = ca.x + sd * ca.w * 0.5, sp = startStroke(s, sx, ny, 0.8, '#f3f0d8');\n              sp.pts.push(sx + sd * 2.5, ny - 1.5); extendStroke(s, sp, sx, ny, sx + sd * 2.5, ny - 1.5, 0.8);\n            }\n          }\n          if (ca.t === 1) { ca.stroke.pts.push(ca.x, ny); }\n        }\n        for (var a = 0; a < ca.arms.length; a++) {\n          var arm = ca.arms[a];\n          if (ca.t < arm.at) { continue; }\n          if (!arm.stroke) { arm.px = ca.x + arm.side * ca.w * 0.4; arm.py = ca.sy - ca.h * arm.at; arm.stroke = startStroke(s, arm.px, arm.py, ca.w * 0.7, ca.col); }\n          if (arm.t < 1) {\n            arm.t = Math.min(1, arm.t + ca.rate * 1.5 * dt);\n            // out sideways for the first 40%, then up\n            var u = arm.t, ox = ca.x + arm.side * ca.w * 0.4, oy = ca.sy - ca.h * arm.at;\n            var ax = u < 0.4 ? ox + arm.side * arm.len * (u / 0.4) : ox + arm.side * arm.len;\n            var ay = u < 0.4 ? oy : oy - arm.len * 1.2 * ((u - 0.4) / 0.6);\n            extendStroke(s, arm.stroke, arm.px, arm.py, ax, ay, ca.w * 0.7);\n            arm.px = ax; arm.py = ay;\n            if (arm.t === 1) { arm.stroke.pts.push(ax, ay); }\n          }\n        }\n        if (ca.t === 1 && ca.flower && !ca.bloomed) {\n          ca.bloomed = true;\n          addBloom(s, { kind: 'flower', x: ca.x, y: ca.sy - ca.h - ca.w * 0.3, r: 3.5 + rnd() * 2.5, col: ca.flower, c2: '#fff1a8', n: 6, rot: rnd() * 6.2832 });\n        }\n      }\n      stepBlooms(s, dt);\n    },\n    done: function (s) {\n      if (s.blooms.length) { return false; }\n      for (var i = 0; i < s.plants.length; i++) { var ca = s.plants[i]; if (ca.t < 1) { return false; } for (var a = 0; a < ca.arms.length; a++) { if (ca.arms[a].t < 1) { return false; } } }\n      return true;\n    }\n  };\n\n  function initGarden(s) {\n    s.tips = []; s.vines = []; s.bushes = []; s.plants = []; s.blooms = []; s.clusters = []; s.scene = [];\n    s.dirtCells = s.filled;\n    FLORA[s.flora].init(s);\n  }\n\n  function stepGrow(s, dt, k) {\n    var elapsed = now() - s.tPhase;\n    FLORA[s.flora].step(s, dt, k, elapsed);\n    if ((s.frames & 15) === 0 && (FLORA[s.flora].done(s) || elapsed > s.opts.growMs * 1.8)) {\n      setPhase(s, 'garden');\n      s.running = false; // the garden stays on screen; nothing left to animate\n    }\n  }\n\n  // ---------------------------------------------------------------- loop\n  function setPhase(s, p) {\n    s.phase = p; s.tPhase = now();\n    if (typeof s.opts.onPhase === 'function') { try { s.opts.onPhase(p, API); } catch (e) { /* host callback error ignored */ } }\n  }\n\n  function recordStats(s, dt, simMs, drawMs) {\n    var st = s.stats;\n    st.dts[st.di] = dt; st.di = (st.di + 1) % st.dts.length; if (st.dn < st.dts.length) { st.dn++; }\n    st.simMs = st.simMs * 0.9 + simMs * 0.1;\n    st.drawMs = st.drawMs * 0.9 + drawMs * 0.1;\n    if (dt > 34) { st.longFrames++; }\n    if ((s.frames % 30) === 0 && st.dn > 10) {\n      var a = Array.prototype.slice.call(st.dts, 0, st.dn).sort(function (p, q) { return p - q; });\n      st.p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];\n    }\n  }\n\n  function frame(t) {\n    var s = S;\n    if (!s || !s.running) { return; }\n    s.raf = root.requestAnimationFrame(frame);\n    var dt = s.lastT ? Math.min(t - s.lastT, 100) : 16.7;\n    s.lastT = t; s.frames++;\n    var k = Math.min(dt / 16.667, 3); // time-scale so motion is frame-rate independent\n    if ((s.frames & 7) === 0) { checkSize(s); }\n    var t1 = now();\n    if (s.phase === 'burying') { stepBury(s, dt); }\n    var t2 = now();\n    if (s.phase === 'growing') { stepGrow(s, dt, k); }\n    var t3 = now();\n    recordStats(s, dt, t2 - t1, t3 - t2);\n    if (s.hud && (s.frames % 15) === 0) { s.hud.textContent = hudText(s); }\n    if (!s.running) { s.raf = 0; }\n  }\n\n  function hudText(s) {\n    var st = API.stats();\n    return 'Dirt ' + VERSION + '  ' + s.phase + ' (' + s.biome + ')  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\\n' +\n      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\\n' +\n      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.fillActual * 100).toFixed(0) + '/' + (st.fill * 100).toFixed(0) + '%  flowers ' + (st.greenCoverage * 100).toFixed(0) + '%\\n' +\n      't ' + st.elapsed.toFixed(1) + 's  heartbeat ' + st.frames + (s.running ? '' : '  (done; loop idle, clock still ticking)');\n  }\n\n  function onResize() { if (S && S.host) { checkSize(S); } }\n\n  function r1(v) { return Math.round(v * 10) / 10; }\n  function r2(v) { return Math.round(v * 100) / 100; }\n\n  function setBiome(s, biome, legacyFlora) {\n    var names = Object.keys(BIOMES);\n    if (legacyFlora && LEGACY_FLORA[legacyFlora]) { biome = LEGACY_FLORA[legacyFlora]; }\n    s.biome = BIOMES[biome] ? biome : names[Math.floor(rnd() * names.length)];\n    s.flora = BIOMES[s.biome].flora;\n    s.pal = PALETTES[BIOMES[s.biome].dirt].map(rgba32);\n  }\n\n  // Shared by start() and restore(): DOM, layout, listeners, size poll.\n  function begin(s) {\n    buildDom(s);\n    layout(s, true);\n    s.t0 = now(); s.running = true;\n    root.addEventListener('resize', onResize);\n    if (root.visualViewport) { root.visualViewport.addEventListener('resize', onResize); }\n    // Size poll + HUD clock; keeps working after the loop idles and in contexts without resize events.\n    s.timer = setInterval(function () {\n      if (S !== s) { return; }\n      checkSize(s);\n      if (s.hud && !s.running) { s.hud.textContent = hudText(s); }\n    }, 400);\n  }\n\n\n  // ---------------------------------------------------------------- API\n  var API = {\n    __dirt: true,\n    version: VERSION,\n    get phase() { return S ? S.phase : 'idle'; },\n    get running() { return !!(S && S.running); },\n    start: function (opts) {\n      if (S && S.running) { return API; }\n      if (S) { API.stop(); }\n      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }\n      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }\n      var s = S = makeState(o);\n      s.fillFrac = o.fill[0] + rnd() * (o.fill[1] - o.fill[0]);\n      setBiome(s, o.biome, o.flora);\n      begin(s);\n      setPhase(s, 'burying');\n      s.raf = root.requestAnimationFrame(frame);\n      return API;\n    },\n    // Serialise the current scene: biome, fill, soil profile and every plant primitive. A few\n    // thousand numbers; the host (extension, app) decides where to keep it. Nothing is stored here.\n    export: function () {\n      var s = S; if (!s || s.phase === 'idle') { return null; }\n      surfaceScan(s);\n      var prof = [], i;\n      for (i = 0; i < s.W; i++) { prof.push(Math.round((1 - s.tops[i] / s.H) * 1000) / 1000); }\n      var ops = [];\n      for (i = 0; i < s.scene.length; i++) {\n        var op = s.scene[i];\n        if (op.t === 0) { ops.push([0, r1(op.w0), r1(op.w1), op.col].concat(op.pts.map(r1))); }\n        else if (op.t === 1) { ops.push([1, r1(op.x), r1(op.y), r2(op.a), r1(op.r), op.col]); }\n        else if (op.t === 2) { ops.push([2, r1(op.x), r1(op.y), r1(op.r), op.col, op.c2, op.n, r2(op.rot)]); }\n        else if (op.t === 3) { ops.push([3, r1(op.x), r1(op.y), op.dir, r1(op.len), r2(op.wob), op.col]); }\n      }\n      return { v: 1, version: VERSION, biome: s.biome, fill: s.fillFrac, viewport: [s.cw, s.ch], profile: prof, scene: ops, savedAt: Date.now() };\n    },\n    // Rebuild a saved scene in the current viewport, as a finished garden (no animation).\n    restore: function (data, opts) {\n      if (!data || data.v !== 1) { return API; }\n      if (S) { API.stop(); }\n      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }\n      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }\n      var s = S = makeState(o);\n      s.fillFrac = data.fill;\n      setBiome(s, data.biome, null);\n      begin(s);\n      // soil from the saved per-column depth profile\n      var W = s.W, H = s.H, prof = data.profile, g = s.grid, x, y;\n      for (x = 0; x < W; x++) {\n        var depth = Math.round(prof[Math.min(prof.length - 1, Math.floor(x * prof.length / W))] * H);\n        for (y = H - depth; y < H; y++) { g[y * W + x] = 1 + Math.floor(rnd() * s.pal.length); }\n      }\n      surfaceScan(s); countFilled(s); s.dirtCells = s.filled; drawDirt(s);\n      // plants, replayed through the viewport change\n      var sc = data.scene, ops = [], i;\n      for (i = 0; i < sc.length; i++) {\n        var a = sc[i];\n        if (a[0] === 0) { ops.push({ t: 0, w0: a[1], w1: a[2], col: a[3], pts: a.slice(4) }); }\n        else if (a[0] === 1) { ops.push({ t: 1, x: a[1], y: a[2], a: a[3], r: a[4], col: a[5] }); }\n        else if (a[0] === 2) { ops.push({ t: 2, x: a[1], y: a[2], r: a[3], col: a[4], c2: a[5], n: a[6], rot: a[7] }); }\n        else if (a[0] === 3) { ops.push({ t: 3, x: a[1], y: a[2], dir: a[3], len: a[4], wob: a[5], col: a[6] }); }\n      }\n      s.scene = ops;\n      var sx = s.cw / data.viewport[0], sy = s.ch / data.viewport[1];\n      replayScene(s, function (px, py) { return [px * sx, py * sy]; });\n      s.greenCov = 1;\n      s.running = false;\n      setPhase(s, 'garden');\n      if (s.hud) { s.hud.textContent = hudText(s); }\n      return API;\n    },\n\n    stop: function () {\n      var s = S; if (!s) { return API; }\n      s.running = false;\n      if (s.raf) { root.cancelAnimationFrame(s.raf); }\n      if (s.timer) { clearInterval(s.timer); }\n      root.removeEventListener('resize', onResize);\n      if (root.visualViewport) { root.visualViewport.removeEventListener('resize', onResize); }\n      if (s.host && s.host.parentNode) { s.host.parentNode.removeChild(s.host); }\n      setPhase(s, 'stopped');\n      S = null;\n      return API;\n    },\n    toggle: function (opts) { return (S && S.running) ? API.stop() : API.start(opts); },\n    stats: function () {\n      var s = S; if (!s) { return null; }\n      var st = s.stats, sum = 0;\n      for (var i = 0; i < st.dn; i++) { sum += st.dts[i]; }\n      var avg = st.dn ? sum / st.dn : 0;\n      return {\n        version: VERSION, phase: s.phase, biome: s.biome, flora: s.flora, running: s.running,\n        grid: [s.W, s.H], viewport: [s.cw, s.ch], dpr: s.dpr,\n        fps: avg ? 1000 / avg : 0, avgFrameMs: avg, p95FrameMs: st.p95,\n        simMs: st.simMs, drawMs: st.drawMs, longFrames: st.longFrames,\n        frames: s.frames, elapsed: (now() - s.t0) / 1000,\n        coverage: s.coverage, fill: s.fillFrac, fillActual: s.fillActual, greenCoverage: s.greenCov,\n        particles: s.particles.length, tips: s.tips.length, sceneOps: s.scene.length,\n        vines: s.vines.filter(function (v) { return !v.done; }).length\n      };\n    },\n    // Heartbeat for the extension spikes: call from outside (e.g. WKWebView.evaluateJavaScript)\n    // a few seconds apart; if the number keeps rising, the loop survived.\n    ping: function () { return S ? S.frames : -1; }\n  };\n\n  root.Dirt = API;\n  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }\n})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));\n";

// action-wrapper.js — appended to dirt-core.js by build.sh to produce Action.js, the file named by
// NSExtensionJavaScriptPreprocessingFile. Safari injects Action.js into the live page and calls:
//   run(args)      when the share sheet opens  — report a little context back to native code
//   finalize(args) after the extension returns — this is where Dirt starts
//
// The question this spike answers: does a requestAnimationFrame loop started here keep running
// once the extension has been dismissed? The HUD heartbeat makes that visible on the device.

var DIRT_INJECT_MODE = 'direct'; // 'direct' = run Dirt in this script context; 'script-tag' = copy into page world

var ExtensionPreprocessingJS = {
  run: function (args) {
    var before = (typeof Dirt !== 'undefined' && Dirt.__dirt) ? Dirt.ping() : -1;
    args.completionFunction({ title: document.title, url: document.URL, heartbeatBefore: before });
  },

  finalize: function (args) {
    var opts = { debug: !!(args && args.debug) };
    if (DIRT_INJECT_MODE === 'direct') {
      try { Dirt.start(opts); return; } catch (e) { /* fall through to script-tag */ }
    }
    // Fallback: hand the module to the page's own JS world via an inline <script>. The page's
    // Content-Security-Policy may block this (script-src without 'unsafe-inline'); that is a
    // finding worth recording per site.
    try {
      var src = DIRT_CORE_SOURCE + ';Dirt.start(' + JSON.stringify(opts) + ');';
      var el = document.createElement('script');
      el.textContent = src;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
    } catch (e2) {
      // Last resort: make the failure visible without touching page content.
      var warn = document.createElement('div');
      warn.textContent = 'Dirt could not start: ' + (e2 && e2.message);
      warn.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#b00;color:#fff;padding:8px;font:14px sans-serif;';
      document.documentElement.appendChild(warn);
    }
  }
};
