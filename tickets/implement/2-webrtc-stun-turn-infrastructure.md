----
description: Stand up self-hosted STUN (coturn) in ops/, plus a runtime ICE-config discovery mechanism (a fetchable JSON manifest matching RTCIceServer[]) and a browser helper that loads it, so the web WebRTC transport can populate rtcConfiguration.iceServers without hard-coding. STUN-first; TURN configured but OFF by default.
prereq:
files: ops/docker/coturn/docker-compose.yml, ops/docker/coturn/turnserver.conf, ops/docker/coturn/entrypoint.sh, ops/docker/coturn/env.example, ops/docker/coturn/ice-servers.example.json, ops/docker/coturn/README.md, ops/docker/quickstarts/coturn.md, ops/docker/README.md, ops/docs/ice-servers.md, ops/scripts/install, packages/reference-app-web/src/lib/ice-config.ts
----

## Goal

Provide the ICE-assistance infrastructure that `web-webrtc-transport-to-bypass-relay` (ticket 3) and later `rn-webrtc-transport` consume. Two deliverables:

1. **Self-hosted STUN** (coturn) deployed from `ops/`, parallel to the existing relay/bootstrap docker surface — so browser/mobile peers discover their server-reflexive (public) address and form direct WebRTC connections instead of relaying every byte.
2. **Runtime ICE-config discovery** — a small JSON manifest (shape = `RTCIceServer[]`) that clients fetch at startup, plus a framework-free browser helper (`loadIceConfig()`) that returns the `iceServers` array ready to drop into `webRTC({ rtcConfiguration: { iceServers } })`. The server list is fetched at runtime so operators rotate/scale STUN/TURN without an app rebuild.

This sits alongside `4-relay-bootstrap-infrastructure` in `ops/docker/` — same deployment surface, distinct purpose (ICE assistance vs libp2p circuit relay). Note coturn is a **distinct upstream image** (`coturn/coturn`), not the `sereus-libp2p-infra:local` image the relay/bootstrap services share.

## Design

### STUN/TURN service (`ops/docker/coturn/`)

coturn behind a thin env-substitution entrypoint, mirroring the relay site-instance conventions (`env.local`, `HOST_*` knobs, `data/` bind-mount, `./svc` script, DNSADDR-style host naming such as `stun.sereus.org` / `turn.sereus.org`).

- **STUN always on.** UDP+TCP `3478`. This is the default and only-on-by-default listener.
- **TURN off by default.** TURN is a relay by another name: a TURN-relayed media path burns server bandwidth for the connection's lifetime — the exact cost this whole effort removes. Gate it behind `TURN_ENABLED=false`. The config file is fully written for the TURN-enabled path but the entrypoint does not start relay listeners / allocate the relay port range unless `TURN_ENABLED=true`.
- **TURN (when enabled) uses ephemeral credentials, never static user/pass.** coturn `use-auth-secret` + `static-auth-secret=${TURN_SECRET}` + `realm=${TURN_REALM}`. Clients present a time-limited `username = <unixExpiry>:<id>` / `credential = base64(HMAC-SHA1(secret, username))`. Issuing those credentials to a browser requires a tiny signing endpoint — **deferred** to `turn-credential-issuance-service` (backlog) since it is only needed once TURN is actually turned on. Until then the manifest advertises STUN only.
- **Abuse controls** (mirroring relay-abuse concerns in `4-relay-bootstrap-infrastructure`): coturn `total-quota`, `user-quota`, `max-bps`; `fingerprint`; `no-multicast-peers`; `no-loopback-peers`; `denied-peer-ip` for RFC1918 / link-local / internal ranges (prevents the relay from being used to reach the host's private network — TURN SSRF). `stale-nonce`. No `cli` / admin port exposed.
- **TLS optional.** `5349` (TURN/STUN over TLS/DTLS) only when `TLS_CERT`/`TLS_KEY` are provided; off otherwise. Browsers accept plain `stun:` so TLS is not required for STUN.

`env.example` knobs: `STUN_PUBLIC_HOST` (the DNS name clients dial), `LISTENING_PORT=3478`, `HOST_BIND_IP=0.0.0.0`, `TURN_ENABLED=false`, `TURN_SECRET=`, `TURN_REALM=`, `TLS_CERT=`/`TLS_KEY=`, `MIN_RELAY_PORT`/`MAX_RELAY_PORT` (TURN relay range, e.g. 49160-49200), `TOTAL_QUOTA`, `MAX_BPS`, `HOST_DATA_DIR=./data`.

### Runtime ICE-config discovery

ICE servers are `stun:`/`turn:` URLs, **not** libp2p multiaddrs — so the existing DNSADDR resolver (libp2p-specific, multiaddr-only) cannot carry them. The browser-friendly, self-hostable channel is a small JSON manifest fetched over HTTPS, co-hosted by the operator (e.g. alongside the relay or the web app origin).

Manifest schema (`ice-servers.example.json`) — deliberately identical to the W3C `RTCIceServer[]` so it drops straight into `rtcConfiguration`:

```jsonc
{
  "iceServers": [
    { "urls": ["stun:stun.sereus.org:3478"] }
    // when TURN is enabled + a credential service exists, a TURN entry with
    // { "urls": ["turn:turn.sereus.org:3478?transport=udp"], "username": "...", "credential": "..." }
  ],
  "turnPolicy": "off",          // "off" | "gated" | "on" — informational; default off
  "generatedAt": "2026-06-02T00:00:00Z"
}
```

`ops/docs/ice-servers.md` documents: where to host the manifest, the `turnPolicy` field, rotating servers without an app rebuild, and an optional DNS-TXT pointer for operators who prefer DNS-anchored discovery.

### Browser helper (`packages/reference-app-web/src/lib/ice-config.ts`)

Framework-free and self-contained — same pattern as `connection-path.ts` (no `cadre-core` / node deps in the browser bundle, so RN can mirror it later). Contract:

```ts
export interface IceConfigManifest {
  iceServers: RTCIceServer[];
  turnPolicy?: 'off' | 'gated' | 'on';
  generatedAt?: string;
}

// Resolves the manifest URL (VITE_ICE_CONFIG_URL ?? localStorage 'ice-config-url' ?? undefined),
// fetches + validates it, and returns iceServers. Returns [] on any failure
// (no URL, network error, malformed) — STUN-less is degraded-but-safe and never
// leaks to a third-party STUN. Logs (never throws) per AGENTS.md.
export async function loadIceConfig(url?: string): Promise<RTCIceServer[]>;
```

Validation is strict-but-lenient: require `iceServers` to be an array; each entry must have a string or string[] `urls`; drop malformed entries with a logged warning rather than failing the whole load. **No hard-coded third-party fallback** (no Google STUN) — empty is the privacy-preserving default.

Ticket 3 then does `webRTC({ rtcConfiguration: { iceServers: await loadIceConfig() } })`; this ticket does NOT wire the transport (that is ticket 3's job) — it only delivers the helper + schema.

### Boundary / what this ticket does NOT do

- Does not add `@libp2p/webrtc` or touch `optimystic.ts` transports/listen addrs — that is `web-webrtc-transport-to-bypass-relay` (ticket 3).
- Does not build the TURN credential-issuance endpoint — backlog `turn-credential-issuance-service` (only needed when TURN is enabled).
- Does not make TURN-relayed media paths count as "relayed" in connectivity observability — backlog `turn-relayed-path-metrics`. The `connection-path` classifier (ticket 1) sees a TURN-relayed WebRTC conn as `/webrtc` → `direct`, which is wrong; but since TURN is off by default this gap is dormant. Flagged loudly so it is not forgotten when TURN is switched on.

## Tests / validation

- **coturn config sanity (agent-runnable):** `turnserver -c <rendered turnserver.conf> -o ... --check-config` style dry-run, or at minimum render the entrypoint substitution with a fixture `env.local` and assert the produced config has STUN listeners and (with `TURN_ENABLED=false`) no relay/`lt-cred-mech` block. A live STUN binding-request check needs a deployed public server → **not agent-runnable**; add `ops/test/check-stun.mjs` (sends a STUN Binding request, prints the mapped reflexive address) and document running it manually, mirroring `ops/test/check-node.mjs`.
- **ICE-config helper:** `reference-app-web` has **no unit-test runner** (Playwright e2e + `tsc --noEmit` + `svelte-check` only). Cover `ice-config.ts` via `yarn workspace @serfab/reference-app-web run typecheck` and `svelte-check`. Validate the example manifest parses against `IceConfigManifest` (a typed import of the JSON, or a tiny type-level assertion). Expected behavior to encode in doc-comments + an e2e stub if cheap: malformed manifest → `[]` + warning; missing URL → `[]` (no fetch); valid manifest → the STUN entry round-trips into `iceServers`.
- **ops docs/install:** `ops/scripts/install docker coturn` scaffolds a site instance (add `coturn` to the `case` allow-list; note the install script's `env.example`→`env.local` + `svc` symlink path works unchanged, but coturn has no `compose.yml` build context to mirror the libp2p image — it pulls `coturn/coturn`).

## TODO

- [ ] Create `ops/docker/coturn/`: `docker-compose.yml` (image `coturn/coturn`, ports `${LISTENING_PORT}:3478/udp` + `/tcp`, conditional TLS `5349`, conditional relay range, `data/` mount), `entrypoint.sh` (env-substitute `turnserver.conf.template` → run; skip TURN listeners when `TURN_ENABLED=false`), `turnserver.conf` (or `.template`) with STUN-on + the gated TURN block + all abuse controls, `env.example`.
- [ ] Add `ops/docker/coturn/ice-servers.example.json` (the manifest schema) and `ops/docs/ice-servers.md` (publication + rotation + DNS-TXT-pointer + `turnPolicy` semantics + STUN-first/TURN-off policy statement).
- [ ] Add `ops/docker/coturn/README.md` + `ops/docker/quickstarts/coturn.md` (mirror `relay.md`/`relay/README.md`: install → edit env.local → svc up → publish `stun.sereus.org` A record + manifest). Update `ops/docker/README.md` "Contents" + recommended-layout to list `coturn/`, and note the distinct upstream image.
- [ ] Extend `ops/scripts/install` `case` to accept `coturn` (and `usage` text). Verify the `svc`/site-instance flow works for a non-build (pull-only) service.
- [ ] Add `ops/test/check-stun.mjs` (STUN Binding request → prints reflexive addr) + a line in `ops/test/README.md`; mark as requires-deployed-server (not agent-runnable).
- [ ] Add `packages/reference-app-web/src/lib/ice-config.ts` with `IceConfigManifest` + `loadIceConfig()` (fetch/validate/fallback-to-empty, URL from `VITE_ICE_CONFIG_URL` ?? localStorage; never throws, logs on failure; no third-party fallback).
- [ ] Run `yarn workspace @serfab/reference-app-web run typecheck` and `yarn workspace @serfab/reference-app-web exec svelte-check`; confirm green.
- [ ] In `ice-config.ts` and `ops/docs/ice-servers.md`, leave explicit forward-pointers to backlog `turn-relayed-path-metrics` and `turn-credential-issuance-service` so the TURN gaps are not lost when TURN is enabled.
