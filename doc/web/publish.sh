#!/usr/bin/env bash
set -euo pipefail

# Publish the Sereus static site via rsync/scp
# Usage:
#   ./publish.sh [USER@HOST] [DEST_PATH]
#   or set USER environment variable:
#   USER=myuser ./publish.sh [HOST] [DEST_PATH]
# Defaults:
#   USER: current user or USER env var
#   HOST: gotchoices.org
#   DEST_PATH: /var/www/sereus.org

# Parse user@host or just host
HOST_ARG="${1:-gotchoices.org}"
if [[ "$HOST_ARG" == *"@"* ]]; then
  # User@host format provided
  REMOTE="$HOST_ARG"
else
  # Just host provided, use USER env var or current user
#  USER="${USER:-$(whoami)}"
  USER="root"
  REMOTE="${USER}@${HOST_ARG}"
fi

DEST="${2:-/var/www/sereus.org}"

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure web images exist (copy logo if needed)
mkdir -p "$ROOT_DIR/images"
if [ ! -f "$ROOT_DIR/images/logo2.png" ]; then
  if [ -f "$ROOT_DIR/../images/logo2.png" ]; then
    cp "$ROOT_DIR/../images/logo2.png" "$ROOT_DIR/images/logo2.png"
  fi
fi

echo "Publishing to ${REMOTE}:${DEST} ..."
ssh "$REMOTE" "mkdir -p '$DEST'"

EXCLUDES=(
  "--exclude" "example/"
  "--exclude" "server.sh"
  "--exclude" "publish.sh"
  "--exclude" "STATUS.md"
  "--exclude" "README.md"
)

if command -v rsync >/dev/null 2>&1; then
  rsync -avz --delete "${EXCLUDES[@]}" "$ROOT_DIR/" "$REMOTE:$DEST/"
else
  # Fallback to scp (no delete/exclude support)
  echo "rsync not found; using scp (excludes ignored). Consider installing rsync."
  scp -r "$ROOT_DIR"/* "$REMOTE:$DEST/"
fi

# Extract hostname for URL (strip username if present)
HOST_ONLY="${REMOTE##*@}"
echo "Publish complete: https://${HOST_ONLY}/"


