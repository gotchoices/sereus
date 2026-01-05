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

resolve_script_path() {
  # `svc` is usually a symlink in the instance directory pointing at the repo copy.
  # Prefer resolving one hop so we can infer repo location regardless of where the
  # instance directory lives.
  local self="$0"
  if [[ -L "$self" ]]; then
    local target
    target="$(readlink "$self" 2>/dev/null || true)"
    if [[ -n "$target" ]]; then
      if [[ "$target" = /* ]]; then
        echo "$target"
      else
        echo "$(cd "$(dirname "$self")" && cd "$(dirname "$target")" && pwd)/$(basename "$target")"
      fi
      return 0
    fi
  fi
  echo "$self"
}

script_path="$(resolve_script_path)"
default_repo_dir="$(cd "$(dirname "$script_path")/../../.." && pwd)"

# If the user doesn't override repo location, infer it from the repo-resident svc script path.
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
  echo "Guessed REPO_DIR: $REPO_DIR" >&2
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


