----
description: When self-hosted TURN is enabled, browsers/mobile need short-lived TURN credentials they can't be handed statically. Provide a tiny signing endpoint that issues coturn ephemeral (use-auth-secret / REST API) credentials and have the ICE-config manifest advertise the TURN entry only when issuance is available.
prereq: turn-ssrf-peer-deny-hardening
files: ops/docker/coturn/turnserver.conf, ops/docs/ice-servers.md, packages/reference-app-web/src/lib/ice-config.ts
----

## Problem

`webrtc-stun-turn-infrastructure` configures coturn for TURN with `use-auth-secret` + `static-auth-secret`, but ships with `TURN_ENABLED=false` and STUN-only. Turning TURN on for browsers requires **ephemeral, time-limited credentials** — the shared secret must never reach the client. coturn's REST-API scheme expects `username = <unixExpiry>:<id>`, `credential = base64(HMAC-SHA1(secret, username))`.

## Requirements / specifications

- A minimal credential-issuance endpoint (could live in `ops/` as a tiny service, or be folded into an existing operator-hosted surface) that, given an authenticated/authorized request, returns a freshly-signed `{ username, credential, ttl }` and the TURN URL(s).
- **Abuse controls:** rate-limit issuance per client/identity; short TTL (minutes, not hours); no anonymous unbounded issuance. Mirrors the relay-abuse posture in `4-relay-bootstrap-infrastructure`.
- The runtime ICE-config manifest (`loadIceConfig()` / `ice-servers.json`) advertises a TURN entry **only** when issuance is wired and `turnPolicy` is `gated`/`on`; STUN-first remains the default and TURN stays last-resort.
- Treat TURN as truly last-resort per the parent ticket's policy; coordinate with `turn-relayed-path-metrics` so any TURN-relayed path is observable.

## Use cases

- A symmetric-NAT pair that genuinely cannot hole-punch obtains short-lived TURN credentials, relays as a last resort, and the credentials expire shortly after.

## References

- `tickets/implement/2-webrtc-stun-turn-infrastructure.md` (coturn `use-auth-secret` config, manifest schema, `loadIceConfig()`).
- coturn `turn_rest_api` / `use-auth-secret` docs.
- `tickets/backlog/4-relay-bootstrap-infrastructure.md` (abuse-prevention posture).
