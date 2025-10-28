#!/usr/bin/env bash
set -euo pipefail

# Publish the Sereus static site via rsync/scp
# Usage:
#   ./publish.sh [HOST] [DEST_PATH]
# Defaults:
#   HOST: sereus.org
#   DEST_PATH: /var/www/sereus

HOST="${1:-sereus.org}"
DEST="${2:-/var/www/sereus}"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure web images exist (copy logo if needed)
mkdir -p "$ROOT_DIR/images"
if [ ! -f "$ROOT_DIR/images/logo2.png" ]; then
  if [ -f "$ROOT_DIR/../images/logo2.png" ]; then
    cp "$ROOT_DIR/../images/logo2.png" "$ROOT_DIR/images/logo2.png"
  fi
fi

echo "Publishing to ${HOST}:${DEST} ..."
ssh "$HOST" "mkdir -p '$DEST'"

EXCLUDES=(
  "--exclude" "example/"
  "--exclude" "server.sh"
  "--exclude" "publish.sh"
  "--exclude" "STATUS.md"
)

if command -v rsync >/dev/null 2>&1; then
  rsync -avz --delete "${EXCLUDES[@]}" "$ROOT_DIR/" "$HOST:$DEST/"
else
  # Fallback to scp (no delete/exclude support)
  echo "rsync not found; using scp (excludes ignored). Consider installing rsync."
  scp -r "$ROOT_DIR"/* "$HOST:$DEST/"
fi

echo "Publish complete: https://${HOST}/"


