#!/bin/sh
set -e

# Sereus Cadre Node Entrypoint Script
# Handles enrollment, configuration generation, and node startup

DATA_DIR="${DATA_DIR:-/data}"
CADRE_CONFIG_FILE="${CADRE_CONFIG_FILE:-$DATA_DIR/cadre.yaml}"
CADRE_KEY_FILE="${CADRE_KEY_FILE:-$DATA_DIR/cadre-peer.key}"

log() {
  echo "[entrypoint] $1"
}

error() {
  echo "[entrypoint] ERROR: $1" >&2
  exit 1
}

# Generate configuration file from environment variables if it doesn't exist
generate_config() {
  log "Generating configuration from environment variables..."
  
  # Validate required variables
  if [ -z "$CADRE_PARTY_ID" ]; then
    error "CADRE_PARTY_ID is required"
  fi
  if [ -z "$CADRE_BOOTSTRAP_NODES" ]; then
    error "CADRE_BOOTSTRAP_NODES is required"
  fi

  # Create YAML configuration
  cat > "$CADRE_CONFIG_FILE" << EOF
# Auto-generated cadre configuration
# Generated at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

controlNetwork:
  partyId: "${CADRE_PARTY_ID}"
  bootstrapNodes:
$(echo "$CADRE_BOOTSTRAP_NODES" | tr ',' '\n' | while read -r node; do
  [ -n "$node" ] && echo "    - \"$node\""
done)

profile: ${CADRE_PROFILE:-storage}

storage:
  type: ${CADRE_STORAGE_TYPE:-file}
  path: ${CADRE_STORAGE_PATH:-/data/storage}
EOF

  # Add quota if specified
  if [ -n "$CADRE_STORAGE_QUOTA" ]; then
    echo "  quotaBytes: $CADRE_STORAGE_QUOTA" >> "$CADRE_CONFIG_FILE"
  fi

  # Add network configuration
  cat >> "$CADRE_CONFIG_FILE" << EOF

network:
EOF

  if [ -n "$CADRE_LISTEN_ADDRS" ]; then
    echo "  listenAddrs:" >> "$CADRE_CONFIG_FILE"
    echo "$CADRE_LISTEN_ADDRS" | tr ',' '\n' | while read -r addr; do
      [ -n "$addr" ] && echo "    - \"$addr\"" >> "$CADRE_CONFIG_FILE"
    done
  fi

  if [ -n "$CADRE_ANNOUNCE_ADDRS" ]; then
    echo "  announceAddrs:" >> "$CADRE_CONFIG_FILE"
    echo "$CADRE_ANNOUNCE_ADDRS" | tr ',' '\n' | while read -r addr; do
      [ -n "$addr" ] && echo "    - \"$addr\"" >> "$CADRE_CONFIG_FILE"
    done
  fi

  if [ -n "$CADRE_RELAY_ADDRS" ]; then
    echo "  relayAddrs:" >> "$CADRE_CONFIG_FILE"
    echo "$CADRE_RELAY_ADDRS" | tr ',' '\n' | while read -r addr; do
      [ -n "$addr" ] && echo "    - \"$addr\"" >> "$CADRE_CONFIG_FILE"
    done
  fi

  # Add hibernation configuration
  cat >> "$CADRE_CONFIG_FILE" << EOF

hibernation:
  enabled: ${CADRE_HIBERNATION_ENABLED:-true}
  defaultLatencyHint: ${CADRE_LATENCY_HINT:-interactive}

strandWatchInterval: ${CADRE_STRAND_WATCH_INTERVAL:-5000}
EOF

  # Add strand filter if specified.
  # Accepts bare `all`/`none`, or a JSON object for the sApp/strand forms, e.g.
  # CADRE_STRAND_FILTER='{"sAppId":"myapp"}' or '{"strandId":"<id>"}'. JSON
  # object syntax is valid YAML flow, so the verbatim write below stays
  # parseable. The env override is the authoritative source at startup (the CLI
  # re-applies CADRE_STRAND_FILTER over the loaded config), so this write only
  # mirrors the effective config into the file for debugging.
  if [ -n "$CADRE_STRAND_FILTER" ]; then
    echo "" >> "$CADRE_CONFIG_FILE"
    echo "strandFilter: $CADRE_STRAND_FILTER" >> "$CADRE_CONFIG_FILE"
  fi

  # Add identity section if key file exists or is specified
  if [ -f "$CADRE_KEY_FILE" ]; then
    cat >> "$CADRE_CONFIG_FILE" << EOF

identity:
  keyFile: $CADRE_KEY_FILE
EOF
  fi

  log "Configuration written to $CADRE_CONFIG_FILE"
}

# Create peer identity if it doesn't exist
create_identity() {
  if [ ! -f "$CADRE_KEY_FILE" ]; then
    log "Creating new peer identity..."
    node /app/packages/cadre-cli/dist/bin/cadre.js enroll create \
      --output "$(dirname "$CADRE_KEY_FILE")" \
      --name "$(basename "$CADRE_KEY_FILE" .key)"
    log "Peer identity created at $CADRE_KEY_FILE"
  else
    log "Using existing peer identity from $CADRE_KEY_FILE"
  fi
}

# Ensure data directories exist
mkdir -p "$DATA_DIR"
mkdir -p "${CADRE_STORAGE_PATH:-$DATA_DIR/storage}"

# Generate config if it doesn't exist
if [ ! -f "$CADRE_CONFIG_FILE" ]; then
  generate_config
fi

# Create identity if needed
create_identity

# Handle commands
case "$1" in
  start)
    log "Starting cadre node..."
    exec node /app/packages/cadre-cli/dist/bin/cadre.js start \
      -c "$CADRE_CONFIG_FILE" \
      ${CADRE_DEBUG:+--debug}
    ;;
  status)
    exec node /app/packages/cadre-cli/dist/bin/cadre.js status \
      -c "$CADRE_CONFIG_FILE"
    ;;
  strands)
    exec node /app/packages/cadre-cli/dist/bin/cadre.js strands \
      -c "$CADRE_CONFIG_FILE"
    ;;
  shell)
    exec /bin/sh
    ;;
  *)
    # Pass through to node
    exec node /app/packages/cadre-cli/dist/bin/cadre.js "$@"
    ;;
esac

