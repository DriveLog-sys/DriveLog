#!/usr/bin/env bash
# ============================================================
# DRIVELOG — BUILD SCRIPT
# ------------------------------------------------------------
# Run this EVERY time you edit app.js, db.js, data.js, or
# main.css, BEFORE pushing to GitHub. It:
#   1. Re-minifies all JS and CSS with esbuild (a real
#      AST-based minifier — safe for URLs inside strings,
#      never reorders CSS rules or breaks @media blocks)
#   2. Verifies the minified JS is valid syntax
#   3. Bumps the ?v= cache-busting version in index.html so
#      browsers fetch the new files (the .min files are cached
#      for 1 year by vercel.json — the version bump is what
#      forces the refresh)
#
# Requirements: Node.js installed (esbuild is fetched
# automatically by npx on first run).
#
# Usage:  bash build.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Minifying JS..."
npx --yes esbuild app.js  --minify --charset=utf8 --outfile=app.min.js
npx --yes esbuild db.js   --minify --charset=utf8 --outfile=db.min.js
npx --yes esbuild data.js --minify --charset=utf8 --outfile=data.min.js

echo "→ Minifying CSS..."
npx --yes esbuild main.css --minify --charset=utf8 --outfile=main.min.css

echo "→ Checking minified JS syntax..."
node --check app.min.js
node --check db.min.js
node --check data.min.js

VERSION=$(date +%Y%m%d%H%M)
echo "→ Bumping cache-bust version to $VERSION ..."
# Replaces every ?v=<digits> on local .min.js / .min.css references
sed -i.bak -E "s/(\.min\.(js|css)\?v=)[0-9]+/\1$VERSION/g" index.html
rm -f index.html.bak

echo "✔ Build complete."
echo "  app.min.js  : $(wc -c < app.min.js) bytes"
echo "  db.min.js   : $(wc -c < db.min.js) bytes"
echo "  data.min.js : $(wc -c < data.min.js) bytes"
echo "  main.min.css: $(wc -c < main.min.css) bytes"
echo "  index.html now points at ?v=$VERSION"
echo
echo "Now commit and push everything, including the .min files."
