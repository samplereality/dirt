#!/bin/sh
# Assemble per-spike bundles from the single dirt-core.js source.
#  - Spike A needs the core inlined into Action.js (Safari loads exactly one preprocessing file).
#  - Spike B's extension folder gets a copy so it can be loaded unpackaged in Chrome/Firefox.
#  - The iOS targets reference ../dirt-core.js directly; nothing to do for Spike C.
set -eu
cd "$(dirname "$0")"
CORE=dirt-core.js
A=spike-a-ios-action-extension/BuryWithDirt/Resources
{
  cat "$CORE"
  printf '\n// ---- embedded copy of the module source, for the script-tag fallback ----\n'
  printf 'var DIRT_CORE_SOURCE = %s;\n\n' "$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8")))' "$CORE")"
  cat "$A/action-wrapper.js"
} > "$A/Action.js"
cp "$CORE" spike-b-safari-web-extension/extension/dirt-core.js
echo "built $A/Action.js and spike-b-safari-web-extension/extension/dirt-core.js"
