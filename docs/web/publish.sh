#!/usr/bin/env bash
set -euo pipefail

# Publish the Sereus static site via rsync
# Usage:
#   ./publish.sh [--yes] [USER@HOST] [DEST_PATH]
# Defaults:
#   USER: root (unless USER@HOST is given)
#   HOST: gotchoices.org
#   DEST_PATH: /var/www/sereus.org
#
# The docroot is SHARED.  Other repos publish into it, and this script must never
# delete their content:
#   chat/          chat/site/publish.sh         (Sereus Chat)
#   health/        health/web/publish.sh        (Sereus Health)
#   taleus/        taleus/web/publish.sh        (Taleus; preview/ inside it too)
#   .well-known/   app-link files merged by each app's publish.sh,
#                  plus .well-known/stroc/ from taleus/contracts/publish.sh
#   ipfs/          taleus/contracts/publish.sh  (published contract documents)
#   join/          reserved: node-code landing page (https://sereus.org/join#sereus-join:…)
#   bonum/ erp/    reserved for those apps' future pages
# A new app that publishes under sereus.org must be added to PROTECTED below.
#
# Before syncing, the script does a dry run and lists anything --delete would remove,
# then asks for confirmation.  --yes skips the question (the list is still shown).

ASSUME_YES=0
if [[ "${1:-}" == "--yes" ]]; then
  ASSUME_YES=1
  shift
fi

# Parse user@host or just host
HOST_ARG="${1:-gotchoices.org}"
if [[ "$HOST_ARG" == *"@"* ]]; then
  REMOTE="$HOST_ARG"
else
  REMOTE="root@${HOST_ARG}"
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

# Paths at the docroot owned by other publishers.  Anchored with a leading slash
# so they match only at the top level.  Excluded paths are neither sent nor deleted.
PROTECTED=(
  "/chat/"
  "/health/"
  "/taleus/"
  "/bonum/"
  "/erp/"
  "/join/"
  "/ipfs/"
  "/.well-known/"
)

EXCLUDES=(
  "--exclude" "example/"
  "--exclude" "server.sh"
  "--exclude" "publish.sh"
  "--exclude" "STATUS.md"
  "--exclude" "README.md"
  "--exclude" ".DS_Store"
)
for p in "${PROTECTED[@]}"; do
  EXCLUDES+=("--exclude" "$p")
done

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required (the publish must not clobber other apps' content)." >&2
  exit 1
fi

echo "Checking ${REMOTE}:${DEST} ..."
ssh "$REMOTE" "mkdir -p '$DEST'"

# Dry run: show what --delete would remove before doing anything.
DELETIONS="$(rsync -avzn --delete "${EXCLUDES[@]}" "$ROOT_DIR/" "$REMOTE:$DEST/" | grep -i 'delet' || true)"
if [ -n "$DELETIONS" ]; then
  echo
  echo "This publish would DELETE these paths on the server:"
  echo "$DELETIONS" | sed 's/^/  /'
  echo
  echo "If any of them belong to another app, stop and add them to PROTECTED in publish.sh."
  if [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "Continue? [y/N] " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Aborted; nothing was changed."; exit 1 ;;
    esac
  fi
fi

echo "Publishing to ${REMOTE}:${DEST} ..."
rsync -avz --delete "${EXCLUDES[@]}" "$ROOT_DIR/" "$REMOTE:$DEST/"

# Extract hostname for URL (strip username if present)
HOST_ONLY="${REMOTE##*@}"
echo "Publish complete: https://${HOST_ONLY}/"
