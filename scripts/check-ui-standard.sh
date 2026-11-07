#!/bin/bash
# Checks that the vendored stylesheet is byte-identical to the family's canonical standalone-ui.css, and has not been
# hand-edited since it was vendored.
#
# Canonical copy, first match wins: STANDALONE_UI_CANONICAL (a path), then
# $HOME/Development/AI-DEMO-Standalone/shared/standalone-ui.css, then (CI, or any machine without the meta repo) a fresh
# download of shared/standalone-ui.css from the meta repo's main on GitHub (STANDALONE_UI_CANONICAL_URL overrides the URL,
# STANDALONE_UI_NO_FETCH=1 turns the download off). A stale copy (canonical moved on) FAILS. If the download itself fails
# (offline, GitHub down) the script says so and falls back to the pinned hash alone, so an outage never turns CI red.
# scripts/standalone-ui.sha256 is the hash of the copy as vendored: it catches a hand-edited copy.
#
# Fix a DRIFT: copy the canonical file over the vendored one (never edit the vendored copy), then run with --pin.
# Usage: scripts/check-ui-standard.sh [--pin]   (--pin writes the hash after you re-vendor)
set -u
copy_rel="web/src/standalone-ui.css"   # <- the one line that differs per repo: where the vendored copy lives
root="$(cd "$(dirname "$0")/.." && pwd)"
canonical="${STANDALONE_UI_CANONICAL:-$HOME/Development/AI-DEMO-Standalone/shared/standalone-ui.css}"
canonical_url="${STANDALONE_UI_CANONICAL_URL:-https://raw.githubusercontent.com/curtismu7/AI-DEMO-Standalone/main/shared/standalone-ui.css}"
copy="$root/$copy_rel"
pin="$root/scripts/standalone-ui.sha256"
hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
tmp=""
cleanup() { [ -n "$tmp" ] && rm -f "$tmp"; }
trap cleanup EXIT
if [ ! -f "$copy" ]; then echo "MISSING $copy_rel"; exit 1; fi

source_note="$canonical"
if [ ! -f "$canonical" ] && [ "${STANDALONE_UI_NO_FETCH:-}" != "1" ]; then
  tmp="$(mktemp)"
  fetched=0
  for attempt in 1 2 3; do
    # a real stylesheet defines the theme tokens on :root; anything else (an HTML error page) is not the canonical file
    if curl -fsSL --max-time 15 -o "$tmp" "$canonical_url" 2>/dev/null && [ -s "$tmp" ] && grep -q ':root' "$tmp"; then fetched=1; break; fi
    sleep 2
  done
  if [ "$fetched" = "1" ]; then canonical="$tmp"; source_note="downloaded from $canonical_url"
  else echo "skip    could not download the canonical stylesheet from $canonical_url; checking the pinned hash only"; fi
fi

if [ "${1:-}" = "--pin" ]; then
  if [ -f "$canonical" ] && ! cmp -s "$canonical" "$copy"; then echo "DRIFT   re-vendor first: $copy_rel differs from the canonical copy ($source_note)"; exit 1; fi
  hash "$copy" > "$pin"; echo "pinned  $(cat "$pin")"; exit 0
fi

status=0
if [ -f "$canonical" ]; then
  if cmp -s "$canonical" "$copy"; then echo "OK      $copy_rel matches the canonical copy ($source_note)"
  else echo "DRIFT   $copy_rel differs from the canonical copy ($source_note): copy the canonical file over it, then run scripts/check-ui-standard.sh --pin"; status=1; fi
else
  echo "skip    canonical standalone-ui.css not available (set STANDALONE_UI_CANONICAL); drift against canonical not checked"
fi
if [ -f "$pin" ]; then
  if [ "$(hash "$copy")" = "$(cat "$pin")" ]; then echo "OK      matches the pinned hash"
  else echo "DRIFT   $copy_rel differs from scripts/standalone-ui.sha256 (edited copy, or re-vendored without --pin)"; status=1; fi
else
  echo "MISSING scripts/standalone-ui.sha256 (run scripts/check-ui-standard.sh --pin)"; status=1
fi
exit $status
