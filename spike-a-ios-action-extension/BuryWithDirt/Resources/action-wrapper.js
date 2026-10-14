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
