#!/usr/bin/env bash
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="$(basename "$SITE_DIR")"
OPS_DIR="$(cd "$SITE_DIR/.." && pwd)"

default_repo_dir="$OPS_DIR/repo"
if [[ ! -d "$default_repo_dir" && -d "$OPS_DIR/sereus" ]]; then
  default_repo_dir="$OPS_DIR/sereus"
fi

REPO_DIR="${SEREUS_REPO_DIR:-"$default_repo_dir"}"

default_compose=""
if [[ -f "$REPO_DIR/ops/docker/$SERVICE_NAME/docker-compose.yml" ]]; then
  default_compose="$REPO_DIR/ops/docker/$SERVICE_NAME/docker-compose.yml"
elif [[ -f "$REPO_DIR/sereus/ops/docker/$SERVICE_NAME/docker-compose.yml" ]]; then
  default_compose="$REPO_DIR/sereus/ops/docker/$SERVICE_NAME/docker-compose.yml"
else
  default_compose="$REPO_DIR/ops/docker/$SERVICE_NAME/docker-compose.yml"
fi

COMPOSE_FILE="${SEREUS_COMPOSE_FILE:-"$default_compose"}"
ENV_FILE="${SEREUS_ENV_FILE:-"$SITE_DIR/env.local"}"

exec docker compose \
  --project-directory "$SITE_DIR" \
  -f "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  logs -f


