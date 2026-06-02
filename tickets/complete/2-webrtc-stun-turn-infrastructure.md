----
description: Self-hosted STUN (coturn) deployed from ops/, a runtime ICE-config JSON manifest (RTCIceServer[] shape), and a framework-free browser helper loadIceConfig() that the web WebRTC transport (ticket 3) will consume. STUN-on by default; TURN fully configured but gated OFF.
files: ops/docker/coturn/docker-compose.yml, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/turnserver.conf, ops/docker/coturn/env.example, ops/docker/coturn/ice-servers.example.json, ops/docker/coturn/README.md, ops/docker/quickstarts/coturn.md, ops/docker/README.md, ops/docs/ice-servers.md, ops/docs/README.md, ops/scripts/install, ops/test/check-stun.mjs, ops/test/package.json, ops/test/README.md, packages/reference-app-web/src/lib/ice-config.ts
----

## Summary

Shipped two deliverables for downstream `web-webrtc-transport-to-bypass-relay` (ticket 3):

1. **Self-hosted STUN (coturn)** under `ops/docker/coturn/` — pulls the upstream
   `coturn/coturn:4.6` image (no local build context). `entrypoint.sh` renders the
   `turnserver.conf` template into `/data/turnserver.active.conf`, conditionally
   appending an `external-ip` line, the TURN auth+relay block (only when
   `TURN_ENABLED=true`), and the TLS block (only when `TLS_CERT`/`TLS_KEY` set).
   STUN is the only on-by-default listener; the entrypoint refuses to start an
   auth-less open relay (`TURN_ENABLED=true` + empty `TURN_SECRET` → exit 1).
2. **Runtime ICE-config discovery** — `ice-servers.example.json` (W3C
   `RTCIceServer[]` shape) plus `packages/reference-app-web/src/lib/ice-config.ts`,
   a framework-free `loadIceConfig()` that resolves a manifest URL
   (explicit → `VITE_ICE_CONFIG_URL` → `localStorage['ice-config-url']`), fetches,
   validates, and returns `RTCIceServer[]` — returning `[]` on any failure and
   never falling back to a third-party STUN (privacy-preserving default).

TURN is fully written but gated OFF; STUN-only is the shipped behavior.

## Review findings

### What was checked

- **Read the full implement diff** (commit `9ac97a7`) with fresh eyes before the
  handoff: `entrypoint.sh`, `turnserver.conf`, `docker-compose.yml`, `env.example`,
  `ice-config.ts`, `check-stun.mjs`, the `install`/`svc.sh` scaffold path, and all
  docs.
- **Config rendering — all 3 documented cases, re-run green:**
  - STUN-only render: `listening-port`/`listening-ip`/`realm` substituted, no
    `use-auth-secret`/`min-port`, `no-tls`/`no-dtls` present, "TURN relay DISABLED"
    note. ✓
  - TURN+TLS+EXTERNAL_IP render: `use-auth-secret`, `static-auth-secret`,
    `min-port`/`max-port`, quotas, `external-ip`, `tls-listening-port`/`cert`/`pkey`
    all present. ✓
  - `TURN_ENABLED=true` + empty `TURN_SECRET` → **exit 1** with the open-relay
    refusal message. ✓
- **Type safety / lint:** `yarn workspace @serfab/reference-app-web run typecheck`
  → 0 errors; `... exec svelte-check` → 0 errors / 0 warnings / 0 files-with-problems
  (406 files). There is **no ESLint surface** for this package (no root or
  package-level eslint config, no `lint` script) — `tsc --noEmit` + `svelte-check`
  are the type-safety floor and both pass.
- **Manifest:** `ice-servers.example.json` is valid JSON, round-trips to the
  `IceConfigManifest` shape (`stun:` entry, `turnPolicy:"off"`), and matches the
  compile-checked `exampleIceConfigManifest` fixture in `ice-config.ts`. ✓
- **`loadIceConfig` error/edge paths (read, not just typed):** no-URL → debug log +
  `[]`; network throw, non-OK HTTP, malformed/non-object body, `localStorage`
  throwing (privacy mode), and `fetch` being undefined are all caught → `[]`, never
  throws. URL precedence and the strict-but-lenient per-entry validation match the
  documented contract.
- **`check-stun.mjs`:** STUN Binding request/response parsing is correct —
  magic-cookie + transaction-id verification, XOR vs non-XOR MAPPED-ADDRESS, and
  32-bit attribute padding alignment. `udp4`-only resolution and "IPv6 not decoded"
  are documented limitations. Correctly flagged as **not agent-runnable** (needs a
  live, publicly reachable STUN server) — not run here.
- **Installer/`svc` integration:** `install docker coturn` is accepted; `svc.sh`
  derives `SERVICE_KEY` from `docker-coturn` → `coturn`, resolves the compose path,
  and `up`'s `--build` is harmless for a pull-only image. Bridge networking
  preserves client source IP for *ingress* STUN (DNAT), so STUN reflexive discovery
  works on the default bridge config; the implementer's host-networking guidance is
  correctly scoped to the TURN relay-allocation case.
- **Docs:** every touched doc (`ops/docs/ice-servers.md`, `coturn/README.md`,
  `quickstarts/coturn.md`, `ops/docker/README.md`, `ops/docs/README.md`,
  `ops/test/README.md`) read end-to-end; cross-references resolve and reflect the
  shipped reality (STUN-first/TURN-off policy, ephemeral-credential warning, the
  two TURN forward-pointers).

### Findings

- **MAJOR (filed) — SSRF gap in `denied-peer-ip`: IPv4-mapped IPv6 not denied.**
  `turnserver.conf` claims to deny "every non-public IPv4/IPv6 range," but the set
  omits `::ffff:0:0/96` (e.g. `::ffff:10.0.0.1`). On a dual-stack TURN deployment a
  relayed peer could reach private IPv4 via the mapped range — a known TURN SSRF
  bypass. **Dormant** (STUN never relays; inert while `TURN_ENABLED=false`) but a
  hard prerequisite before enabling TURN. Not fixed inline: the implementer
  correctly flagged that config validity is never checked by the real coturn binary
  in this environment, so a blind unverified `denied-peer-ip` edit risks a
  startup-parse failure. Filed `tickets/backlog/turn-ssrf-peer-deny-hardening.md`
  (add the mapped-range deny + validate the whole set with `turnserver -n` before
  TURN goes on).

- **MINOR (accepted, no change) — compose port conditionality is manual.** TLS
  `5349` and the TURN relay port range are present-but-commented in
  `docker-compose.yml` (Docker Compose has no native conditional `ports`). True
  listener conditionality lives in the entrypoint, so an inert mapping never has a
  listener behind it. Acceptable as shipped; a future move to compose `profiles` is
  optional polish, not a defect.

- **MINOR (accepted, no change) — `bash` dependency in container.** The entrypoint
  uses bash-only constructs and the image is pinned to `coturn/coturn:4.6`
  (debian-based, ships bash). Fine as long as the tag isn't switched to an alpine
  variant; already flagged in the handoff.

- **MINOR (accepted) — `EXTERNAL_IP` added beyond the ticket's env list.** Justified:
  STUN on a 1:1-NAT cloud VM otherwise reports a private reflexive address. Correct
  default posture; documented in `env.example`.

### Empty categories (explicit)

- **No regressions introduced.** All changes are net-new files plus additive edits
  to `ops/scripts/install` (one `case` arm), `ops/test/package.json` (one script),
  and additive doc sections; no existing code paths altered.
- **No correctness bugs found** in `ice-config.ts` or `check-stun.mjs` beyond the
  documented platform limitations.
- **No pre-existing-error file written** — the surfaces this ticket touches
  (typecheck, svelte-check, config render) all pass; nothing unrelated broke.

### Not agent-runnable (deferred to post-deploy / human-CI)

- **Live STUN binding check:** `yarn workspace @serfab/ops-test check-stun -- --host
  stun.sereus.org --port 3478` — requires a deployed, publicly reachable server.
- **Real-coturn config parse:** `turnserver -n -c <active>` — coturn binary not
  present in this environment (folded into the new backlog hardening ticket).
- **`svc` symlink step on Windows:** `ln -s` fails on this host — a platform
  limitation identical for every service, not a coturn regression; works on the
  Linux deploy target.

## Boundary / explicitly NOT done (per ticket)

- Does **not** add `@libp2p/webrtc` or touch `optimystic.ts` transports — ticket 3
  (`web-webrtc-transport-to-bypass-relay`).
- Does **not** build the TURN credential-issuance endpoint — backlog
  `turn-credential-issuance-service`.
- Does **not** fix the `connection-path` classifier treating a TURN-relayed WebRTC
  conn as `direct` — backlog `turn-relayed-path-metrics`.
- TURN SSRF peer-deny hardening — backlog `turn-ssrf-peer-deny-hardening` (filed
  this pass).
