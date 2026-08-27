#!/usr/bin/env bash
# Build the Chrome Web Store zip. Dev-only content (preview harness, test
# suites, docs, tooling configs) never ships to the store package.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(node -e "console.log(require('$root/manifest.json').version)")"
out_dir="$root/dist"
out="$out_dir/chess-hint-assistant-v${version}.zip"

mkdir -p "$out_dir"
rm -f "$out"

# Files that belong to the store package only:
#   manifest.json, background.js, content.js, engine/, sidepanel/, icons/
cd "$root"
zip -r -q "$out" \
  manifest.json background.js content.js engine sidepanel icons \
  -x '*.md' 'engine/eco.json.orig' '*/.*'

echo "Packaged: $out ($(du -h "$out" | cut -f1))"
unzip -l "$out" | tail -1
