#!/bin/sh
# Assemble per-spike bundles from the single dirt-core.js source.
#  - Spike A needs the core inlined into Action.js (Safari loads exactly one preprocessing file).
#  - The extension folder gets a copy of the core; it is the source for Safari (via Xcode) and for
#    development loads in Chrome. Store-ready, warning-free builds go to dist/chrome and dist/firefox:
#    the browsers disagree on which manifest keys name optional per-site access and the background
#    script, so each gets the keys it understands.
#  - The iOS targets reference ../dirt-core.js directly; nothing to do for Spike C.
set -eu
cd "$(dirname "$0")"
CORE=dirt-core.js
A=spike-a-ios-action-extension/BuryWithDirt/Resources
EXT=spike-b-safari-web-extension/extension
{
  cat "$CORE"
  printf '\n// ---- embedded copy of the module source, for the script-tag fallback ----\n'
  printf 'var DIRT_CORE_SOURCE = %s;\n\n' "$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$CORE")"
  cat "$A/action-wrapper.js"
} > "$A/Action.js"
cp "$CORE" "$EXT/dirt-core.js"

rm -rf dist/chrome dist/firefox
mkdir -p dist/chrome dist/firefox
cp "$EXT"/*.js dist/chrome/
cp "$EXT"/*.js dist/firefox/
node - "$EXT/manifest.json" <<'JS'
const fs = require('fs');
const src = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Chrome: service worker; optional per-site access via optional_host_permissions.
const chrome = JSON.parse(JSON.stringify(src));
chrome.background = { service_worker: src.background.service_worker };
delete chrome.browser_specific_settings;
fs.writeFileSync('dist/chrome/manifest.json', JSON.stringify(chrome, null, 2) + '\n');
// Firefox: background scripts; host_permissions are optional in Firefox MV3 (granted per site on request).
const firefox = JSON.parse(JSON.stringify(src));
firefox.background = { scripts: src.background.scripts };
firefox.host_permissions = src.optional_host_permissions;
delete firefox.optional_host_permissions;
firefox.browser_specific_settings = { gecko: src.browser_specific_settings.gecko };
fs.writeFileSync('dist/firefox/manifest.json', JSON.stringify(firefox, null, 2) + '\n');
JS
echo "built $A/Action.js, $EXT/dirt-core.js, dist/chrome, dist/firefox"
