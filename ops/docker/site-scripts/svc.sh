#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./svc <command> [args...]

Commands:
  up        Bring the service up (build if needed)
  down      Stop and remove the service containers
  logs      Follow logs
  ps        Show containers

Environment:
  SEREUS_REPO_DIR       Override repo location (default: ../repo or ../sereus under ops root)
  SEREUS_COMPOSE_FILE   Override compose file path
  SEREUS_ENV_FILE       Override env file path (default: ./env.local)
EOF
}

cmd="${1:-}"
shift || true

if [[ -z "$cmd" || "$cmd" == "-h" || "$cmd" == "--help" ]]; then
  usage
  exit 0
fi

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_NAME="$(basename "$SITE_DIR")"
OPS_DIR="$(cd "$SITE_DIR/.." && pwd)"

SERVICE_KEY="$INSTANCE_NAME"
if [[ "$SERVICE_KEY" == docker-* ]]; then
  SERVICE_KEY="${SERVICE_KEY#docker-}"
fi

default_repo_dir="$OPS_DIR/repo"
if [[ ! -d "$default_repo_dir" && -d "$OPS_DIR/sereus" ]]; then
  default_repo_dir="$OPS_DIR/sereus"
fi

REPO_DIR="${SEREUS_REPO_DIR:-"$default_repo_dir"}"

default_compose=""
if [[ -f "$REPO_DIR/ops/docker/$SERVICE_KEY/docker-compose.yml" ]]; then
  default_compose="$REPO_DIR/ops/docker/$SERVICE_KEY/docker-compose.yml"
elif [[ -f "$REPO_DIR/sereus/ops/docker/$SERVICE_KEY/docker-compose.yml" ]]; then
  default_compose="$REPO_DIR/sereus/ops/docker/$SERVICE_KEY/docker-compose.yml"
else
  default_compose="$REPO_DIR/ops/docker/$SERVICE_KEY/docker-compose.yml"
fi

COMPOSE_FILE="${SEREUS_COMPOSE_FILE:-"$default_compose"}"
ENV_FILE="${SEREUS_ENV_FILE:-"$SITE_DIR/env.local"}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: compose file not found: $COMPOSE_FILE" >&2
  echo "Set SEREUS_REPO_DIR or SEREUS_COMPOSE_FILE to override." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi

mkdir -p "$SITE_DIR/data"

dc() {
  docker compose \
    -f "$COMPOSE_FILE" \
    --env-file "$ENV_FILE" \
    "$@"
}

case "$cmd" in
  up)
    dc up -d --build "$@"
    ;;
  down)
    dc down "$@"
    ;;
  logs)
    dc logs -f "$@"
    ;;
  ps)
    dc ps "$@"
    ;;
  *)
    echo "ERROR: unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac


