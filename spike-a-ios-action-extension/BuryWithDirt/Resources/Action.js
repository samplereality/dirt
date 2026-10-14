/*!
 * dirt-core.js — "Dirt" by Mark Sample. Phase-1 feasibility spike.
 *
 * One self-contained, dependency-free module. It never reads or changes the
 * host page; it only draws on top of it:
 *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM
 *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,
 *     a device-resolution persistent canvas for the plants)
 *   - the dirt buries 50–66% of the viewport from the bottom; the page stays visible above it
 *   - then: ground flowers fill the dirt, vines climb both edges of the window like a trellis,
 *     and flowering bushes rise from the soil line into roughly the next quarter of the window
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

  var VERSION = '0.1.0';
  var MAX_Z = 2147483647;
  var TAG = 'dirt-overlay';

  var DEFAULTS = {
    cellSize: 4,        // CSS px per simulation cell (dirt grid resolution)
    fill: [0.5, 0.66],  // how much of the viewport the dirt buries (fraction of height, picked at random)
    buryMs: 20000,      // target time for the dirt to reach its fill line
    growMs: 25000,      // target time for the garden to finish
    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line
    maxDpr: 2,          // cap device pixel ratio for the growth canvas
    maxTips: 320,       // concurrent growing bush tips
    debug: false,       // show the FPS / heartbeat HUD
    onPhase: null       // function(phase, dirt) — 'burying' | 'growing' | 'garden' | 'stopped'
  };

  // ---------------------------------------------------------------- helpers
  var now = (root.performance && root.performance.now) ? function () { return root.performance.now(); } : function () { return Date.now(); };

  // Small deterministic-ish PRNG (xorshift32); Math.random is fine but this is cheaper in hot loops.
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
      particles: [], tips: [],
      shovelAcc: 0, shovelInterval: 70, shovelCells: 60,
      coverage: 0, greenCov: 0, filled: 0, tops: null, topFull: 0,
      fillFrac: 0.58, targetTop: 0, dirtCells: 0,
      vines: [], bushes: [],
      t0: 0, tPhase: 0, lastT: 0, frames: 0, raf: 0,
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

  function layout(s, first) {
    var wh = viewportSize(s), cw = wh[0], ch = wh[1];
    var dpr = Math.min(root.devicePixelRatio || 1, s.opts.maxDpr);
    if (!first && cw === s.cw && ch === s.ch && dpr === s.dpr) { return; }
    var cs = s.opts.cellSize;
    var W = Math.max(8, Math.ceil(cw / cs)), H = Math.max(8, Math.ceil(ch / cs));

    // Dirt canvas is drawn at grid resolution and scaled up by the browser (pixel look, cheap).
    s.dirtCanvas.width = W * Math.min(dpr, 2); s.dirtCanvas.height = H * Math.min(dpr, 2);
    // Growth canvas: device resolution, persistent. Preserve existing strokes across a resize.
    var old = null;
    if (!first && s.growCanvas.width) {
      old = root.document.createElement('canvas');
      old.width = s.growCanvas.width; old.height = s.growCanvas.height;
      old.getContext('2d').drawImage(s.growCanvas, 0, 0);
    }
    s.growCanvas.width = Math.round(cw * dpr); s.growCanvas.height = Math.round(ch * dpr);
    s.gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    s.gctx.lineCap = 'round'; s.gctx.lineJoin = 'round';
    if (old) { s.gctx.drawImage(old, 0, 0, cw, ch); }

    // Grid (re)allocation with nearest-neighbour resample so dirt survives a resize / toolbar collapse.
    var grid = new Uint8Array(W * H), green = new Uint8Array(W * H);
    if (s.grid) {
      for (var y = 0; y < H; y++) {
        var sy = Math.min(s.H - 1, Math.floor(y * s.H / H));
        for (var x = 0; x < W; x++) {
          var sx = Math.min(s.W - 1, Math.floor(x * s.W / W));
          grid[y * W + x] = s.grid[sy * s.W + sx];
          green[y * W + x] = s.green[sy * s.W + sx];
        }
      }
    }
    s.cw = cw; s.ch = ch; s.dpr = dpr; s.W = W; s.H = H; s.grid = grid; s.green = green; s.tops = new Int16Array(W);
    s.targetTop = Math.max(1, H - Math.round(H * s.fillFrac)); // row the dirt surface must reach
    s.off = s.off || root.document.createElement('canvas');
    s.off.width = W; s.off.height = H;
    s.octx = s.off.getContext('2d');
    s.img = s.octx.createImageData(W, H);
    s.buf = new Uint32Array(s.img.data.buffer);
    s.dctx.imageSmoothingEnabled = false;

    // ~300 shovelfuls to reach the fill line in buryMs (a quarter extra for grains lost to slides).
    var shovels = 300;
    s.shovelCells = Math.max(24, Math.round((W * (H - s.targetTop)) * 1.25 / shovels));
    s.shovelInterval = Math.max(16, s.opts.buryMs / shovels);
  }

  // ---------------------------------------------------------------- dirt phase
  function columnTop(s, x) { // index of highest dirt cell in column (H if empty)
    var g = s.grid, W = s.W, H = s.H;
    for (var y = 0; y < H; y++) { if (g[y * W + x]) { return y; } }
    return H;
  }

  function surfaceScan(s) { // tops[x] = row of highest dirt cell (H if empty); also fraction of columns full
    var W = s.W, H = s.H, tops = s.tops || (s.tops = new Int16Array(W)), full = 0;
    for (var x = 0; x < W; x++) { var t = columnTop(s, x); tops[x] = t; if (t <= s.targetTop) { full++; } }
    s.topFull = full / W;
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
    var n = s.shovelCells;
    var vx = (rnd() - 0.5) * 0.5, vy = 0.35 + rnd() * 0.4;
    var spread = 2.5 + Math.sqrt(n) * 0.35;
    for (var i = 0; i < n; i++) {
      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;
      s.particles.push({
        x: bx + Math.cos(ang) * rad, y: -3 - Math.abs(Math.sin(ang) * rad) - rnd() * 4,
        vx: vx + (rnd() - 0.5) * 0.25, vy: vy + (rnd() - 0.5) * 0.15,
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
    var ps = s.particles, W = s.W, H = s.H, g = s.grid, G = 0.06 * k;
    var w = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      p.x += p.vx * k; p.y += p.vy * k; p.vy += G;
      if (p.x < 0) { p.x = 0; p.vx = -p.vx * 0.3; } else if (p.x >= W) { p.x = W - 0.01; p.vx = -p.vx * 0.3; }
      var cy = Math.floor(p.y), cx = Math.floor(p.x);
      if (cy >= H - 1 || (cy >= 0 && (g[cy * W + cx] || g[(cy + 1) * W + cx]))) { land(s, p); continue; }
      ps[w++] = p;
    }
    ps.length = w;
  }

  function settle(s) {
    var g = s.grid, W = s.W, H = s.H;
    for (var y = H - 2; y >= 0; y--) {
      var row = y * W, below = row + W;
      for (var x = 0; x < W; x++) {
        var i = row + x, v = g[i];
        if (!v) { continue; }
        if (!g[below + x]) { g[below + x] = v; g[i] = 0; continue; }
        var dir = (seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1;
        for (var t = 0; t < 2; t++, dir = -dir) {
          var nx = x + dir;
          if (nx >= 0 && nx < W && !g[below + nx] && !g[row + nx]) { g[below + nx] = v; g[i] = 0; break; }
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

  function stepBury(s, dt, k) {
    var elapsed = now() - s.tPhase;
    s.shovelAcc += dt;
    while (s.shovelAcc >= s.shovelInterval) {
      s.shovelAcc -= s.shovelInterval;
      if (s.topFull < 1) { spawnShovel(s); }
    }
    stepParticles(s, k);
    settle(s);
    if ((s.frames & 7) === 0) { countFilled(s); surfaceScan(s); }
    var done = (s.topFull >= 1 && s.particles.length === 0) || elapsed > s.opts.buryMs * 2.5;
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
    drawDirt(s);
  }

  // ---------------------------------------------------------------- growth phase
  // Three plant systems grow at once after the dirt settles:
  //   ground flowers — fill the dirt itself
  //   vines          — climb the left and right edges of the window, as if on a trellis
  //   bushes         — rise from the soil line to fill roughly the next quarter of the window

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

  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

  function drawLeaf(s, x, y, ang, size, col) {
    var c = s.gctx;
    c.save(); c.translate(x, y); c.rotate(ang);
    c.fillStyle = col;
    c.beginPath(); c.ellipse(size * 0.6, 0, size, size * 0.45, 0, 0, 6.2832); c.fill();
    c.restore();
  }

  function drawFlower(s, x, y, r, col, centerCol) {
    var c = s.gctx, n = 5 + (rnd() < 0.3 ? 1 : 0), rot = rnd() * 6.2832;
    c.fillStyle = col;
    for (var i = 0; i < n; i++) {
      var a = rot + i * 6.2832 / n;
      c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55, r * 0.35, a, 0, 6.2832); c.fill();
    }
    c.fillStyle = centerCol || '#ffd84a';
    c.beginPath(); c.arc(x, y, r * 0.3, 0, 6.2832); c.fill();
  }

  function initGarden(s) {
    var cw = s.cw, ch = s.ch, growMs = s.opts.growMs;
    s.tips = []; s.vines = []; s.bushes = [];
    var sum = 0; for (var x = 0; x < s.W; x++) { sum += s.tops[x]; }
    s.fillFrac = 1 - (sum / s.W) / s.H;
    s.dirtCells = s.filled;

    // Vines: two or three per side, staggered, each climbing from the soil line to the top edge.
    for (var side = -1; side <= 1; side += 2) {
      var n = 2 + (rnd() < 0.5 ? 1 : 0);
      for (var i = 0; i < n; i++) {
        var baseX = side < 0 ? 6 + rnd() * 16 : cw - 6 - rnd() * 16;
        var y0 = soilY(s, baseX) + 4;
        s.vines.push({
          side: side, baseX: baseX, x: baseX, y: y0, px: baseX, py: y0,
          amp: 10 + rnd() * 18, freq: 0.02 + rnd() * 0.025, phase: rnd() * 6.2832,
          v: (y0 + 12) / (growMs * (0.65 + rnd() * 0.25)),  // px per ms; reaches the top before growMs
          delay: i * growMs * 0.1 + rnd() * 1500,
          leafAcc: 0, nextLeaf: 10 + rnd() * 8, flowerAcc: 0, nextFlower: 25 + rnd() * 30, alt: 0,
          col: pick(STEM_COL), leafCol: pick(LEAF_COL), flowerCol: pick(VINE_FLOWER_COL), done: false
        });
      }
    }

    // Bushes: spaced across the width, each with its own height target and flower colour.
    var count = Math.max(3, Math.round(cw / 72)), bh = s.opts.bushHeight;
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
    s.tips.push({ bush: bush, x: x, y: y, a: ang, len: 0, maxLen: maxLen, w: w, depth: depth });
  }

  function stepBushes(s, dt, k, elapsed) {
    var c = s.gctx, tips = s.tips, cw = s.cw, i, w = 0;
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
      c.strokeStyle = bush.stemCol; c.lineWidth = tp.w * (1 - 0.55 * tp.len / tp.maxLen);
      c.beginPath(); c.moveTo(tp.x, tp.y); c.lineTo(nx, ny); c.stroke();
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
    var c = s.gctx, cw = s.cw;
    for (var i = 0; i < s.vines.length; i++) {
      var v = s.vines[i];
      if (v.done || elapsed < v.delay) { continue; }
      var dy = v.v * dt;
      v.y -= dy;
      v.x = v.baseX + Math.sin(v.y * v.freq + v.phase) * v.amp - v.side * Math.abs(Math.cos(v.y * v.freq * 0.5)) * 4;
      c.strokeStyle = v.col; c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(v.px, v.py); c.lineTo(v.x, v.y); c.stroke();
      v.px = v.x; v.py = v.y;
      v.leafAcc += dy; v.flowerAcc += dy;
      if (v.leafAcc >= v.nextLeaf) {
        v.leafAcc = 0; v.nextLeaf = 9 + rnd() * 9; v.alt ^= 1;
        var inward = v.side < 0 ? 0 : 3.1416;
        drawLeaf(s, v.x, v.y, inward + (v.alt ? 0.75 : -0.75) * -v.side, 5 + rnd() * 5, v.leafCol);
        if (rnd() < 0.25) { // tendril curling inward
          c.strokeStyle = v.col; c.lineWidth = 1.2;
          var len = 14 + rnd() * 26, dir = -v.side;
          c.beginPath(); c.moveTo(v.x, v.y);
          c.quadraticCurveTo(v.x + dir * len * 0.7, v.y - len * 0.5, v.x + dir * len, v.y + (rnd() - 0.5) * len * 0.6);
          c.stroke();
        }
      }
      if (v.flowerAcc >= v.nextFlower) {
        v.flowerAcc = 0; v.nextFlower = 22 + rnd() * 34;
        drawFlower(s, v.x - v.side * (4 + rnd() * 8), v.y, 4.5 + rnd() * 2.5, v.flowerCol, '#fff7cc');
      }
      if (v.y < -8 || v.x < -20 || v.x > cw + 20) { v.done = true; }
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
          s.gctx.strokeStyle = pick(STEM_COL); s.gctx.lineWidth = 1;
          s.gctx.beginPath(); s.gctx.moveTo(px, py + r * 1.6); s.gctx.lineTo(px, py); s.gctx.stroke();
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
    var elapsed = now() - s.tPhase;
    stepGroundFlowers(s, k);
    stepVines(s, dt, k, elapsed);
    stepBushes(s, dt, k, elapsed);

    if ((s.frames & 15) === 0) {
      var g = s.grid, gr = s.green, n = 0, i;
      for (i = 0; i < gr.length; i++) { if (g[i] && gr[i]) { n++; } }
      s.greenCov = s.dirtCells ? n / s.dirtCells : 1;
      var vinesDone = true; for (i = 0; i < s.vines.length; i++) { if (!s.vines[i].done) { vinesDone = false; } }
      var bushesDone = s.tips.length === 0; for (i = 0; i < s.bushes.length; i++) { if (!s.bushes[i].started) { bushesDone = false; } }
      var flowersDone = s.greenCov >= 0.6;
      if ((vinesDone && bushesDone && flowersDone) || elapsed > s.opts.growMs * 1.6) {
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
    var t1 = now();
    if (s.phase === 'burying') { stepBury(s, dt, k); }
    var t2 = now();
    if (s.phase === 'growing') { stepGrow(s, dt, k); }
    var t3 = now();
    recordStats(s, dt, t2 - t1, t3 - t2);
    if (s.hud && (s.frames % 15) === 0) { s.hud.textContent = hudText(s); }
    if (!s.running) { s.raf = 0; }
  }

  function hudText(s) {
    var st = API.stats();
    return 'Dirt ' + VERSION + '  ' + s.phase + '  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\n' +
      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\n' +
      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.coverage * 100).toFixed(0) + '/' + (st.fill * 100).toFixed(0) + '%  flowers ' + (st.greenCoverage * 100).toFixed(0) + '%\n' +
      't ' + st.elapsed.toFixed(1) + 's  heartbeat ' + st.frames;
  }

  function onResize() { if (S && S.host) { layout(S, false); } }

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
      buildDom(s);
      layout(s, true);
      s.t0 = now(); s.running = true;
      root.addEventListener('resize', onResize);
      if (root.visualViewport) { root.visualViewport.addEventListener('resize', onResize); }
      setPhase(s, 'burying');
      s.raf = root.requestAnimationFrame(frame);
      return API;
    },
    stop: function () {
      var s = S; if (!s) { return API; }
      s.running = false;
      if (s.raf) { root.cancelAnimationFrame(s.raf); }
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
        version: VERSION, phase: s.phase, running: s.running,
        grid: [s.W, s.H], viewport: [s.cw, s.ch], dpr: s.dpr,
        fps: avg ? 1000 / avg : 0, avgFrameMs: avg, p95FrameMs: st.p95,
        simMs: st.simMs, drawMs: st.drawMs, longFrames: st.longFrames,
        frames: s.frames, elapsed: (now() - s.t0) / 1000,
        coverage: s.coverage, fill: s.fillFrac, greenCoverage: s.greenCov,
        particles: s.particles.length, tips: s.tips.length,
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
var DIRT_CORE_SOURCE = "/*!\n * dirt-core.js — \"Dirt\" by Mark Sample. Phase-1 feasibility spike.\n *\n * One self-contained, dependency-free module. It never reads or changes the\n * host page; it only draws on top of it:\n *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM\n *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,\n *     a device-resolution persistent canvas for the plants)\n *   - the dirt buries 50–66% of the viewport from the bottom; the page stays visible above it\n *   - then: ground flowers fill the dirt, vines climb both edges of the window like a trellis,\n *     and flowering bushes rise from the soil line into roughly the next quarter of the window\n *   - no data collection, no network requests, no storage\n *\n * Usage:   Dirt.start({ debug: true })   Dirt.stop()   Dirt.stats()   Dirt.phase\n *\n * Plain ES2017 inside an IIFE so the same file can be inlined into a <script>,\n * a Safari Action-extension preprocessing file, a Web Extension content script,\n * or a WKUserScript without any build step.\n */\n(function (root) {\n  'use strict';\n  if (root.Dirt && root.Dirt.__dirt) { return; }\n\n  var VERSION = '0.1.0';\n  var MAX_Z = 2147483647;\n  var TAG = 'dirt-overlay';\n\n  var DEFAULTS = {\n    cellSize: 4,        // CSS px per simulation cell (dirt grid resolution)\n    fill: [0.5, 0.66],  // how much of the viewport the dirt buries (fraction of height, picked at random)\n    buryMs: 20000,      // target time for the dirt to reach its fill line\n    growMs: 25000,      // target time for the garden to finish\n    bushHeight: [0.15, 0.25], // bushes rise this fraction of the viewport height above the soil line\n    maxDpr: 2,          // cap device pixel ratio for the growth canvas\n    maxTips: 320,       // concurrent growing bush tips\n    debug: false,       // show the FPS / heartbeat HUD\n    onPhase: null       // function(phase, dirt) — 'burying' | 'growing' | 'garden' | 'stopped'\n  };\n\n  // ---------------------------------------------------------------- helpers\n  var now = (root.performance && root.performance.now) ? function () { return root.performance.now(); } : function () { return Date.now(); };\n\n  // Small deterministic-ish PRNG (xorshift32); Math.random is fine but this is cheaper in hot loops.\n  var seed = (Date.now() & 0x7fffffff) || 1;\n  function rnd() {\n    if (!seed) { seed = 0x9e3779b9; }\n    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;\n    return ((seed >>> 0) % 1000000) / 1000000;\n  }\n\n  function rgba32(hex) { // '#rrggbb' -> little-endian ABGR uint32 for ImageData buffers\n    var n = parseInt(hex.slice(1), 16);\n    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;\n    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;\n  }\n\n  var DIRT_HEX = ['#5b3a21', '#6b4426', '#4a2e18', '#7a5230', '#3f2713', '#86592f', '#56361f'];\n  var DIRT_PAL = DIRT_HEX.map(rgba32);\n  var STEM_COL = ['#2f6b2a', '#3b8a33', '#4a9c3c', '#5aa84a'];\n  var LEAF_COL = ['#55a33b', '#6cbf45', '#8fd45a', '#3f8f36', '#79c94f', '#a3e06a'];\n  var FLOWER_COL = ['#fff6d5', '#ffd84a', '#ff8fb1', '#c9a6ff', '#ff6f59', '#ffb347', '#f7f7f7', '#e04f8a'];\n  var VINE_FLOWER_COL = ['#7b5cff', '#c66bd6', '#ff8fb1', '#5aa9ff', '#f4f0ff'];\n  var BUSH_FLOWER_COL = ['#ff5d8f', '#ffd166', '#ffffff', '#ff8c42', '#d96bff', '#ff4d6d'];\n\n  // ---------------------------------------------------------------- state\n  var S = null; // live state while running\n\n  function makeState(opts) {\n    return {\n      opts: opts,\n      phase: 'idle',\n      host: null, shadow: null, dirtCanvas: null, growCanvas: null, hud: null,\n      dctx: null, gctx: null, off: null, octx: null, img: null, buf: null,\n      cw: 0, ch: 0, dpr: 1, W: 0, H: 0,\n      grid: null, green: null,\n      particles: [], tips: [],\n      shovelAcc: 0, shovelInterval: 70, shovelCells: 60,\n      coverage: 0, greenCov: 0, filled: 0, tops: null, topFull: 0,\n      fillFrac: 0.58, targetTop: 0, dirtCells: 0,\n      vines: [], bushes: [],\n      t0: 0, tPhase: 0, lastT: 0, frames: 0, raf: 0,\n      stats: { dts: new Float32Array(120), di: 0, dn: 0, simMs: 0, drawMs: 0, longFrames: 0, p95: 0 },\n      running: false\n    };\n  }\n\n  // ---------------------------------------------------------------- DOM\n  function buildDom(s) {\n    var doc = root.document;\n    var host = doc.createElement(TAG);\n    host.setAttribute('aria-hidden', 'true');\n    // Inline !important beats any host-page stylesheet short of its own !important on a matching selector.\n    host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +\n      'width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;' +\n      'z-index:' + MAX_Z + '!important;pointer-events:none!important;display:block!important;' +\n      'transform:none!important;opacity:1!important;visibility:visible!important;contain:strict;';\n    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;\n    var style = doc.createElement('style');\n    style.textContent = ':host{all:initial;display:block}' +\n      'canvas{position:absolute;top:0;left:0;width:100%;height:100%;display:block;image-rendering:pixelated;}' +\n      '.hud{position:absolute;top:env(safe-area-inset-top,0);left:0;margin:4px;padding:4px 6px;font:11px/1.35 ui-monospace,Menlo,monospace;' +\n      'color:#b8ffb0;background:rgba(0,0,0,.72);border-radius:4px;white-space:pre;pointer-events:none;}';\n    shadow.appendChild(style);\n    var dirtCanvas = doc.createElement('canvas');\n    var growCanvas = doc.createElement('canvas');\n    shadow.appendChild(dirtCanvas);\n    shadow.appendChild(growCanvas);\n    if (s.opts.debug) {\n      var hud = doc.createElement('div');\n      hud.className = 'hud';\n      shadow.appendChild(hud);\n      s.hud = hud;\n    }\n    (doc.documentElement || doc.body).appendChild(host);\n    s.host = host; s.shadow = shadow; s.dirtCanvas = dirtCanvas; s.growCanvas = growCanvas;\n    s.dctx = dirtCanvas.getContext('2d', { alpha: true });\n    s.gctx = growCanvas.getContext('2d', { alpha: true });\n  }\n\n  function viewportSize(s) {\n    var r = s.host.getBoundingClientRect();\n    var w = Math.round(r.width) || root.innerWidth || 320;\n    var h = Math.round(r.height) || root.innerHeight || 480;\n    return [w, h];\n  }\n\n  function layout(s, first) {\n    var wh = viewportSize(s), cw = wh[0], ch = wh[1];\n    var dpr = Math.min(root.devicePixelRatio || 1, s.opts.maxDpr);\n    if (!first && cw === s.cw && ch === s.ch && dpr === s.dpr) { return; }\n    var cs = s.opts.cellSize;\n    var W = Math.max(8, Math.ceil(cw / cs)), H = Math.max(8, Math.ceil(ch / cs));\n\n    // Dirt canvas is drawn at grid resolution and scaled up by the browser (pixel look, cheap).\n    s.dirtCanvas.width = W * Math.min(dpr, 2); s.dirtCanvas.height = H * Math.min(dpr, 2);\n    // Growth canvas: device resolution, persistent. Preserve existing strokes across a resize.\n    var old = null;\n    if (!first && s.growCanvas.width) {\n      old = root.document.createElement('canvas');\n      old.width = s.growCanvas.width; old.height = s.growCanvas.height;\n      old.getContext('2d').drawImage(s.growCanvas, 0, 0);\n    }\n    s.growCanvas.width = Math.round(cw * dpr); s.growCanvas.height = Math.round(ch * dpr);\n    s.gctx.setTransform(dpr, 0, 0, dpr, 0, 0);\n    s.gctx.lineCap = 'round'; s.gctx.lineJoin = 'round';\n    if (old) { s.gctx.drawImage(old, 0, 0, cw, ch); }\n\n    // Grid (re)allocation with nearest-neighbour resample so dirt survives a resize / toolbar collapse.\n    var grid = new Uint8Array(W * H), green = new Uint8Array(W * H);\n    if (s.grid) {\n      for (var y = 0; y < H; y++) {\n        var sy = Math.min(s.H - 1, Math.floor(y * s.H / H));\n        for (var x = 0; x < W; x++) {\n          var sx = Math.min(s.W - 1, Math.floor(x * s.W / W));\n          grid[y * W + x] = s.grid[sy * s.W + sx];\n          green[y * W + x] = s.green[sy * s.W + sx];\n        }\n      }\n    }\n    s.cw = cw; s.ch = ch; s.dpr = dpr; s.W = W; s.H = H; s.grid = grid; s.green = green; s.tops = new Int16Array(W);\n    s.targetTop = Math.max(1, H - Math.round(H * s.fillFrac)); // row the dirt surface must reach\n    s.off = s.off || root.document.createElement('canvas');\n    s.off.width = W; s.off.height = H;\n    s.octx = s.off.getContext('2d');\n    s.img = s.octx.createImageData(W, H);\n    s.buf = new Uint32Array(s.img.data.buffer);\n    s.dctx.imageSmoothingEnabled = false;\n\n    // ~300 shovelfuls to reach the fill line in buryMs (a quarter extra for grains lost to slides).\n    var shovels = 300;\n    s.shovelCells = Math.max(24, Math.round((W * (H - s.targetTop)) * 1.25 / shovels));\n    s.shovelInterval = Math.max(16, s.opts.buryMs / shovels);\n  }\n\n  // ---------------------------------------------------------------- dirt phase\n  function columnTop(s, x) { // index of highest dirt cell in column (H if empty)\n    var g = s.grid, W = s.W, H = s.H;\n    for (var y = 0; y < H; y++) { if (g[y * W + x]) { return y; } }\n    return H;\n  }\n\n  function surfaceScan(s) { // tops[x] = row of highest dirt cell (H if empty); also fraction of columns full\n    var W = s.W, H = s.H, tops = s.tops || (s.tops = new Int16Array(W)), full = 0;\n    for (var x = 0; x < W; x++) { var t = columnTop(s, x); tops[x] = t; if (t <= s.targetTop) { full++; } }\n    s.topFull = full / W;\n    return tops;\n  }\n\n  function spawnShovel(s) {\n    var W = s.W, tops = surfaceScan(s);\n    var bx;\n    if (rnd() < 0.5 + 0.5 * s.topFull) {\n      // Aim at a low point in the surface: pick the deepest of several random probes.\n      var probes = 6 + Math.round(s.topFull * 24), bt = -1;\n      for (var k = 0; k < probes; k++) {\n        var cx = Math.floor(rnd() * W);\n        if (tops[cx] > bt) { bt = tops[cx]; bx = cx; }\n      }\n      if (bt <= s.targetTop) { return false; } // every probe hit a finished column\n    } else {\n      bx = Math.floor(rnd() * W);\n    }\n    var n = s.shovelCells;\n    var vx = (rnd() - 0.5) * 0.5, vy = 0.35 + rnd() * 0.4;\n    var spread = 2.5 + Math.sqrt(n) * 0.35;\n    for (var i = 0; i < n; i++) {\n      var ang = rnd() * 6.2832, rad = Math.sqrt(rnd()) * spread;\n      s.particles.push({\n        x: bx + Math.cos(ang) * rad, y: -3 - Math.abs(Math.sin(ang) * rad) - rnd() * 4,\n        vx: vx + (rnd() - 0.5) * 0.25, vy: vy + (rnd() - 0.5) * 0.15,\n        c: 1 + Math.floor(rnd() * DIRT_PAL.length)\n      });\n    }\n    return true;\n  }\n\n  function land(s, p) {\n    var W = s.W, H = s.H, g = s.grid;\n    var cx = Math.max(0, Math.min(W - 1, Math.floor(p.x)));\n    var cy = Math.min(H - 1, Math.floor(p.y));\n    while (cy >= 0 && g[cy * W + cx]) { cy--; }\n    if (cy >= 0) { g[cy * W + cx] = p.c; }\n  }\n\n  function stepParticles(s, k) {\n    var ps = s.particles, W = s.W, H = s.H, g = s.grid, G = 0.06 * k;\n    var w = 0;\n    for (var i = 0; i < ps.length; i++) {\n      var p = ps[i];\n      p.x += p.vx * k; p.y += p.vy * k; p.vy += G;\n      if (p.x < 0) { p.x = 0; p.vx = -p.vx * 0.3; } else if (p.x >= W) { p.x = W - 0.01; p.vx = -p.vx * 0.3; }\n      var cy = Math.floor(p.y), cx = Math.floor(p.x);\n      if (cy >= H - 1 || (cy >= 0 && (g[cy * W + cx] || g[(cy + 1) * W + cx]))) { land(s, p); continue; }\n      ps[w++] = p;\n    }\n    ps.length = w;\n  }\n\n  function settle(s) {\n    var g = s.grid, W = s.W, H = s.H;\n    for (var y = H - 2; y >= 0; y--) {\n      var row = y * W, below = row + W;\n      for (var x = 0; x < W; x++) {\n        var i = row + x, v = g[i];\n        if (!v) { continue; }\n        if (!g[below + x]) { g[below + x] = v; g[i] = 0; continue; }\n        var dir = (seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1;\n        for (var t = 0; t < 2; t++, dir = -dir) {\n          var nx = x + dir;\n          if (nx >= 0 && nx < W && !g[below + nx] && !g[row + nx]) { g[below + nx] = v; g[i] = 0; break; }\n        }\n      }\n    }\n  }\n\n  function countFilled(s) {\n    var g = s.grid, n = 0;\n    for (var i = 0; i < g.length; i++) { if (g[i]) { n++; } }\n    s.filled = n; s.coverage = n / g.length;\n    return n;\n  }\n\n  function drawDirt(s) {\n    var g = s.grid, buf = s.buf, n = g.length;\n    for (var i = 0; i < n; i++) { buf[i] = g[i] ? DIRT_PAL[g[i] - 1] : 0; }\n    var ps = s.particles, W = s.W, H = s.H;\n    for (var j = 0; j < ps.length; j++) {\n      var p = ps[j], cy = Math.floor(p.y), cx = Math.floor(p.x);\n      if (cy >= 0 && cy < H && cx >= 0 && cx < W) { buf[cy * W + cx] = DIRT_PAL[p.c - 1]; }\n    }\n    s.octx.putImageData(s.img, 0, 0);\n    s.dctx.clearRect(0, 0, s.dirtCanvas.width, s.dirtCanvas.height);\n    s.dctx.drawImage(s.off, 0, 0, s.dirtCanvas.width, s.dirtCanvas.height);\n  }\n\n  function stepBury(s, dt, k) {\n    var elapsed = now() - s.tPhase;\n    s.shovelAcc += dt;\n    while (s.shovelAcc >= s.shovelInterval) {\n      s.shovelAcc -= s.shovelInterval;\n      if (s.topFull < 1) { spawnShovel(s); }\n    }\n    stepParticles(s, k);\n    settle(s);\n    if ((s.frames & 7) === 0) { countFilled(s); surfaceScan(s); }\n    var done = (s.topFull >= 1 && s.particles.length === 0) || elapsed > s.opts.buryMs * 2.5;\n    if (done) {\n      // Tamp down: fill air pockets beneath the surface so the dirt reads as solid ground.\n      var g = s.grid, W = s.W, H = s.H;\n      surfaceScan(s);\n      for (var x = 0; x < W; x++) { for (var y = s.tops[x]; y < H; y++) { var i = y * W + x; if (!g[i]) { g[i] = 1 + (i % DIRT_PAL.length); } } }\n      s.particles.length = 0;\n      countFilled(s);\n      drawDirt(s);\n      initGarden(s);\n      setPhase(s, 'growing');\n      return;\n    }\n    drawDirt(s);\n  }\n\n  // ---------------------------------------------------------------- growth phase\n  // Three plant systems grow at once after the dirt settles:\n  //   ground flowers — fill the dirt itself\n  //   vines          — climb the left and right edges of the window, as if on a trellis\n  //   bushes         — rise from the soil line to fill roughly the next quarter of the window\n\n  function soilY(s, px) { // CSS-px y of the dirt surface under CSS-px x\n    var cs = s.opts.cellSize, x = Math.max(0, Math.min(s.W - 1, Math.floor(px / cs)));\n    return s.tops[x] * cs;\n  }\n\n  function markGreen(s, px, py, r) {\n    var cs = s.opts.cellSize, W = s.W, H = s.H, gr = s.green;\n    var x0 = Math.max(0, Math.floor((px - r) / cs)), x1 = Math.min(W - 1, Math.floor((px + r) / cs));\n    var y0 = Math.max(0, Math.floor((py - r) / cs)), y1 = Math.min(H - 1, Math.floor((py + r) / cs));\n    for (var y = y0; y <= y1; y++) { for (var x = x0; x <= x1; x++) { gr[y * W + x] = 1; } }\n  }\n\n  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }\n\n  function drawLeaf(s, x, y, ang, size, col) {\n    var c = s.gctx;\n    c.save(); c.translate(x, y); c.rotate(ang);\n    c.fillStyle = col;\n    c.beginPath(); c.ellipse(size * 0.6, 0, size, size * 0.45, 0, 0, 6.2832); c.fill();\n    c.restore();\n  }\n\n  function drawFlower(s, x, y, r, col, centerCol) {\n    var c = s.gctx, n = 5 + (rnd() < 0.3 ? 1 : 0), rot = rnd() * 6.2832;\n    c.fillStyle = col;\n    for (var i = 0; i < n; i++) {\n      var a = rot + i * 6.2832 / n;\n      c.beginPath(); c.ellipse(x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55, r * 0.35, a, 0, 6.2832); c.fill();\n    }\n    c.fillStyle = centerCol || '#ffd84a';\n    c.beginPath(); c.arc(x, y, r * 0.3, 0, 6.2832); c.fill();\n  }\n\n  function initGarden(s) {\n    var cw = s.cw, ch = s.ch, growMs = s.opts.growMs;\n    s.tips = []; s.vines = []; s.bushes = [];\n    var sum = 0; for (var x = 0; x < s.W; x++) { sum += s.tops[x]; }\n    s.fillFrac = 1 - (sum / s.W) / s.H;\n    s.dirtCells = s.filled;\n\n    // Vines: two or three per side, staggered, each climbing from the soil line to the top edge.\n    for (var side = -1; side <= 1; side += 2) {\n      var n = 2 + (rnd() < 0.5 ? 1 : 0);\n      for (var i = 0; i < n; i++) {\n        var baseX = side < 0 ? 6 + rnd() * 16 : cw - 6 - rnd() * 16;\n        var y0 = soilY(s, baseX) + 4;\n        s.vines.push({\n          side: side, baseX: baseX, x: baseX, y: y0, px: baseX, py: y0,\n          amp: 10 + rnd() * 18, freq: 0.02 + rnd() * 0.025, phase: rnd() * 6.2832,\n          v: (y0 + 12) / (growMs * (0.65 + rnd() * 0.25)),  // px per ms; reaches the top before growMs\n          delay: i * growMs * 0.1 + rnd() * 1500,\n          leafAcc: 0, nextLeaf: 10 + rnd() * 8, flowerAcc: 0, nextFlower: 25 + rnd() * 30, alt: 0,\n          col: pick(STEM_COL), leafCol: pick(LEAF_COL), flowerCol: pick(VINE_FLOWER_COL), done: false\n        });\n      }\n    }\n\n    // Bushes: spaced across the width, each with its own height target and flower colour.\n    var count = Math.max(3, Math.round(cw / 72)), bh = s.opts.bushHeight;\n    for (var b = 0; b < count; b++) {\n      var bx = (b + 0.3 + rnd() * 0.4) * cw / count;\n      var sy = soilY(s, bx);\n      var h = Math.min(sy - 6, (bh[0] + rnd() * (bh[1] - bh[0])) * ch);\n      s.bushes.push({\n        x: bx, sy: sy, top: sy - h, h: h, delay: rnd() * growMs * 0.3, started: false,\n        v: h / (growMs * 0.45), stemCol: pick(STEM_COL), leafCol: pick(LEAF_COL), leafCol2: pick(LEAF_COL),\n        flowerCol: pick(BUSH_FLOWER_COL)\n      });\n    }\n  }\n\n  function sproutTip(s, bush, x, y, ang, depth, maxLen, w) {\n    if (s.tips.length >= s.opts.maxTips) { return; }\n    s.tips.push({ bush: bush, x: x, y: y, a: ang, len: 0, maxLen: maxLen, w: w, depth: depth });\n  }\n\n  function stepBushes(s, dt, k, elapsed) {\n    var c = s.gctx, tips = s.tips, cw = s.cw, i, w = 0;\n    for (i = 0; i < s.bushes.length; i++) {\n      var bsh = s.bushes[i];\n      if (!bsh.started && elapsed >= bsh.delay) {\n        bsh.started = true;\n        var trunks = 1 + (rnd() < 0.6 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0);\n        for (var t = 0; t < trunks; t++) {\n          sproutTip(s, bsh, bsh.x + (rnd() - 0.5) * 10, bsh.sy + 2, -1.5708 + (rnd() - 0.5) * 0.7, 0, bsh.h * (0.8 + rnd() * 0.25), 3);\n        }\n      }\n    }\n    for (i = 0; i < tips.length; i++) {\n      var tp = tips[i], bush = tp.bush;\n      var step = bush.v * dt;\n      var nx = tp.x + Math.cos(tp.a) * step, ny = tp.y + Math.sin(tp.a) * step;\n      c.strokeStyle = bush.stemCol; c.lineWidth = tp.w * (1 - 0.55 * tp.len / tp.maxLen);\n      c.beginPath(); c.moveTo(tp.x, tp.y); c.lineTo(nx, ny); c.stroke();\n      tp.x = nx; tp.y = ny; tp.len += step;\n      tp.a += (rnd() - 0.5) * 0.3 * k;\n      tp.a += (-1.5708 - tp.a) * 0.03 * k;\n      if (rnd() < 0.08 * k) {\n        var side = rnd() < 0.5 ? 1 : -1;\n        drawLeaf(s, nx, ny, tp.a + side * (1.0 + rnd() * 0.6), 3.5 + rnd() * 4, rnd() < 0.5 ? bush.leafCol : bush.leafCol2);\n      }\n      if (rnd() < 0.025 * k && tp.depth < 3) { drawFlower(s, nx + (rnd() - 0.5) * 6, ny, 2.5 + rnd() * 2.5, bush.flowerCol); }\n      if (tp.len > 6 && tp.depth < 4 && rnd() < 0.07 * k) {\n        var bs = rnd() < 0.5 ? 1 : -1;\n        sproutTip(s, bush, nx, ny, tp.a + bs * (0.5 + rnd() * 0.6), tp.depth + 1, (tp.maxLen - tp.len) * (0.35 + rnd() * 0.35), tp.w * 0.7);\n      }\n      var alive = tp.len < tp.maxLen && ny > bush.top && ny < bush.sy + 4 && nx > -8 && nx < cw + 8;\n      if (!alive) {\n        // Bloom at the end of every branch; big flowers on the main stems.\n        drawLeaf(s, nx, ny, tp.a + 0.8, 4 + rnd() * 4, bush.leafCol);\n        drawLeaf(s, nx, ny, tp.a - 0.8, 4 + rnd() * 4, bush.leafCol2);\n        if (tp.depth <= 1 || rnd() < 0.6) { drawFlower(s, nx, ny, (tp.depth === 0 ? 6 : 3.5) + rnd() * 3, bush.flowerCol); }\n        continue;\n      }\n      tips[w++] = tp;\n    }\n    tips.length = w;\n  }\n\n  function stepVines(s, dt, k, elapsed) {\n    var c = s.gctx, cw = s.cw;\n    for (var i = 0; i < s.vines.length; i++) {\n      var v = s.vines[i];\n      if (v.done || elapsed < v.delay) { continue; }\n      var dy = v.v * dt;\n      v.y -= dy;\n      v.x = v.baseX + Math.sin(v.y * v.freq + v.phase) * v.amp - v.side * Math.abs(Math.cos(v.y * v.freq * 0.5)) * 4;\n      c.strokeStyle = v.col; c.lineWidth = 2.6;\n      c.beginPath(); c.moveTo(v.px, v.py); c.lineTo(v.x, v.y); c.stroke();\n      v.px = v.x; v.py = v.y;\n      v.leafAcc += dy; v.flowerAcc += dy;\n      if (v.leafAcc >= v.nextLeaf) {\n        v.leafAcc = 0; v.nextLeaf = 9 + rnd() * 9; v.alt ^= 1;\n        var inward = v.side < 0 ? 0 : 3.1416;\n        drawLeaf(s, v.x, v.y, inward + (v.alt ? 0.75 : -0.75) * -v.side, 5 + rnd() * 5, v.leafCol);\n        if (rnd() < 0.25) { // tendril curling inward\n          c.strokeStyle = v.col; c.lineWidth = 1.2;\n          var len = 14 + rnd() * 26, dir = -v.side;\n          c.beginPath(); c.moveTo(v.x, v.y);\n          c.quadraticCurveTo(v.x + dir * len * 0.7, v.y - len * 0.5, v.x + dir * len, v.y + (rnd() - 0.5) * len * 0.6);\n          c.stroke();\n        }\n      }\n      if (v.flowerAcc >= v.nextFlower) {\n        v.flowerAcc = 0; v.nextFlower = 22 + rnd() * 34;\n        drawFlower(s, v.x - v.side * (4 + rnd() * 8), v.y, 4.5 + rnd() * 2.5, v.flowerCol, '#fff7cc');\n      }\n      if (v.y < -8 || v.x < -20 || v.x > cw + 20) { v.done = true; }\n    }\n  }\n\n  function stepGroundFlowers(s, k) {\n    if (s.greenCov >= 0.75) { return; } // leave some soil showing between the flowers\n    var W = s.W, H = s.H, cs = s.opts.cellSize, g = s.grid, gr = s.green, tops = s.tops;\n    var want = 1 + (rnd() < 0.4 * k ? 1 : 0);\n    for (var n = 0; n < want; n++) {\n      for (var t = 0; t < 6; t++) {\n        var x = Math.floor(rnd() * W), top = tops[x];\n        if (top >= H) { continue; }\n        var y = top + Math.floor(rnd() * (H - top)), ci = y * W + x;\n        if (!g[ci] || gr[ci]) { continue; }\n        var px = (x + 0.5) * cs, py = (y + 0.5) * cs, r;\n        if (rnd() < 0.55) {\n          r = 2.5 + rnd() * 3.5;\n          s.gctx.strokeStyle = pick(STEM_COL); s.gctx.lineWidth = 1;\n          s.gctx.beginPath(); s.gctx.moveTo(px, py + r * 1.6); s.gctx.lineTo(px, py); s.gctx.stroke();\n          drawFlower(s, px, py, r, pick(FLOWER_COL));\n        } else {\n          r = 3 + rnd() * 3;\n          var a = rnd() * 6.2832;\n          drawLeaf(s, px, py, a, r, pick(LEAF_COL));\n          drawLeaf(s, px, py, a + 2.4, r * 0.9, pick(LEAF_COL));\n        }\n        markGreen(s, px, py, r * 1.1);\n        break;\n      }\n    }\n  }\n\n  function stepGrow(s, dt, k) {\n    var elapsed = now() - s.tPhase;\n    stepGroundFlowers(s, k);\n    stepVines(s, dt, k, elapsed);\n    stepBushes(s, dt, k, elapsed);\n\n    if ((s.frames & 15) === 0) {\n      var g = s.grid, gr = s.green, n = 0, i;\n      for (i = 0; i < gr.length; i++) { if (g[i] && gr[i]) { n++; } }\n      s.greenCov = s.dirtCells ? n / s.dirtCells : 1;\n      var vinesDone = true; for (i = 0; i < s.vines.length; i++) { if (!s.vines[i].done) { vinesDone = false; } }\n      var bushesDone = s.tips.length === 0; for (i = 0; i < s.bushes.length; i++) { if (!s.bushes[i].started) { bushesDone = false; } }\n      var flowersDone = s.greenCov >= 0.6;\n      if ((vinesDone && bushesDone && flowersDone) || elapsed > s.opts.growMs * 1.6) {\n        setPhase(s, 'garden');\n        s.running = false; // the garden stays on screen; nothing left to animate\n      }\n    }\n  }\n\n  // ---------------------------------------------------------------- loop\n  function setPhase(s, p) {\n    s.phase = p; s.tPhase = now();\n    if (typeof s.opts.onPhase === 'function') { try { s.opts.onPhase(p, API); } catch (e) { /* host callback error ignored */ } }\n  }\n\n  function recordStats(s, dt, simMs, drawMs) {\n    var st = s.stats;\n    st.dts[st.di] = dt; st.di = (st.di + 1) % st.dts.length; if (st.dn < st.dts.length) { st.dn++; }\n    st.simMs = st.simMs * 0.9 + simMs * 0.1;\n    st.drawMs = st.drawMs * 0.9 + drawMs * 0.1;\n    if (dt > 34) { st.longFrames++; }\n    if ((s.frames % 30) === 0 && st.dn > 10) {\n      var a = Array.prototype.slice.call(st.dts, 0, st.dn).sort(function (p, q) { return p - q; });\n      st.p95 = a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];\n    }\n  }\n\n  function frame(t) {\n    var s = S;\n    if (!s || !s.running) { return; }\n    s.raf = root.requestAnimationFrame(frame);\n    var dt = s.lastT ? Math.min(t - s.lastT, 100) : 16.7;\n    s.lastT = t; s.frames++;\n    var k = Math.min(dt / 16.667, 3); // time-scale so motion is frame-rate independent\n    var t1 = now();\n    if (s.phase === 'burying') { stepBury(s, dt, k); }\n    var t2 = now();\n    if (s.phase === 'growing') { stepGrow(s, dt, k); }\n    var t3 = now();\n    recordStats(s, dt, t2 - t1, t3 - t2);\n    if (s.hud && (s.frames % 15) === 0) { s.hud.textContent = hudText(s); }\n    if (!s.running) { s.raf = 0; }\n  }\n\n  function hudText(s) {\n    var st = API.stats();\n    return 'Dirt ' + VERSION + '  ' + s.phase + '  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\\n' +\n      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\\n' +\n      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.coverage * 100).toFixed(0) + '/' + (st.fill * 100).toFixed(0) + '%  flowers ' + (st.greenCoverage * 100).toFixed(0) + '%\\n' +\n      't ' + st.elapsed.toFixed(1) + 's  heartbeat ' + st.frames;\n  }\n\n  function onResize() { if (S && S.host) { layout(S, false); } }\n\n  // ---------------------------------------------------------------- API\n  var API = {\n    __dirt: true,\n    version: VERSION,\n    get phase() { return S ? S.phase : 'idle'; },\n    get running() { return !!(S && S.running); },\n    start: function (opts) {\n      if (S && S.running) { return API; }\n      if (S) { API.stop(); }\n      var o = {}; for (var kk in DEFAULTS) { o[kk] = DEFAULTS[kk]; }\n      if (opts) { for (var k2 in opts) { if (opts[k2] !== undefined) { o[k2] = opts[k2]; } } }\n      var s = S = makeState(o);\n      s.fillFrac = o.fill[0] + rnd() * (o.fill[1] - o.fill[0]);\n      buildDom(s);\n      layout(s, true);\n      s.t0 = now(); s.running = true;\n      root.addEventListener('resize', onResize);\n      if (root.visualViewport) { root.visualViewport.addEventListener('resize', onResize); }\n      setPhase(s, 'burying');\n      s.raf = root.requestAnimationFrame(frame);\n      return API;\n    },\n    stop: function () {\n      var s = S; if (!s) { return API; }\n      s.running = false;\n      if (s.raf) { root.cancelAnimationFrame(s.raf); }\n      root.removeEventListener('resize', onResize);\n      if (root.visualViewport) { root.visualViewport.removeEventListener('resize', onResize); }\n      if (s.host && s.host.parentNode) { s.host.parentNode.removeChild(s.host); }\n      setPhase(s, 'stopped');\n      S = null;\n      return API;\n    },\n    toggle: function (opts) { return (S && S.running) ? API.stop() : API.start(opts); },\n    stats: function () {\n      var s = S; if (!s) { return null; }\n      var st = s.stats, sum = 0;\n      for (var i = 0; i < st.dn; i++) { sum += st.dts[i]; }\n      var avg = st.dn ? sum / st.dn : 0;\n      return {\n        version: VERSION, phase: s.phase, running: s.running,\n        grid: [s.W, s.H], viewport: [s.cw, s.ch], dpr: s.dpr,\n        fps: avg ? 1000 / avg : 0, avgFrameMs: avg, p95FrameMs: st.p95,\n        simMs: st.simMs, drawMs: st.drawMs, longFrames: st.longFrames,\n        frames: s.frames, elapsed: (now() - s.t0) / 1000,\n        coverage: s.coverage, fill: s.fillFrac, greenCoverage: s.greenCov,\n        particles: s.particles.length, tips: s.tips.length,\n        vines: s.vines.filter(function (v) { return !v.done; }).length\n      };\n    },\n    // Heartbeat for the extension spikes: call from outside (e.g. WKWebView.evaluateJavaScript)\n    // a few seconds apart; if the number keeps rising, the loop survived.\n    ping: function () { return S ? S.frames : -1; }\n  };\n\n  root.Dirt = API;\n  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }\n})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));\n";

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
