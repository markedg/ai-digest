#!/bin/bash
# Daily wrapper: fetches the digest, scores it, renders HTML, publishes to Pages.
# Called by launchd each morning. Logs go to output/launchd.{out,err}.log.

set -euo pipefail
cd "$(dirname "$0")"

# Ensure node, claude, and git are reachable when run by launchd (clean env).
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

echo "=== Daily digest run started: $(date '+%Y-%m-%d %H:%M:%S %Z') ==="

mkdir -p output
node digest.js
./deploy.sh

echo "=== Daily digest run finished: $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
