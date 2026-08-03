----
description: The TURN credential server hands out relay passwords to anyone who passes a simple shared-token/rate-limit check. Strengthen it so credentials are tied to a known Sereus node — a client proves it owns its peer identity before getting relay access — so abuse can be traced and revoked per-peer.
prereq: turn-credential-issuance-service
files: ops/docker/turn-credential-issuer/src/main.ts, packages/reference-app-web/src/lib/ice-config.ts, packages/reference-app-rn/src/ice-config.ts
----

## Problem

`turn-credential-issuance-service` gates TURN-credential issuance with a layered
default — per-IP rate limit (always), short TTL (always), an optional shared
bearer token, and coturn server-side quotas as the hard backstop. That bounds
abuse but does **not** bind a credential to a *known* identity: a shared token in a
browser bundle is effectively public, and IP-based limits are coarse (NAT, proxies,
mobile carriers). There is no per-peer attribution or revocation.

Sereus nodes already hold a libp2p Ed25519 peer key. A stronger model: the client
**proves possession of its peer key** (signs an issuer-provided challenge / a
short-lived nonce) before the issuer mints a TURN credential, and the issuer can
encode the peer id into the coturn `<id>` label so relayed usage is attributable
and a misbehaving peer can be denied.

## Why this is separate

This crosses out of `ops/` into the app packages: the web/RN clients must expose a
signing capability over their node key and run a challenge round-trip, and
`loadIceConfig()` (today a pure fetch-and-validate) would need an auth/handshake
step. That is a meaningfully larger surface than the ops-only issuer, and the
issuer ships a defensible bounded-abuse posture without it — so it was deliberately
deferred rather than bundled.

## Requirements / specifications

- A challenge/response: issuer issues a nonce; client signs it with its libp2p
  private key; issuer verifies against the presented peer id (and, optionally, an
  operator allow-list / trust-circle membership) before minting.
- Encode the (verified) peer id into the coturn credential `<id>` label so TURN
  server logs attribute relayed bytes to a peer; support per-peer deny.
- Preserve the existing fallbacks: unauthenticated/legacy clients still get the
  rate-limited path if the operator allows it; STUN-only remains the safe default.
- Coordinate with the trust-circle / `cadre-host` identity model rather than
  inventing a parallel auth scheme.

## References

- `tickets/implement/turn-credential-issuance-service.md` (the issuer this hardens).
- `docs/cadre-host.md` (trust-circle / node identity), `ops/docs/keys.md`.
- libp2p peer-id signing (Ed25519 node key already minted by `ops/docker/libp2p-infra`).
