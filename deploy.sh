#!/bin/bash
# Commit and push the latest docs/ output to GitHub Pages.
# Called by run-daily.sh after digest.js completes. Safe to run manually too.

set -euo pipefail
cd "$(dirname "$0")"

git add docs/

if git diff --cached --quiet; then
  echo "[deploy] No changes in docs/ — nothing to push."
  exit 0
fi

TODAY=$(date +%Y-%m-%d)
git commit -m "Daily digest $TODAY"
git push origin main
echo "[deploy] Pushed daily digest for $TODAY"
