/*!
 * dirt-core.js — "Dirt" by Mark Sample. Phase-1 feasibility spike.
 *
 * One self-contained, dependency-free module. It never reads or changes the
 * host page; it only draws on top of it:
 *   - one full-viewport fixed container at max z-index, isolated in a Shadow DOM
 *   - everything rendered to <canvas> (a low-res falling-sand grid for dirt,
 *     a device-resolution persistent canvas for growth)
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
    buryMs: 20000,      // target time for dirt to cover the viewport
    growMs: 25000,      // target time for greenery to overtake the dirt
    maxDpr: 2,          // cap device pixel ratio for the growth canvas
    maxTips: 320,       // concurrent growing shoot tips
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
  var FLOWER_COL = ['#fff6d5', '#ffd84a', '#ff8fb1', '#c9a6ff'];

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
      t0: 0, tPhase: 0, lastT: 0, frames: 0, raf: 0,
      stats: { dts: new Float32Array(120), di: 0, dn: 0, simMs: 0, drawMs: 0, longFrames: 0, p95: 0 },
      finalFill: null, finalIdx: 0,
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
    s.off = s.off || root.document.createElement('canvas');
    s.off.width = W; s.off.height = H;
    s.octx = s.off.getContext('2d');
    s.img = s.octx.createImageData(W, H);
    s.buf = new Uint32Array(s.img.data.buffer);
    s.dctx.imageSmoothingEnabled = false;

    // ~300 shovelfuls to fill the grid in buryMs.
    var shovels = 300;
    s.shovelCells = Math.max(24, Math.round((W * H) * 1.25 / shovels));
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
    for (var x = 0; x < W; x++) { var t = columnTop(s, x); tops[x] = t; if (t === 0) { full++; } }
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
      if (bt === 0) { return false; } // every probe hit a full column (the viewport is nearly buried)
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
      // Tamp down: fill any air pockets so the page is fully buried before growth begins.
      var g = s.grid;
      for (var i = 0; i < g.length; i++) { if (!g[i]) { g[i] = 1 + (i % DIRT_PAL.length); } }
      s.particles.length = 0;
      countFilled(s);
      drawDirt(s);
      setPhase(s, 'growing');
      return;
    }
    drawDirt(s);
  }

  // ---------------------------------------------------------------- growth phase
  function markGreen(s, px, py, r) {
    var cs = s.opts.cellSize, W = s.W, H = s.H, gr = s.green;
    var x0 = Math.max(0, Math.floor((px - r) / cs)), x1 = Math.min(W - 1, Math.floor((px + r) / cs));
    var y0 = Math.max(0, Math.floor((py - r) / cs)), y1 = Math.min(H - 1, Math.floor((py + r) / cs));
    for (var y = y0; y <= y1; y++) { for (var x = x0; x <= x1; x++) { gr[y * W + x] = 1; } }
  }

  function drawLeaf(s, x, y, ang, size, col) {
    var c = s.gctx;
    c.save();
    c.translate(x, y); c.rotate(ang);
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(size * 0.6, 0, size, size * 0.45, 0, 0, 6.2832);
    c.fill();
    c.restore();
    markGreen(s, x + Math.cos(ang) * size * 0.6, y + Math.sin(ang) * size * 0.6, size * 0.8);
  }

  function sprout(s, x, y, ang, depth, maxLen, w) {
    if (s.tips.length >= s.opts.maxTips) { return; }
    s.tips.push({ x: x, y: y, a: ang, len: 0, maxLen: maxLen, w: w, depth: depth,
      col: STEM_COL[Math.min(STEM_COL.length - 1, depth)] });
  }

  function stepGrow(s, dt, k) {
    var c = s.gctx, tips = s.tips, cw = s.cw, ch = s.ch;
    var elapsed = now() - s.tPhase;
    var grow = elapsed / s.opts.growMs; // 0..1 nominal progress
    // Seeds: first from the soil line (bottom edge), then wherever the soil is still bare.
    var seeds = s.phase !== 'growing' ? 0 : (grow < 0.12 ? 3 : 2);
    for (var sIdx = 0; sIdx < seeds; sIdx++) {
      if (grow < 0.12 || rnd() < 0.35) {
        sprout(s, rnd() * cw, ch + 2, -1.5708 + (rnd() - 0.5) * 0.8, 0, 90 + rnd() * 220, 2.6);
      } else {
        // probe for bare cells; sprout there (a seed in the soil)
        var cs = s.opts.cellSize, W = s.W, H = s.H;
        for (var t = 0; t < 24; t++) {
          var ci = Math.floor(rnd() * W * H);
          if (!s.green[ci]) {
            var px = (ci % W + 0.5) * cs, py = (Math.floor(ci / W) + 0.5) * cs;
            sprout(s, px, py, -1.5708 + (rnd() - 0.5) * 1.6, 1, 40 + rnd() * 120, 1.8);
            break;
          }
        }
      }
    }
    var step = (1.4 + grow * 1.2) * k, w = 0;
    for (var i = 0; i < tips.length; i++) {
      var tp = tips[i];
      var nx = tp.x + Math.cos(tp.a) * step, ny = tp.y + Math.sin(tp.a) * step;
      c.strokeStyle = tp.col; c.lineWidth = tp.w * (1 - 0.6 * tp.len / tp.maxLen);
      c.beginPath(); c.moveTo(tp.x, tp.y); c.lineTo(nx, ny); c.stroke();
      markGreen(s, nx, ny, tp.w);
      tp.x = nx; tp.y = ny; tp.len += step;
      // wobble + a gentle pull upward (phototropism)
      tp.a += (rnd() - 0.5) * 0.35 * k;
      tp.a += (-1.5708 - tp.a) * 0.025 * k;
      if (rnd() < 0.08 * k) {
        var side = rnd() < 0.5 ? 1 : -1;
        drawLeaf(s, nx, ny, tp.a + side * (1.1 + rnd() * 0.5), 3 + rnd() * 5 + grow * 4, LEAF_COL[Math.floor(rnd() * LEAF_COL.length)]);
      }
      if (tp.len > 12 && tp.depth < 4 && rnd() < 0.035 * k) {
        var bs = rnd() < 0.5 ? 1 : -1;
        sprout(s, nx, ny, tp.a + bs * (0.5 + rnd() * 0.7), tp.depth + 1, tp.maxLen * (0.45 + rnd() * 0.3), tp.w * 0.72);
      }
      var alive = tp.len < tp.maxLen && ny > -12 && nx > -12 && nx < cw + 12 && ny < ch + 12;
      if (!alive) {
        // terminal leaf cluster, occasionally a flower
        drawLeaf(s, nx, ny, tp.a, 4 + rnd() * 6, LEAF_COL[Math.floor(rnd() * LEAF_COL.length)]);
        if (rnd() < 0.08) {
          c.fillStyle = FLOWER_COL[Math.floor(rnd() * FLOWER_COL.length)];
          c.beginPath(); c.arc(nx, ny, 2 + rnd() * 2.5, 0, 6.2832); c.fill();
        }
        continue;
      }
      tips[w++] = tp;
    }
    tips.length = w;

    if (s.phase === 'growing' && (s.frames & 15) === 0) {
      var gr = s.green, n = 0;
      for (var j = 0; j < gr.length; j++) { n += gr[j]; }
      s.greenCov = n / gr.length;
      if ((s.greenCov >= 0.975 && elapsed > s.opts.growMs * 0.6) || elapsed > s.opts.growMs * 2.2) {
        // Final pass: list the bare cells and fill them with leaves over the next frames.
        var rest = [];
        for (var q = 0; q < gr.length; q++) { if (!gr[q]) { rest.push(q); } }
        s.finalFill = rest; s.finalIdx = 0;
        setPhase(s, 'garden');
      }
    }
  }

  function stepFinal(s) {
    var rest = s.finalFill, cs = s.opts.cellSize, W = s.W;
    var end = Math.min(rest.length, s.finalIdx + 120);
    for (; s.finalIdx < end; s.finalIdx++) {
      var ci = rest[s.finalIdx];
      if (s.green[ci]) { continue; }
      drawLeaf(s, (ci % W + 0.5) * cs, (Math.floor(ci / W) + 0.5) * cs, rnd() * 6.2832, 4 + rnd() * 5,
        LEAF_COL[Math.floor(rnd() * LEAF_COL.length)]);
    }
    if (s.finalIdx >= rest.length) {
      s.greenCov = 1;
      // Let the remaining tips finish, then stop the loop; the garden stays on screen.
      if (s.tips.length === 0) { s.running = false; s.finalFill = null; }
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
    else if (s.phase === 'garden' && s.finalFill) { stepGrow(s, dt, k); stepFinal(s); }
    var t3 = now();
    recordStats(s, dt, t2 - t1, t3 - t2);
    if (s.hud && (s.frames % 15) === 0) { s.hud.textContent = hudText(s); }
    if (!s.running) { s.raf = 0; }
  }

  function hudText(s) {
    var st = API.stats();
    return 'Dirt ' + VERSION + '  ' + s.phase + '  ' + s.W + 'x' + s.H + ' cells @' + s.dpr + 'x\n' +
      'fps ' + st.fps.toFixed(0) + '  frame ' + st.avgFrameMs.toFixed(1) + 'ms  p95 ' + st.p95FrameMs.toFixed(1) + 'ms  long ' + st.longFrames + '\n' +
      'sim ' + st.simMs.toFixed(2) + 'ms  draw ' + st.drawMs.toFixed(2) + 'ms  dirt ' + (st.coverage * 100).toFixed(0) + '%  green ' + (st.greenCoverage * 100).toFixed(0) + '%\n' +
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
        coverage: s.coverage, greenCoverage: s.greenCov,
        particles: s.particles.length, tips: s.tips.length
      };
    },
    // Heartbeat for the extension spikes: call from outside (e.g. WKWebView.evaluateJavaScript)
    // a few seconds apart; if the number keeps rising, the loop survived.
    ping: function () { return S ? S.frames : -1; }
  };

  root.Dirt = API;
  if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
