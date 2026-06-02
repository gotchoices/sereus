----
description: REVIEW — Self-hosted STUN (coturn) deployed from ops/, a runtime ICE-config JSON manifest (RTCIceServer[] shape), and a framework-free browser helper loadIceConfig() that the web WebRTC transport (ticket 3) will consume. STUN-on by default; TURN fully configured but gated OFF.
prereq:
files: ops/docker/coturn/docker-compose.yml, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/turnserver.conf, ops/docker/coturn/env.example, ops/docker/coturn/ice-servers.example.json, ops/docker/coturn/README.md, ops/docker/quickstarts/coturn.md, ops/docker/README.md, ops/docs/ice-servers.md, ops/docs/README.md, ops/scripts/install, ops/test/check-stun.mjs, ops/test/package.json, ops/test/README.md, packages/reference-app-web/src/lib/ice-config.ts
----

## What was built

Two deliverables, both for downstream `web-webrtc-transport-to-bypass-relay` (ticket 3):

1. **Self-hosted STUN (coturn)** under `ops/docker/coturn/`, parallel to the relay/bootstrap docker surface but pulling the **distinct upstream `coturn/coturn:4.6` image** (no local build context).
2. **Runtime ICE-config discovery** — a JSON manifest (shape = W3C `RTCIceServer[]`) + a framework-free browser helper `loadIceConfig()` that fetches/validates it and returns `iceServers` ready for `webRTC({ rtcConfiguration: { iceServers } })`.

STUN is the only on-by-default listener. TURN is fully written but gated behind `TURN_ENABLED=false`.

### coturn config model (review focus)
`env.local` → `entrypoint.sh` renders the `turnserver.conf` **template** into `/data/turnserver.active.conf`, then conditionally appends three blocks before `exec turnserver -c`:
- `external-ip=` when `EXTERNAL_IP` set,
- the TURN auth + relay block **only** when `TURN_ENABLED=true`,
- the TLS block **only** when `TLS_CERT`/`TLS_KEY` set.

STUN-only is achieved by simply not configuring any credential mechanism: STUN Binding requests answer, TURN Allocate requests are refused. The entrypoint **refuses to start** with `TURN_ENABLED=true` and an empty `TURN_SECRET` (would be an open relay).

Abuse/SSRF controls (in `turnserver.conf`): `fingerprint`, `stale-nonce`, `no-multicast-peers`, `no-loopback-peers`, `no-cli`, and a full `denied-peer-ip` set covering RFC1918 / CGNAT / link-local / TEST-NET / reserved IPv4 + IPv6 ULA/link-local. TURN quotas (`total-quota`, `user-quota`, `max-bps`) live in the gated TURN block.

### Browser helper (`ice-config.ts`)
`loadIceConfig(url?)`: resolves URL (`explicit ?? VITE_ICE_CONFIG_URL ?? localStorage['ice-config-url']`), fetches + validates, returns `RTCIceServer[]`. Returns `[]` on **any** failure (no URL, network, non-OK, malformed). Never throws (logs via `console.warn/debug`). **No third-party fallback** (no Google STUN) — empty is the privacy-preserving default. Validation is strict-but-lenient: top-level needs an `iceServers` array; malformed entries are dropped with a warning, not fatal. Exports `parseIceServers`, `resolveIceConfigUrl`, and a compile-checked `exampleIceConfigManifest` fixture mirroring the JSON.

## How to validate (what the reviewer should run)

Agent/CI-runnable:
- **Config rendering** (no Docker / no coturn binary needed):
  ```bash
  cd ops/docker/coturn
  COTURN_RENDER_ONLY=1 STUN_PUBLIC_HOST=stun.sereus.org \
    COTURN_TEMPLATE=./turnserver.conf COTURN_ACTIVE_CONF=/tmp/a.conf bash ./entrypoint.sh
  # assert: listening-port/listening-ip present; no use-auth-secret/min-port; "TURN relay DISABLED"
  COTURN_RENDER_ONLY=1 TURN_ENABLED=true TURN_SECRET=x TURN_REALM=turn.sereus.org \
    EXTERNAL_IP=203.0.113.10 TLS_CERT=/data/c.pem TLS_KEY=/data/k.pem \
    COTURN_TEMPLATE=./turnserver.conf COTURN_ACTIVE_CONF=/tmp/b.conf bash ./entrypoint.sh
  # assert: use-auth-secret, static-auth-secret, min-port/max-port, external-ip, tls-listening-port present
  COTURN_RENDER_ONLY=1 TURN_ENABLED=true bash ./entrypoint.sh; echo $?   # asserts exit 1 (no secret)
  ```
  All three verified green during implement.
- **Helper typechecks** (the only test surface — `reference-app-web` has no unit runner):
  ```bash
  yarn workspace @serfab/reference-app-web run typecheck         # 0 errors
  yarn workspace @serfab/reference-app-web exec svelte-check     # 0 errors / 0 warnings
  ```
  Both verified green.
- **Manifest shape**: `ice-servers.example.json` is valid JSON; round-trips into the `IceConfigManifest` shape (the `stun:` entry, `turnPolicy:"off"`). Verified.
- **Install scaffold**: `bash ops/scripts/install docker coturn /tmp/x` creates `env.local` (+ absolute `HOST_DATA_DIR`) and `data/`. Verified (the `svc`/`compose` **symlink** step fails on this Windows host — a platform limitation identical for every service, not a coturn regression; it works on the Linux deploy target).

NOT agent-runnable (needs a deployed, publicly reachable server) — run manually after deploy:
- **Live STUN binding check**: `yarn workspace @serfab/ops-test check-stun -- --host stun.sereus.org --port 3478` → prints your mapped reflexive `IP:port`.

## Use cases / expected behavior

- Browser peer boots → `loadIceConfig()` fetches the operator-hosted manifest → gets `[{ urls: ['stun:stun.sereus.org:3478'] }]` → ticket 3 feeds it to `webRTC({ rtcConfiguration: { iceServers } })` → peers discover reflexive addresses → **direct** WebRTC instead of relaying.
- No manifest URL configured → `[]` → STUN-less but safe (peers fall back to libp2p relay; nothing leaks to a third party).
- Malformed manifest / network error / HTTP 4xx-5xx → `[]` + a logged warning; never throws.
- Operator rotates STUN servers → edit + re-publish the JSON; clients pick it up next load, no app rebuild.

## Known gaps / deviations the reviewer should scrutinize (treat tests as a floor)

- **Compose port conditionality is manual, not declarative.** Docker Compose has no native conditional `ports`. So: STUN `3478/udp+tcp` is always mapped; the **TLS `5349`** and **TURN relay port-range** mappings are present but **commented out** with instructions to uncomment when enabling those paths. True listener conditionality lives in the **entrypoint** (it only starts TURN/TLS listeners when configured), so an inert mapping never has a listener behind it anyway. **Deviation from the ticket's "conditional TLS/relay range" wording** — flagged deliberately; reviewer may prefer compose `profiles` instead.
- **Bridge vs host networking.** Default compose uses bridge + explicit STUN port mappings (mirrors relay convention). For production **TURN**, bridge networking mis-handles relay allocations and can obscure the client source IP (breaking STUN reflexive discovery on some setups). A `network_mode: host` alternative + the `EXTERNAL_IP` knob are documented for that case. Added `EXTERNAL_IP` is **not in the ticket's explicit env list** — added because STUN on a 1:1-NAT cloud VM otherwise reports a private reflexive address. Reviewer: confirm this is the desired default posture.
- **`turnserver.conf` is a template, not consumed directly by coturn.** The active config is `/data/turnserver.active.conf` generated by the entrypoint. Intentional (gives real conditionality + testability without `envsubst`), but worth a read to confirm the substitution (`${LISTENING_PORT}`, `${HOST_BIND_IP}`, `${REALM}`) and the abuse/`denied-peer-ip` set are correct/complete for your threat model.
- **No real-coturn `--check-config`.** coturn isn't installed in the agent/CI env, so config validity is only checked structurally (render + grep), not by the coturn binary. A human/CI should run `turnserver -c <active> -n` or actually `./svc up` once before trusting production. The `denied-peer-ip` IPv6 ranges in particular deserve a real-binary parse check.
- **`bash` dependency in container.** Entrypoint uses bash-only constructs (`[[ ]]`, `${var//a/b}`) and the compose pins `coturn/coturn:4.6` (debian-based, ships bash). If the image tag is ever switched to an **alpine** coturn variant, bash is absent — the entrypoint would need `/bin/sh`-compatible rewriting. Flagged.
- **`import.meta.env.VITE_ICE_CONFIG_URL` is typed `any`** by `vite/client`'s env index signature; the helper narrows it with a `typeof === 'string'` guard rather than asserting a type. Acceptable but reviewer may want a stricter env typing.
- **No e2e coverage** of `loadIceConfig` against a served manifest (no public manifest fixture is wired into the dev server / Playwright). Behavior is covered only by typecheck + the doc-commented contract. A cheap follow-up: drop the example JSON into `reference-app-web/public/` and point `VITE_ICE_CONFIG_URL` at it in an e2e stub.

## Boundary / explicitly NOT done (per ticket)

- Does **not** add `@libp2p/webrtc` or touch `optimystic.ts` transports — that is ticket 3 (`web-webrtc-transport-to-bypass-relay`).
- Does **not** build the TURN credential-issuance endpoint — backlog `turn-credential-issuance-service` (only needed once TURN is on). Until it exists the manifest advertises STUN only.
- Does **not** fix the `connection-path` classifier treating a TURN-relayed WebRTC conn as `direct` — backlog `turn-relayed-path-metrics`. Dormant while TURN is off; forward-pointers left in `ice-config.ts` and `ops/docs/ice-servers.md` so it isn't lost when TURN is enabled.
