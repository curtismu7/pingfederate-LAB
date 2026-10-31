#!/bin/bash
# Checks that the vendored shared stylesheet is byte-identical to the family's canonical copy.
# STANDALONE_UI_CANONICAL overrides the canonical path. Where the canonical copy is not present (CI), it says so and passes.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
canonical="${STANDALONE_UI_CANONICAL:-$HOME/Development/AI-DEMO-Standalone/shared/standalone-ui.css}"
copy="$root/web/src/standalone-ui.css"
if [ ! -f "$copy" ]; then echo "MISSING web/src/standalone-ui.css"; exit 1; fi
if [ ! -f "$canonical" ]; then echo "SKIP    canonical standalone-ui.css not found ($canonical); drift not checked"; exit 0; fi
if cmp -s "$canonical" "$copy"; then echo "OK      web/src/standalone-ui.css matches the canonical copy"; exit 0; fi
echo "DRIFT   web/src/standalone-ui.css differs from $canonical (copy the canonical file; never edit the vendored one)"
exit 1
