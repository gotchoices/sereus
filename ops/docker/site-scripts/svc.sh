#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./svc <command> [args...]

Commands:
  up          Bring the service up (build if needed)
  down        Stop and remove the service containers
  logs        Follow logs
  ps          Show containers
  dns [host]  (relay only) Print the DNSADDR TXT records to publish, computed from
              the HOST ports in env.local + the running relay's peer id. `host` is the
              public hostname; defaults to $PUBLIC_HOST from env.local when set.

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

# Read a KEY=VALUE from the env file (ignores comments; last wins). Never fails.
envget() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true
}

# Print the DNSADDR TXT records an operator should publish for this relay.
#
# The relay process, inside its container, only knows the addresses it BOUND
# (container IP + container ports 4001/4002) — not the host-side port mapping. So
# `svc logs` shows internal addresses that must NOT be published. This command
# derives the externally-reachable records instead: the public hostname + the HOST
# ports from env.local (which map to the container ports), + the running peer id.
print_relay_dns() {
  if [[ "$SERVICE_KEY" != "relay" ]]; then
    echo "ERROR: 'dns' is only meaningful for the relay service (this instance is '$SERVICE_KEY')." >&2
    echo "coturn/turn advertise stun:/turn: URLs, not libp2p multiaddrs." >&2
    exit 2
  fi

  local host tcp_port ws_port peer
  host="${1:-$(envget PUBLIC_HOST)}"
  if [[ -z "$host" ]]; then
    echo "ERROR: no public hostname given." >&2
    echo "Pass one:        ./svc dns relay.example.org" >&2
    echo "or set in env:   PUBLIC_HOST=relay.example.org  (in env.local)" >&2
    exit 2
  fi

  tcp_port="$(envget HOST_PORT)";    tcp_port="${tcp_port:-4001}"
  ws_port="$(envget HOST_WS_PORT)";  ws_port="${ws_port:-4011}"

  peer="$(dc logs 2>/dev/null | grep -oE 'peerId=[A-Za-z0-9]+' | tail -1 | cut -d= -f2 || true)"
  if [[ -z "$peer" ]]; then
    echo "ERROR: could not find the relay's peer id in the container logs." >&2
    echo "Start it first (./svc up), let it log its startup line, then retry ./svc dns." >&2
    exit 1
  fi

  cat <<EOF
Publish these TXT records in your DNS zone:

  Host/Name : _dnsaddr.$host   (some DNS UIs want only the relative label, e.g. _dnsaddr.<sub>)
  Type      : TXT

  # TCP — desktop/server peers:
  dnsaddr=/dns4/$host/tcp/$tcp_port/p2p/$peer

  # WebSockets — React Native phones + browsers on http (they cannot dial raw TCP):
  dnsaddr=/dns4/$host/tcp/$ws_port/ws/p2p/$peer

  # wss — browsers on https / WAN. Add ONLY once a TLS reverse proxy fronts the relay,
  # using the port that front terminates on (need not be 443):
  #dnsaddr=/dns4/$host/tcp/<TLS_PORT>/tls/ws/p2p/$peer

Notes:
  - Ports above are the HOST ports from env.local ($tcp_port tcp, $ws_port ws) — what is
    reachable from outside, NOT the container's internal 4001/4002 shown by 'svc logs'.
  - Make sure your firewall has those host ports open.
  - Verify after DNS propagates:
      node <repo>/ops/test/check-node.mjs --target /dns4/$host/tcp/$ws_port/ws/p2p/$peer --relay
EOF
}

# Build the comma-joined announce multiaddrs for the relay from a public host + host ports.
# Announce addresses carry no /p2p suffix — libp2p appends this node's own peer id.
relay_build_announce() {
  echo "/dns4/$1/tcp/$2,/dns4/$1/tcp/$3/ws"
}

case "$cmd" in
  up)
    # For the relay, make sure it advertises addresses clients can reach. Without this it
    # announces the internal addresses libp2p bound (127.0.0.1, the docker bridge IP), which
    # are useless to clients and poison the /p2p-circuit addresses NAT'd clients build.
    if [[ "$SERVICE_KEY" == "relay" ]]; then
      ann="$(envget ANNOUNCE_ADDRS)"
      pub="$(envget PUBLIC_HOST)"
      if [[ -z "$ann" && -n "$pub" ]]; then
        tcp_port="$(envget HOST_PORT)";   tcp_port="${tcp_port:-4001}"
        ws_port="$(envget HOST_WS_PORT)"; ws_port="${ws_port:-4011}"
        export ANNOUNCE_ADDRS="$(relay_build_announce "$pub" "$tcp_port" "$ws_port")"
        echo "relay: advertising $ANNOUNCE_ADDRS (auto-derived from PUBLIC_HOST=$pub)"
      elif [[ -z "$ann" && -z "$pub" ]]; then
        echo "WARNING: relay has neither PUBLIC_HOST nor ANNOUNCE_ADDRS set in env.local." >&2
        echo "         It will advertise container-internal addresses (127.0.0.1 / docker" >&2
        echo "         bridge IP) that clients cannot use. Set PUBLIC_HOST=<your.dns.name>" >&2
        echo "         in env.local so it advertises a reachable address." >&2
      fi
    fi
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
  dns)
    print_relay_dns "${1:-}"
    ;;
  *)
    echo "ERROR: unknown command: $cmd" >&2
    usage
    exit 2
    ;;
esac


