/*!
 * dirt-core.js — "Dirt" by Mark Sample. Phase-1 feasibility spike.
 *
 * One self-contained, dependency-free module. It never reads or changes the
 * host page; it only draws on top of it:
 *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM
 *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,
 *     a device-resolution persistent canvas for the plants)
 *   - the dirt buries 50–66% of the viewport from the bottom; the page stays visible above it
 *   - then one kind of flora, chosen at random per run: ground flowers that fill the dirt, vines
 *     that climb both edges of the window like a trellis, or flowering bushes that rise from the
 *     soil line into roughly the next quarter of the window
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

  var VERSION = '0.2.0';
  var MAX_Z = 2147483647;
  var TAG = 'dirt-overlay';

  var DEFAULTS = {
    cellSize: 4,        // CSS px per simulation cell (dirt grid resolution)
    fill: [0.5, 0.66],  // how much of the viewport the dirt buries (fraction of height, picked at random)
    flora: 'random',    // which plants grow: 'flowers' | 'vines' | 'bushes' | 'random' (one kind per run)
    buryMs: 20000,      // target time for the dirt to reach its fill line
    growMs: 25000,      // target time for the garden to finish
    simHz: 30,          // sand-simulation tick rate; lower = chunkier, more hand-animated motion
    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line
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

  var DIRT_HEX = ['#5b3a21', '#6b4426', '#4a2e18', '#7a5230', '#3f2713', '#86592f', '#56361f'];
  var DIRT_PAL = DIRT_HEX.map(rgba32);
  var STEM_COL = ['#2f6b2a', '#3b8a33', '#4a9c3c', '#5aa84a'];
  var LEAF_COL = ['#55a33b', '#6cbf45', '#8fd45a', '#3f8f36', '#79c94f', '#a3e06a'];
  var FLOWER_COL = ['#fff6d5', '#ffd84a', '#ff8fb1', '#c9a6ff', '#ff6f59', '#ffb347', '#f7f7f7', '#e04f8a'];
  var VINE_FLOWER_COL = ['#7b5cff', '#c66bd6', '#ff8fb1', '#5aa9ff', '#f4f0ff'];
  var BUSH_FLOWER_COL = ['#ff5d8f', '#ffd166', '#ffffff', '#ff8c42', '#d96bff', '#ff4d6d'];

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
      fillFrac: 0.58, fillActual: 0, targetTop: 0, topMean: 1e9, dirtCells: 0, flora: 'flowers',
      vines: [], bushes: [],
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
          for (y = H - depth; y < H; y++) { grid[y * W + x] = 1 + Math.floor(rnd() * DIRT_PAL.length); }
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
    }
    s.cw = cw; s.ch = ch; s.dpr = dpr; s.W = W; s.H = H; s.grid = grid; s.green = green; s.tops = new Int16Array(W);
    s.targetTop = Math.max(1, H - Math.round(H * s.fillFrac)); // row the dirt surface must reach
    s.off = s.off || root.document.createElement('canvas');
    s.off.width = W; s.off.height = H;
    s.octx = s.off.getContext('2d');
    s.img = s.octx.createImageData(W, H);
    s.buf = new Uint32Array(s.img.data.buffer);

    // ~300 shovelfuls to reach the fill line in buryMs (a quarter extra for grains lost to slides).
    var shovels = 300;
    s.shovelCells = Math.max(24, Math.round((W * (H - s.targetTop)) * 1.25 / shovels));
    s.shovelInterval = Math.max(16, s.opts.buryMs / shovels);

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
    var spread = 2.5 + Math.sqrt(n) * 0.35;
    for (var i = 0; i < n; i++) {
      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;
      s.particles.push({
        x: bx + Math.cos(ang) * rad, y: -3 - Math.abs(Math.sin(ang) * rad) - rnd() * 6,
        vx: vx + (rnd() - 0.5) * 0.3, vy: vy + (rnd() - 0.5) * 0.2, g: g, vmax: vmax,
        c: 1 + Math.floor(rnd() * DIRT_PAL.length)
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
          else if (y + 2 < H && !g[below2 + nx] && (y === 0 || !g[row - W + x]) && (seed & 12) === 0) {
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
    for (var i = 0; i < n; i++) { buf[i] = g[i] ? DIRT_PAL[g[i] - 1] : 0; }
    var ps = s.particles, W = s.W, H = s.H;
    for (var j = 0; j < ps.length; j++) {
      var p = ps[j], cy = Math.floor(p.y), cx = Math.floor(p.x);
      if (cy >= 0 && cy < H && cx >= 0 && cx < W) { buf[cy * W + cx] = DIRT_PAL[p.c - 1]; }
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
      for (var x = 0; x < W; x++) { for (var y = s.tops[x]; y < H; y++) { var i = y * W + x; if (!g[i]) { g[i] = 1 + (i % DIRT_PAL.length); } } }
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
  function drawFlower(s, x, y, r, col, centerCol) {
    var n = 5 + (rnd() < 0.3 ? 1 : 0), rot = rnd() * 6.2832;
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

  function initGarden(s) {
    var cw = s.cw, ch = s.ch, growMs = s.opts.growMs;
    s.tips = []; s.vines = []; s.bushes = []; s.scene = [];
    s.dirtCells = s.filled;

    // Vines: three to five per side, staggered, each climbing from the soil line to the top edge.
    for (var side = -1; side <= 1 && s.flora === 'vines'; side += 2) {
      var n = 3 + Math.floor(rnd() * 3);
      for (var i = 0; i < n; i++) {
        var baseX = side < 0 ? 6 + rnd() * 16 : cw - 6 - rnd() * 16;
        var y0 = soilY(s, baseX) + 4;
        s.vines.push({
          side: side, baseX: baseX, x: baseX, y: y0, px: baseX, py: y0,
          amp: 14 + rnd() * 20, freq: 0.02 + rnd() * 0.025, phase: rnd() * 6.2832,
          v: (y0 + 12) / (growMs * (0.65 + rnd() * 0.25)),  // px per ms; reaches the top before growMs
          delay: i * growMs * 0.1 + rnd() * 1500,
          leafAcc: 0, nextLeaf: 10 + rnd() * 8, flowerAcc: 0, nextFlower: 25 + rnd() * 30, alt: 0,
          col: pick(STEM_COL), leafCol: pick(LEAF_COL), flowerCol: pick(VINE_FLOWER_COL), done: false, stroke: null
        });
      }
    }

    // Bushes: spaced across the width, each with its own height target and flower colour.
    var count = s.flora === 'bushes' ? Math.max(3, Math.round(cw / 72)) : 0, bh = s.opts.bushHeight;
    for (var b = 0; b < count; b++) {
      var bx = (b + 0.3 + rnd() * 0.4) * cw / count;
      var sy = soilY(s, bx);
      var h = Math.min(sy - 6, (bh[0] + rnd() * (bh[1] - bh[0])) * ch);
      s.bushes.push({
        x: bx, sy: sy, top: sy - h, h: h, delay: rnd() * growMs * 0.3, started: false,
        v: h / (growMs * 0.45), stemCol: pick(STEM_COL), leafCol: pick(LEAF_COL), leafCol2: pick(LEAF_COL),
        flowerCol: pick(BUSH_FLOWER_COL)
      });
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

  function stepGroundFlowers(s, k) {
    if (s.greenCov >= 0.75) { return; } // leave some soil showing between the flowers
    var W = s.W, H = s.H, cs = s.opts.cellSize, g = s.grid, gr = s.green, tops = s.tops;
    var want = 1 + (rnd() < 0.4 * k ? 1 : 0);
    for (var n = 0; n < want; n++) {
      for (var t = 0; t < 6; t++) {
        var x = Math.floor(rnd() * W), top = tops[x];
        if (top >= H) { continue; }
        var y = top + Math.floor(rnd() * (H - top)), ci = y * W + x;
        if (!g[ci] || gr[ci]) { continue; }
        var px = (x + 0.5) * cs, py = (y + 0.5) * cs, r;
        if (rnd() < 0.55) {
          r = 2.5 + rnd() * 3.5;
          var st = startStroke(s, px, py + r * 1.6, 1, pick(STEM_COL));
          st.pts.push(px, py);
          extendStroke(s, st, px, py + r * 1.6, px, py, 1);
          drawFlower(s, px, py, r, pick(FLOWER_COL));
        } else {
          r = 3 + rnd() * 3;
          var a = rnd() * 6.2832;
          drawLeaf(s, px, py, a, r, pick(LEAF_COL));
          drawLeaf(s, px, py, a + 2.4, r * 0.9, pick(LEAF_COL));
        }
        markGreen(s, px, py, r * 1.1);
        break;
      }
    }
  }

  function stepGrow(s, dt, k) {
    var elapsed = now() - s.tPhase, i;
    if (s.flora === 'flowers') { stepGroundFlowers(s, k); }
    else if (s.flora === 'vines') { stepVines(s, dt, k, elapsed); }
    else { stepBushes(s, dt, k, elapsed); }

    if ((s.frames & 15) === 0) {
      var finished;
      if (s.flora === 'flowers') {
        var g = s.grid, gr = s.green, n = 0;
        for (i = 0; i < gr.length; i++) { if (g[i] && gr[i]) { n++; } }
        s.greenCov = s.dirtCells ? n / s.dirtCells : 1;
        finished = s.greenCov >= 0.75;
      } else if (s.flora === 'vines') {
        finished = true;
        for (i = 0; i < s.vines.length; i++) { if (!s.vines[i].done) { finished = false; } }
      } else {
        finished = s.tips.length === 0;
        for (i = 0; i < s.bushes.length; i++) { if (!s.bushes[i].started) { finished = false; } }
      }
      if (finished || elapsed > s.opts.growMs * 1.6) {
        setPhase(s, 'garden');
        s.running = false; // the garden stays on screen; nothing left to animate
      }
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
    return 'Dirt ' + VERSION + '  ' + s.phase + ' (' + s.flora + ')  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\n' +
      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\n' +
      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.fillActual * 100).toFixed(0) + '/' + (st.fill * 100).toFixed(0) + '%  flowers ' + (st.greenCoverage * 100).toFixed(0) + '%\n' +
      't ' + st.elapsed.toFixed(1) + 's  heartbeat ' + st.frames + (s.running ? '' : '  (done; loop idle, clock still ticking)');
  }

  function onResize() { if (S && S.host) { checkSize(S); } }

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
      var kinds = ['flowers', 'vines', 'bushes'];
      s.flora = kinds.indexOf(o.flora) >= 0 ? o.flora : kinds[Math.floor(rnd() * kinds.length)];
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
      setPhase(s, 'burying');
      s.raf = root.requestAnimationFrame(frame);
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
        version: VERSION, phase: s.phase, flora: s.flora, running: s.running,
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
