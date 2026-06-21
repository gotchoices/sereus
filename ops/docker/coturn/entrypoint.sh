#!/usr/bin/env bash
#
# Sereus coturn entrypoint.
#
# Renders ./turnserver.conf (the template, mounted at /opt/sereus/turnserver.conf)
# into an active config, then EXECs `turnserver -c <active>`. The active config is
# the STUN-always-on baseline plus three conditional blocks:
#
#   EXTERNAL_IP set            -> append `external-ip=<ip>`   (1:1 NAT / cloud)
#   TURN_ENABLED=true          -> append the TURN auth + relay block
#   TLS_CERT and TLS_KEY set   -> append the TLS block (tls-listening-port=5349)
#
# STUN-only is the default: with no TURN block there is no credential mechanism,
# so TURN Allocate requests are refused while STUN Binding requests still answer.
#
# Set COTURN_RENDER_ONLY=1 to print the rendered active config to stdout and exit
# (used by tests / for eyeballing the effective config without starting coturn).

set -euo pipefail

TEMPLATE="${COTURN_TEMPLATE:-/opt/sereus/turnserver.conf}"
ACTIVE="${COTURN_ACTIVE_CONF:-/data/turnserver.active.conf}"

# --- Defaults (keep in sync with env.example) ------------------------------
LISTENING_PORT="${LISTENING_PORT:-3478}"
HOST_BIND_IP="${HOST_BIND_IP:-0.0.0.0}"
STUN_PUBLIC_HOST="${STUN_PUBLIC_HOST:-}"
EXTERNAL_IP="${EXTERNAL_IP:-}"
TURN_ENABLED="${TURN_ENABLED:-false}"
TURN_SECRET="${TURN_SECRET:-}"
TURN_REALM="${TURN_REALM:-}"
TLS_CERT="${TLS_CERT:-}"
TLS_KEY="${TLS_KEY:-}"
TLS_LISTENING_PORT="${TLS_LISTENING_PORT:-5349}"
MIN_RELAY_PORT="${MIN_RELAY_PORT:-49160}"
MAX_RELAY_PORT="${MAX_RELAY_PORT:-49200}"
TOTAL_QUOTA="${TOTAL_QUOTA:-0}"
USER_QUOTA="${USER_QUOTA:-0}"
MAX_BPS="${MAX_BPS:-0}"

# Realm defaults to the public hostname (or a static fallback) so plain-STUN
# deployments still render a valid config.
REALM="${TURN_REALM:-${STUN_PUBLIC_HOST:-sereus}}"

log() { echo "[sereus-coturn] $*" >&2; }

# Portable ${VAR} substitution for the handful of template placeholders. We avoid
# `envsubst` (not guaranteed in the coturn image) and `eval` (unsafe with config
# values). Only the known placeholders below are substituted.
render_template() {
	local content
	content="$(cat "$TEMPLATE")"
	content="${content//\$\{LISTENING_PORT\}/$LISTENING_PORT}"
	content="${content//\$\{HOST_BIND_IP\}/$HOST_BIND_IP}"
	content="${content//\$\{REALM\}/$REALM}"
	printf '%s\n' "$content"
}

build_active_conf() {
	mkdir -p "$(dirname "$ACTIVE")"

	{
		render_template

		if [[ -n "$EXTERNAL_IP" ]]; then
			echo ""
			echo "# Public address reported in STUN/relay responses (1:1 NAT / cloud)."
			echo "external-ip=$EXTERNAL_IP"
		fi

		if [[ "$TURN_ENABLED" == "true" ]]; then
			if [[ -z "$TURN_SECRET" ]]; then
				log "ERROR: TURN_ENABLED=true but TURN_SECRET is empty. Refusing to start an"
				log "       auth-less (open) TURN relay. Set TURN_SECRET or TURN_ENABLED=false."
				exit 1
			fi
			echo ""
			echo "# --- TURN (relay) — ENABLED -------------------------------------------"
			echo "# Ephemeral (time-limited HMAC) credentials only; never static user/pass."
			echo "# The turn-credential-issuer service (ops/docker/turn-credential-issuer/)"
			echo "# mints the username/credential pairs using this same static-auth-secret."
			echo "use-auth-secret"
			echo "static-auth-secret=$TURN_SECRET"
			echo "min-port=$MIN_RELAY_PORT"
			echo "max-port=$MAX_RELAY_PORT"
			echo "total-quota=$TOTAL_QUOTA"
			echo "user-quota=$USER_QUOTA"
			echo "max-bps=$MAX_BPS"
		else
			echo ""
			echo "# TURN relay DISABLED (TURN_ENABLED=false): no credential mechanism is"
			echo "# configured, so TURN Allocate requests are refused. STUN Binding still works."
		fi

		if [[ -n "$TLS_CERT" && -n "$TLS_KEY" ]]; then
			echo ""
			echo "# --- TLS / DTLS (optional) --------------------------------------------"
			echo "tls-listening-port=$TLS_LISTENING_PORT"
			echo "cert=$TLS_CERT"
			echo "pkey=$TLS_KEY"
		else
			echo ""
			echo "# TLS disabled (no TLS_CERT/TLS_KEY). Browsers accept plain stun: so this"
			echo "# is fine for STUN; provide certs to also offer stuns:/turns: on ${TLS_LISTENING_PORT}."
			echo "no-tls"
			echo "no-dtls"
		fi
	} > "$ACTIVE"
}

main() {
	[[ -f "$TEMPLATE" ]] || { log "ERROR: template not found: $TEMPLATE"; exit 1; }
	build_active_conf

	if [[ "${COTURN_RENDER_ONLY:-0}" == "1" ]]; then
		cat "$ACTIVE"
		exit 0
	fi

	log "starting coturn (TURN_ENABLED=$TURN_ENABLED, TLS=$([[ -n "$TLS_CERT" && -n "$TLS_KEY" ]] && echo on || echo off), listening-port=$LISTENING_PORT)"
	exec turnserver -c "$ACTIVE" "$@"
}

main "$@"
