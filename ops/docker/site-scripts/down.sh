#!/usr/bin/env bash
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="$(basename "$SITE_DIR")"
OPS_DIR="$(cd "$SITE_DIR/.." && pwd)"

REPO_DIR="${SEREUS_REPO_DIR:-"$OPS_DIR/repo"}"
COMPOSE_FILE="${SEREUS_COMPOSE_FILE:-"$REPO_DIR/sereus/ops/docker/$SERVICE_NAME/docker-compose.yml"}"
ENV_FILE="${SEREUS_ENV_FILE:-"$SITE_DIR/env.local"}"

exec docker compose \
  --project-directory "$SITE_DIR" \
  -f "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  down


