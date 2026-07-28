# Sereus – STATUS (Checklists)

This file is intentionally a **living checklist** of what’s done, what’s next, and what’s being debated.

Conventions:
- `[x]` done
- `[ ]` todo / planned
- `[~]` in progress / partially done

## Repo Structure / Scaffolding (Ops + Packages)

### Ops scaffold (Docker-first)
- [x] Create `sereus/ops/` and `sereus/ops/README.md`
- [x] Create `sereus/ops/docker/` and `sereus/ops/docker/README.md`
- [x] Create `sereus/ops/docker/bootstrap/README.md`
- [x] Create `sereus/ops/docker/relay/README.md`
- [x] Create `sereus/ops/docker/sereus-node/README.md`

### Fill in ops/docker with runnable artifacts
- [ ] Add initial Compose files (or placeholders) for:
  - [x] `sereus/ops/docker/bootstrap/docker-compose.yml`
  - [x] `sereus/ops/docker/relay/docker-compose.yml`
  - [~] `sereus/ops/docker/sereus-node/docker-compose.yml` (template; needs image/entrypoint)
  - [x] `sereus/ops/docker/bootstrap-relay/docker-compose.yml` (combined node)
- [x] Add env example files for each folder with the minimum required knobs
  - Note: dotfiles like `.env.example` are blocked in this workspace; using `env.example`.
- [ ] Decide image strategy:
  - [ ] (Deferred) Use prebuilt images (document source + tags)
  - [x] Build locally from the repo
  - [x] Consolidate `relay`/`bootstrap`/`bootstrap-relay` into a single image + ROLE dispatch (compose remains per-role)
    - Implemented: `sereus/ops/docker/libp2p-infra` image
    - Per-role compose sets `SEREUS_ROLE=...`; operator `env.local` stays host-facing only
- [ ] Add helper scripts (if helpful):
  - [x] `svc` (single entry point for `up`/`down`/`logs`)
- [x] Document quickstart flows:
  - [x] “Run a public relay” (`sereus/ops/docker/quickstarts/relay.md`)
  - [x] “Run a private bootstrap node” (`sereus/ops/docker/quickstarts/bootstrap.md`)
  - [ ] “Add a headless sereus-node to a cadre” (deferred; needs real image/entrypoint)

### Ops validation status (as-tested on `sereus.org`)
- [x] Relay container works (Circuit Relay v2 server)
  - Verified: a NAT'd listener can obtain a reservation and receive relayed inbound connections.
- [x] Bootstrap container works (Kad-DHT server peer)
  - Verified: `ops/test/check-node.mjs --dht` succeeds and `pair:dial --bootstrap-check` succeeds.
- [x] NAT-to-NAT test pair works **when using an explicit relayed dial address**
  - Listener prints a copy/paste dial address like:
    - `/dns4/relay.sereus.org/tcp/4001/p2p/<relayPeerId>/p2p-circuit/p2p/<listenerPeerId>`
  - Dialer succeeds when invoked with `--dial-addr "<that addr>"`
- [~] Bootstrap-only discovery (`dht.findPeer(listenerPeerId)`) is **not working yet**
  - Current outcome: the dialer times out (no `FINAL_PEER` result) even after the listener:
    - reserves on the relay
    - listens on `/p2p-circuit`
    - dials the bootstrap and refreshes routing tables
  - Practical implication: today you can prove relay reachability, but not yet the full “dial by Peer ID via bootstrap-only DHT lookup” flow.

### Next paths to make bootstrap-only discovery work
- [ ] Add explicit “publish self to DHT” step(s) in the listener (instead of relying on passive routing-table learning)
  - Candidate: ensure the listener publishes a signed peer record / provider-style record that the bootstrap peer will return during `findPeer`.
  - Add verbose tracing in both listener and dialer for DHT protocol traffic so we can see whether the bootstrap peer ever learns/stores the listener.
- [ ] Evaluate switching the test pair from Kad-DHT to **FRET DHT** for small overlays
  - Rationale: Kademlia peer routing is a poor fit for a 1-node “DHT” unless the bootstrap peer reliably learns/stores peers.
  - Goal: dialer can resolve listener addresses using only:
    - `--bootstrap /dnsaddr/bootstrap.sereus.org`
    - `--peer <listenerPeerId>`
- [x] Intra-cadre **PeerId → signed address resolution at the control-DB layer.** `CadreNode.resolvePeerAddrs(peerId)` returns a cadre member's current, self-signed, freshness-checked signaling/relay multiaddrs from its PeerId alone, reading the self-published `CadrePeer` `PeerAddressRecord` (written by `CadreNode.registerSelf`, re-published on address change + TTL heartbeat). This removes the copy/paste relayed-dial-address workaround above **for cadre members**, independent of the still-open bootstrap-only DHT `findPeer` flow. A FRET-backed, coordinate-keyed store for arbitrary (non-member) peers remains future work (`tickets/backlog/fret-backed-peer-record-liveness.md`).

### Ops code sharing / multi-deployment support (deferred)
- [ ] Decide whether the libp2p node “apps” should live outside `ops/docker/*` so they can be reused by:
  - [ ] Docker Compose
  - [ ] systemd (bare server)
  - [ ] future k8s/helm deployment
- [ ] Modularize runbook docs/READMEs so common guidance is centralized and referenced:
  - [x] `sereus/ops/docs/dnsaddr.md`
  - [x] `sereus/ops/docs/keys.md`
- [ ] If yes: propose target layout (one of):
  - [ ] `sereus/ops/node-apps/{relay,bootstrap,bootstrap-relay}` + `sereus/ops/node-apps/lib/` for shared utilities
  - [ ] `sereus/packages/@serfab/libp2p-infra` (publishable) + thin wrappers in `ops/*`
- [ ] Identify what should be shared vs per-role:
  - [ ] key persistence + Peer ID printing
  - [ ] listen/announce address handling
  - [ ] logging + healthchecks
  - [ ] relay limits/config (when we add them)
  - [ ] DHT settings (if we keep DHT on bootstrap peers)

### `sereus-node` (deferred) – make it real
- [ ] Reality check: what Optimystic already provides (and gaps)
  - [x] **Protocol isolation via `networkName`** is implemented.
    - All Optimystic protocols are prefixed like `/optimystic/{networkName}/...` (see `optimystic/PROTOCOL-ISOLATION.md` and `@optimystic/db-p2p` `createLibp2pNode`).
    - Implication: a “cadre” very likely maps 1:1 to an Optimystic `networkName` (or a deterministic derivation like `sereus-cadre-${cadreId}`).
  - [x] A headless libp2p+Optimystic runtime exists for development/testing:
    - `optimystic/packages/reference-peer` has a `service` command (no REPL) that starts a node via `@optimystic/db-p2p` `createLibp2pNode`.
    - It supports: `--network`, `--bootstrap` / `--bootstrap-file`, `--storage file|memory`, `--storage-path`, `--fret-profile edge|core`.
  - [ ] **Identity persistence is not clearly implemented**
    - `@optimystic/db-p2p` currently accepts `id?: string` and uses `peerIdFromString(id)` (no explicit private key load/save).
    - For a real `sereus-node`, we need **stable PeerID** (and the corresponding private key) across restarts.
    - TODO: decide on a persistence format (protobuf/JSON) and implement `--key-file` (or similar) in a dedicated node runner.
  - [ ] `relay?: boolean` exists in `NodeOptions` but appears **unused** in `createLibp2pNode` today (no circuit-relay service).
  - [ ] Cluster membership logic is in flux:
    - `optimystic/packages/db-p2p/src/cluster/service.ts` includes a note to “Re-enable and fix cluster membership logic for proper DHT routing”.

- [ ] Identify the runnable artifact (production direction)
  - [ ] Decide: should `sereus-node` run **Optimystic-only** (storage + p2p) or also embed **Quereus** (SQL surface)?
    - Hypothesis: Optimystic provides the p2p/storage substrate; Quereus is a higher-level access plane and may run separately and connect as a client.
  - [ ] Decide the bootstrap story for cadre networks:
    - `bootstrapNodes` in `@optimystic/db-p2p` are used for libp2p bootstrap discovery and also fed into FRET.
    - Question: do we expect operators to point `sereus-node` at **other Optimystic nodes** (recommended), vs pointing at generic libp2p bootstrap peers (likely not useful unless Optimystic also uses libp2p DHT directly).
  - [ ] Define minimum env/args for a first runnable “cadre member”:
    - `NETWORK_NAME` (cadre network name)
    - `BOOTSTRAP_ADDRS` (comma-separated multiaddrs, preferably `/dnsaddr/...`)
    - `LISTEN_PORT`
    - `STORAGE_PATH` + `STORAGE_CAPACITY_BYTES` (Arachnode ring selection)
    - `FRET_PROFILE=edge|core` (role tuning)
    - `CLUSTER_SIZE` + policy knobs (downsize/tolerance)

- [ ] Cadre enrollment (Sereus layer; not in Optimystic yet)
  - [ ] Define how a node joins a cadre:
    - What does an “enrollment token” contain? (cadre id, networkName, bootstrap list, auth, expiry)
    - How is it rotated/revoked?
  - [ ] Decide what secrets/state must persist on disk:
    - libp2p private key (PeerID)
    - Optimystic storage repo (file storage path)
    - any cadre enrollment state / certificates / ACLs (TBD)

- [ ] Bring `sereus/ops/docker/sereus-node` up to the current ops patterns
  - [ ] Replace the current placeholder `SEREUS_NODE_IMAGE` approach with either:
    - a local-build Dockerfile + entrypoint (preferred, consistent with other ops/docker stacks), or
    - an explicitly deferred “prebuilt image” doc.
  - [ ] Refactor `env.example` to host-level knobs (`HOST_PORT`, `HOST_BIND_IP`, `HOST_DATA_DIR`) plus the minimum `sereus-node` knobs above.
  - [ ] Update the compose file to use `./svc` and `--env-file env.local` workflow (same as relay/bootstrap).

- [ ] Docker wiring
  - [ ] Map required ports (tcp/ws/quic/etc) and document firewall rules (start with tcp only)
  - [ ] Add healthcheck and minimal logging guidance (PeerID, multiaddrs, networkName)
  - [ ] Add volume layout and backup guidance (keys + storage)
  - [ ] Add “start on reboot” instructions (Docker enablement + `restart: unless-stopped`)

### Packages scaffold
- [x] Create `sereus/packages/` and `sereus/packages/README.md`
- [x] Move `sereus/bootstrap/` → `sereus/packages/strand-proto/` and rename npm package to `@serfab/strand-proto`
- [x] Update docs that referenced the old path (`sereus/docs/strand-proto.md`, manual test README)

## libp2p Strand Bootstrap Library (`@serfab/strand-proto`)

- [x] Keep protocol id default `'/sereus/bootstrap/1.0.0'` with override options
- [ ] Add diagrams to `sereus/docs/strand-proto.md`
  - [ ] 2-message flow (`responderCreates`)
  - [ ] 3-message flow (`initiatorCreates`, new stream)
  - [ ] rejection + timeout paths
- [ ] Decide whether to add an aggregator package/entrypoint (defer until ≥2 stable packages)

## Cadre Management (Specification + Schema)

Goal: define and implement how a user manages a **cadre** (their personal cluster of nodes/devices) including membership, provisioning, enrollment, and trust boundaries.

> Current sources of truth: `schemas/control.qsql` (schema `CadreControl`), `docs/architecture.md`, `docs/strands.md`, and the built `@serfab/cadre-core` package.

- [ ] Create a Cadre management spec doc (suggested: `sereus/docs/cadre.md`)
  - [x] Definitions: cadre vs node vs device identity — covered in `docs/strands.md` + `docs/architecture.md`
  - [ ] Enrollment lifecycle (invite/join/rotate/revoke)
  - [ ] Key material / identity assumptions (where keys live, recovery, rotation)
  - [ ] Transport expectations (direct vs relay, addressing, reachability)
  - [ ] Operational requirements (headless node, backups, monitoring)
- [ ] Create an initial Cadre schema doc (suggested: `sereus/docs/cadre-schema.md`)
  - [~] Tables — a control/cadre schema exists at `schemas/control.qsql` (schema `CadreControl`) with `OwnerKey`, `ValidationKey`, `Strand`, `CadrePeer`, `DeviceToken`, `FormationInvite`, `FormationUsage`; the actual shape differs from the proposed `cadres`/`cadre_nodes`/`node_keys`
  - [ ] RBAC / permissions model (who can add/remove nodes)
  - [ ] Audit trail requirements
- [x] Decide where the schema lives long-term: as `.qsql` artifacts under `schemas/`

## Cohort Management (Specification + Schema)

Goal: define and implement how a **cohort** (all nodes belonging to a strand) is tracked, managed, and evolved. This likely becomes the conceptual replacement for the current “projects/bootstrap” direction.

> Current sources of truth: `schemas/control.qsql` (schema `CadreControl`), `docs/architecture.md`, `docs/strands.md`, and the built `@serfab/cadre-core` package.

- [ ] Create a Cohort management spec doc (suggested: `sereus/docs/cohort.md`)
  - [x] Definitions: strand vs cohort vs cadre; relationship model — covered in `docs/strands.md:6-11`
  - [ ] Cohort membership lifecycle (join/leave/ban/rehabilitate)
  - [ ] Discovery and reachability (bootstrap nodes vs relays vs “known peers”)
  - [ ] Security boundaries (cadre disclosure timing, trust levels, roles)
  - [ ] Multi-party bootstrap roadmap alignment
- [ ] Create an initial Cohort schema doc (suggested: `sereus/docs/cohort-schema.md`)
  - [~] Tables — `Strand` plus formation/invite tables exist in `schemas/control.qsql`; full `strand_members`/`roles` modelling still pending
  - [ ] Token/invitation encoding strategy (application-defined vs standardized)
  - [ ] Auditing and key rotation impacts

## Strand Hibernation (cadre-core)

Strand lifecycle resource management in `@serfab/cadre-core`
(`hibernation-manager.ts`, `strand-instance-manager.ts`, `cadre-node.ts`).

- [x] Hibernation releases strand resources and rehydrates on wake
  - `StrandInstanceManager.quiesceStrand` stops the libp2p node + closes the `StrandDatabase`
    while retaining the instance record + launch config; `resumeStrand` rebuilds them via the
    shared `buildStrandRuntime`, re-resolving the cohort seed + mode (`bootstrap → networked`).
  - `CadreNode.handleStrandHibernate`/`handleStrandWake` wire the orchestration; overlapping
    wake triggers coalesce in `HibernationManager` so only one runtime is rebuilt.
- [x] `idle` is a lightweight status flag (node + DB still running)
  - [ ] Trim connections while `idle` ("minimal connections") — parked to backlog (`3-mobile-resource-awareness`)
- [x] Cohort-querying check-in (check-in wake) on exponential backoff
  - `HibernationManager` replaces the fixed `setInterval` with a self-rescheduling `setTimeout` chain:
    base `checkInInterval` × `checkInBackoffFactor` per idle check-in, capped at the per-hint
    `checkInMaxInterval` (interactive 30s→~1h, background 5m→~6h, archive 1h→~3d). The next tick is
    scheduled only after `onCheckIn` resolves (no overlap); backoff resets to base on the next hibernation.
  - `CadreNode.handleStrandCheckIn` performs the real check-in: resume (reusing `resumeStrand`, re-resolving
    cohort seed/mode) → bounded `checkInWindowMs` window → re-hibernate via `quiesceStrand` if idle, else stay active.
  - Known gap: Optimystic syncs **pull-on-read** with no cheap repo-level "pull pending" hook (`IRepo` =
    get/pend/commit/cancel), so the check-in is a resume-as-reachability cycle relying on app-driven reads to
    surface activity — not a bespoke head/version probe. Lighter control-network pre-check parked to backlog
    (`hibernation-control-network-pending-precheck`).
- [x] Push-wake via the control network
  - `strand-wake-protocol.ts` adds `WAKE_PROTOCOL` (`/sereus/strand-wake/1.0.0`), modeled on seed-bootstrap:
    length-prefixed JSON `WakeRequest`/`WakeAck` frames, one request → one ack per stream.
  - `StrandWakeService` (receiver, registered in `CadreNode.start`/`cleanup`) gates inbound wakes on
    the authorized-member surface (`CadreNode.isAuthorizedMember`: the row's persisted voucher must
    verify against an owner key in the node-local trusted-owner anchor, not-self, fail-closed —
    the ticket-4 predicate) — no extra signature on the wake itself — then routes a
    hibernating/idle strand through the same wake path as a local wake
    (`wakeStrand → resumeStrand`), so resume coalescing prevents a push racing a concurrent check-in.
  - `CadreNode.pushWake(targetPeerId, strandId, reason?)` (sender) resolves the target's signed
    control-network address via `resolvePeerAddrs` (signaling/relay first for NAT'd peers) and dials.
  - The automatic trigger policy (a server fanning wakes on activity) has since shipped as `PushFanoutService`
    (`push-fanout.ts` — see below), as has Mobile FCM/APNs **receive** delivery.
- [x] Device-token registry (the resolve primitive FCM/APNs delivery needs)
  - `DeviceToken` control-network table (in `control-schema.ts` + `schemas/control.qsql`), modeled on
    `CadrePeer`: self-published, monotonic `UpdatedAt`, self-`Sig` over `(PeerId|Platform|Token|UpdatedAt)`
    verified at resolve time against the bound `CadrePeer.PublicKey`. Insert/delete owner-gated; a
    member self-updates its own token (rotation / platform switch).
  - `device-token.ts` (`deviceTokenSignedPayload` / `signDeviceTokenRecord` / `verifyDeviceTokenSignature` /
    `isPushPlatform`) mirrors `peer-record.ts`. `CadreNode.registerDeviceToken(platform, token)` /
    `resolveDeviceToken(peerId)` (membership + binding + self-sig + freshness gated, `null` on any failure) /
    `clearDeviceToken()` reuse the `registerSelf` / `resolvePeerAddrs` write+gate paths.
  - **Downstream of this registry**: the platform push **sender** (`PushNotifier`) and the automatic
    fan-out/trigger (`PushFanoutService`) have both since shipped (see below). A non-owner phone cannot yet self-insert its first `DeviceToken` row — like
    `CadrePeer`, the initial row is owner-gated, so the phone→server registration handshake (downstream
    "RN registration" ticket) must seed it before the phone can self-refresh.
- [x] Imperative background-lifecycle primitives (platform-agnostic; for a mobile `BackgroundRunner`)
  - `CadreNode.hibernateStrand(strandId)` / `hibernateAll()` force-hibernate now, bypassing the
    idle/hibernate timers, via `HibernationManager.forceHibernate` — which cancels the strand's pending
    idle/hibernate **and** check-in timers and runs `onHibernate` without re-arming check-ins (the strand
    stays down until the caller drives a wake). Realtime strands are skipped (`HibernationManager.hibernates`);
    `hibernateAll` is collect-and-continue on per-strand failure and returns the hibernated strandIds.
  - `CadreNode.serviceWake(strandId, opts?)` runs the check-in cycle on demand (shared `runWakeWindow` body),
    coalesced per-strand and sharing one runtime build with a racing push-wake; returns a branchable
    `ServiceWakeResult { strandId, serviced, hadActivity }` instead of throwing when not running / unknown.
  - `running` / `controlConnected` getters give headless callers a synchronous readiness snapshot.
- [x] Mobile push-wake **receive** path (RN reference app, managed Expo SDK 53 + `expo-dev-client`)
  - `packages/reference-app-rn/src/push-wake.ts` (platform-agnostic, unit-tested): the shared
    `StrandWakePayload { type:'strand-wake', strandId, reason }` contract (now homed in
    `@serfab/cadre-core`'s `strand-wake-payload.ts` and imported from there — the delivery sender has since
    shipped, see below), its defensive parser, `extractPushData` (Android JSON `dataString` /
    iOS keys), the background-task handler (parse → foreground-vs-background route → cold-start ensure →
    bounded `awaitControlConnected` → `serviceWake`), and the `DeviceToken` registrar (deferred-retry on
    pre-membership). Foreground pushes route to `wakeStrand`+`recordStrandActivity` (no re-hibernate).
  - `push-wake-native.ts` (the only RN/expo-coupled module, mirrors `app-state.ts`): defines + registers the
    `expo-notifications`/`expo-task-manager` background task (wired in `index.js`), acquires the raw FCM/APNs
    token (`getDevicePushTokenAsync`), and re-publishes on rotation. `use-cadre` calls it on start / clears on
    stop. Library rationale (Expo first-party over bare-RN headless JS / `notifee`) in the ticket handoff.
  - Config: `app.json` iOS `UIBackgroundModes:[remote-notification]` + `expo-notifications` plugin; Android
    `POST_NOTIFICATIONS`/`WAKE_LOCK` (manifest + plugin permissions). No FGS (data-message window suffices).
  - **Best-effort by design**: iOS silent push is rate-limited/coalesced and Android Doze defers data messages
    without a battery-optimization opt-out — the check-in wake is the backstop. Cold-start into a fully OS-killed
    process is **not** yet wired (start options aren't persisted) → degrades to a `no-node` no-op. Human/infra
    prerequisites (`google-services.json`, paid APNs creds + push capability) and on-device validation are
    out-of-agent; steps recorded in `tickets/review/3-mobile-push-wake-receive.md`.
- [x] Platform push **delivery** sender (`PushNotifier`, cadre-core)
  - `push-node.ts` (Node-only subpath `@serfab/cadre-core/push-node`): `createPushNotifier(creds, deps?)` returns
    a credential- and transport-injected router dispatching by `PushMessage.platform` to FCM/APNs, constructing
    only the implementations whose credentials are present. `push-notifier.ts` is the cross-platform **interface**
    half (`PushMessage`/`PushSendResult`/`PushNotifier`), zero-import so referencing it pulls in no Node builtins.
    `send` returns a `PushSendResult` (`{ ok:true }` | `{ ok:false, unregistered, error }`)
    as a value and never throws; a platform with no creds yields a best-effort `no <platform> credentials`.
  - `push-notifier-fcm.ts` (HTTP v1): RS256 service-account JWT → cached OAuth2 access token (re-minted once
    on a 401), `POST …/v1/projects/{projectId}/messages:send` with a high-priority `data` message. 404
    `UNREGISTERED` / 400 naming the registration token → `unregistered:true`; a generic 400 / 5xx is transient.
  - `push-notifier-apns.ts` (HTTP/2): cached ES256 provider JWT (JOSE r‖s, re-minted once on 403
    `ExpiredProviderToken`) over one lazily-(re)established `node:http2` session (re-established once on
    GOAWAY/throw). `POST /3/device/{token}` with `apns-push-type: background` / `apns-priority: 5` /
    `content-available`; 410 `Unregistered` / 400 `BadDeviceToken` → `unregistered:true`. `close()` ends the session.
  - The shared contract `strand-wake-payload.ts` (`STRAND_WAKE_TYPE` + `StrandWakePayload`) **moved into
    cadre-core** — imported by both sender and RN receiver. `CadreNodeConfig.push` carries an **injected**
    `{ notifier, cooldownMs?, debounceMs? }`; the raw `PushCredentials`/`FcmCredentials`/`ApnsCredentials`
    (`privateKey` fields secret, never logged) are read only by the Node host that builds the notifier.
    Node-only modules (`node:crypto`/`node:http2`) stay out of the RN/browser bundle: the FCM/APNs impls +
    `createPushNotifier` live behind the `@serfab/cadre-core/push-node` subpath, and the cross-platform entry
    re-exports only the `PushNotifier` *interface* — the host injects the instance into `config.push.notifier`.
  - 22 unit tests (`push-notifier.spec.ts`, importing `createPushNotifier` from `push-node.ts`, fake fetch/http2
    transports) cover request shape, every documented response-code mapping, access-token cache + 401 re-mint,
    provider-JWT refresh, GOAWAY re-establish, router dispatch + missing-credentials no-op, and no-secret-in-logs.
    *Who*/*when* to wake, driving the **injected** notifier, and expiring `unregistered` rows are now owned by the
    fan-out below; **real-network / on-device validation remains out-of-agent** (no network is exercised in unit tests).
- [x] Server push-wake **fan-out + trigger policy** (`PushFanoutService`, `push-fanout.ts`)
  - `CadreNode.start` constructs the fan-out only when `config.push` is set. The `PushNotifier` is **injected**,
    not built in-core: the Node host (cadre-cli) constructs it from the Node-only subpath
    `@serfab/cadre-core/push-node` (`createPushNotifier(credentials)`) and passes the instance in
    `config.push.notifier`, so `node:http2`/`node:crypto` never enter a cross-platform node's graph. The node owns
    the injected notifier's lifecycle (closed on `stop` via the fan-out). Without `config.push` the node is unchanged.
  - **v1 trigger is explicit** (no passive Optimystic detector — `IRepo` has no commit/block-received hook, so
    it is **deferred** to backlog as an enhancement, not a correctness gap): `CadreNode.notifyStrandActivity(strandId, reason?)`
    is the imperative seam, and `recordStrandActivity` additionally drives it (same seam local-wake uses).
  - `notify(strandId)` gates on participation (`getStrand`), debounces per strand (`debounceMs`, default 10 s) +
    coalesces concurrent triggers, enumerates `listMembers()` minus self, skips peers within the per-`(peer,strand)`
    cooldown (`cooldownMs`, default 5 min), then wakes **direct-first**: a resolved `WakeAck` (even `accepted:false`)
    = reached ⇒ no platform push (no double-wake); only a dial/transport **rejection** falls back to
    `resolveDeviceToken` → `notifier.send`. An `unregistered` send marks the token dead (skips next resolve→send)
    and calls `CadreNode.expireDeviceToken(peerId)` — owner deletes the row, non-owner logs re-registration.
  - **Honest caveats**: cooldown/debounce/dead-token state is **in-memory, acceptably lossy** across restarts
    (`serviceWake` is idempotent ⇒ a duplicate is harmless); **no cross-strand coalescing** in v1 (each wake names
    its own `strandId`); **passive detection deferred** (above). Never throws to the trigger — the check-in wake
    is the backstop.
  - 18 unit tests (`push-fanout.spec.ts` fakes the node primitives + notifier; `cadre-node.spec.ts` covers the
    `recordStrandActivity → notify` binding, the no-push-config no-op, and `expireDeviceToken` owner-vs-not).
    **Not exercised**: the RN-bundle build (Metro lacks a `node:http2` shim — see the ticket review handoff) and
    real-network fan-out.

- [x] Push-credential provisioning into the spawned node's `config.push` (host + provider)
  - `cadre-core` exposes `validatePushCredentials` / `redactPushCredentials` (`push-credentials.ts`, dependency-free)
    so a provisioner rejects a partial credential set and never logs a private key.
  - **cadre-cli** now carries `push` from `cadre.json` (and a JSON `CADRE_PUSH` env override) through `ResolvedConfig`
    into `CadreNodeConfig.push` — closing the gap that previously dropped the block before `CadreNode.start`.
  - **cadre-host**: FCM/APNs private keys + identifiers live in the secret store (keytar / `0600` fallback, accounts
    `push:fcm` / `push:apns`); non-secret bits (APNs `bundleId`, sandbox/prod, cooldown/debounce) live in
    `host.config.json`. `cadre-host push {fcm,apns,options,status,clear}` is the entry path. The orchestrator
    **re-resolves on every (re-)spawn** via a `pushResolver` (no raw key in `state.json`) and writes `config.push`
    for the owner/storage node (and managed storage nodes); transaction nodes get none. Tested:
    `push.test.ts`, `orchestrator-push.test.ts`.
  - **cadre-provider**: per-tenant `push` config (provider-level `default` + `tenants[customerId]` overrides);
    `validate.ts` rejects a partial set at `loadConfig`; `ContainerService` resolves **strictly by the launching
    tenant's id** and the Docker orchestrator injects `CADRE_PUSH` (JSON, PEM-newline-safe) — a cross-tenant
    isolation test asserts tenant B's node never receives tenant A's (or the default's) secret. Tested:
    `push-validate.test.ts`, `container-push.test.ts`, `docker-orchestrator-push.test.ts`.
  - **Push-wake is end-to-end once a deployment provisions creds.** On-device validation (real FCM/APNs token,
    correct bundle id, sandbox-vs-production match for the build under test) remains a human prerequisite, and the
    Firebase/Apple credential creation itself is out-of-agent infra work.

## Cadre-host node-donation realignment

cadre-host's primary role is now **node donor** — running OS-managed child-process nodes that join
*other people's* cadres (the same donate-a-node contract `@serfab/cadre-provider` implements for
Docker), with the recipient's device staying the authority and the host holding no owner keys.
Running the host's *own* cadre (the **founder** role) is demoted to an opt-in flag. See
[`docs/cadre-host.md`](cadre-host.md) → Node donation.

- [x] Founder role demoted to opt-in `ownCadre.enabled` (default off); the donor stack + management
  server are always up, the owner node / `/auth` / `/nat` only come up when the flag is set.
- [x] Grant-token layer — `GrantService` / `GrantStore`, loopback `/grants-admin`, and
  `cadre-host grant issue|list|revoke`. A grant is a long-lived, reusable-to-quota bearer, distinct
  from a one-time trust-circle invite.
- [x] Orchestrator pins the requester's owner public key into the donated child
  (`createContainer` → `CADRE_OWNER_KEYS` → cold-start pinned-key trust policy) so the node accepts
  the requester-signed seed. `donations.json` store + donation types landed.
- [x] `DonationService` lifecycle (`provision` / `getPeer` / `applySeed` / `terminate` / `get` /
  `list`, exported from `@serfab/cadre-host`) — proven end-to-end by the integration test below.
- [~] Grantee-facing `/grants` provisioning surface + `bin/host.ts` wiring + stale-`awaiting_seed`
  reap sweep + `DonationService` unit tests — in progress (`tickets/implement/2-donation-service.md`,
  Phase 2/3). `DonationService` is today exercised only through the integration scenario.
- [ ] WAN reachability for the request surface and per-donated-node NAT/relay mapping — deferred
  (`tickets/backlog/feat-cadre-host-wan-grant-reachability.md`); v1 donation is loopback-only.
- [x] Cross-package node-donation integration test (a real cadre-cli requester ↔ a donated node) —
  `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`, drives
  `DonationService` directly (5/5 steps green).

## Testing / CI

- [ ] Wire `@serfab/strand-proto` tests into workspace CI
- [ ] Add root-level scripts for running package tests consistently (Yarn workspace)

### Type-check coverage

`yarn typecheck` (root) now fans out to **every** TS workspace, not just `reference-app-web`.
Each package defines a `typecheck` script (`tsc --noEmit`) so type validation no longer depends on
the slower `yarn build`, and test files are type-checked where possible (vitest itself never type-checks).

- [x] Every TS package has a `typecheck` script; `yarn typecheck` validates all 9 (was 1 of 9)
- Per-package scope:
  - Source **+ tests**: `cadre-cli`, `integration-tests`, `quereus-plugin-sereus` (via `tsconfig.typecheck.json`), `reference-app-rn`
  - Shippable **source only** (`tsconfig.build.json`): `cadre-core`, `cadre-host`, `cadre-provider`, `strand-proto`, `reference-app-web`
- Known coverage gaps:
  - `cadre-core` tests and `cadre-host` server tests have pre-existing type drift (libp2p `peerId`→`privateKey`,
    `CadreNodeConfig.privateKey` now `PrivateKey` not `Uint8Array`, `NodePorts.admin` added, implicit-`any` params).
    Their `typecheck` stays at shippable-source until those tests are fixed — see fix ticket
    `widen-typecheck-cadre-core-host-tests`.
  - `cadre-host` `ui/` (Svelte) and `reference-app-web` `.svelte` files are **not** covered — `tsc` can't type-check
    `.svelte`; that needs `svelte-check` (already a devDependency in both). Not wired into `typecheck` yet.
  - `cadre-provider` has no test files, so its `tsconfig.build.json` scope already covers everything; `strand-proto`
    is deprecated so left source-only by design. Neither needs a widened-test config.

### Dependency-check coverage

`yarn dep-check` (root) is now a **real** gate. It was previously a no-op (`workspaces foreach -A run dep-check`
with no package defining the script, exiting 0 in ~0s). It now runs [knip](https://knip.dev) from the repo
root against a single config (`knip.ts`, Option A) covering all nine workspaces.

- [x] `dep-check` detects unused, missing (phantom/unlisted), and unresolved deps/binaries across all workspaces.
- Gate semantics (`knip.ts` `rules`): dependency-class issues are `error` (fail the gate); dead-code classes
  (unused **files / exports / types**) are `warn` (surfaced but non-blocking). Cleaning the existing dead-code
  backlog (~15 files, ~40 exports, ~29 exported types, mostly in the reference apps and host UI) is **deferred** —
  out of scope for the dep-check ticket.
- Phantom deps fixed (added as direct deps where production/test code imports them transitively):
  `@multiformats/multiaddr` (cadre-core, integration-tests, reference-app-rn), `@libp2p/crypto` + `@libp2p/interface`
  (cadre-cli, cadre-host), `@libp2p/peer-id` (cadre-cli, cadre-host), and `@vitest/coverage-v8` (cadre-core,
  integration-tests, quereus-plugin-sereus, strand-proto — coverage is configured in their vitest configs).
- Truly-unused deps removed: root `esbuild`, `aegir` (cadre-cli/core/provider — no longer used now that build/test
  run `tsc`/`vitest` directly), and `@serfab/cadre-core` from cadre-provider (never imported).
- Documented framework/dynamic false-positive ignores live in `knip.ts` with rationale: Expo/Metro-implicit
  (reference-app-rn), Vite-config-implicit (reference-app-web), dynamic-`import()`/runtime-`resolve` deps
  (cadre-host: nat-port-mapper, qrcode-terminal, cadre-cli bin), and runtime-registered Quereus plugins
  (integration-tests). Non-workspace trees (`tess/`, `ops/`, `docs/`, `scripts/`) are ignored.

### Lint coverage

`yarn lint` (root) is now a **real** gate. It was previously a no-op (`workspaces foreach -A run lint`
with no package defining the script, exiting 0 in ~0s). It now runs [ESLint](https://eslint.org) 10 +
typescript-eslint 8 from the repo root against a single flat config (`eslint.config.mjs`) covering all
workspaces (TS, JS tooling, and Svelte UIs via `eslint-plugin-svelte`). `yarn lint:fix` applies the
auto-fixable subset.

- [x] `eslint.config.mjs` encodes the AGENTS.md style rules; the gate exits 0 on a clean checkout.
- Rules at **`error`** (codebase already compliant, trivially fixed, or backlog burned down): `no-floating-promises`
  (type-aware, `packages/*/src` only — the AGENTS.md "`void` unused promises" rule), `no-require-imports`
  (ES-modules; one intentional cross-platform `require` in `control-database.ts` is `eslint-disable`d with
  rationale), `no-case-declarations`, `no-unused-vars` (honors the `_`-prefix convention),
  `consistent-type-imports`, `no-empty` (empty catch), `no-explicit-any` (the AGENTS.md "avoid `any`" rule —
  ~68-site backlog burned down in `lint-cleanup-no-explicit-any`), and the Svelte UI rules
  `svelte/no-at-html-tags` / `svelte/prefer-svelte-reactivity` (burned down in `lint-cleanup-svelte`; the
  remaining sites — a locally-generated QR SVG, plus transient/replace-only Set/Date instances — are false
  positives carrying scoped `eslint-disable` + rationale). Plus eslint-10 recommended additions that are **not**
  AGENTS.md rules: `prefer-const`, `preserve-caught-error`, `no-useless-assignment`, `no-control-regex`
  (one deliberate control-char guard in `update/apply.ts` is `eslint-disable`d with rationale). The
  mechanical backlog for these was burned down in `lint-cleanup-mechanical`; `preserve-caught-error`'s
  `new Error(msg, { cause })` fix required bumping `lib` to `ES2022` (target unchanged at `ES2020`) in
  `cadre-core`/`cadre-host` tsconfigs.
- Rules at **`warn`**: none. The lint-cleanup epic (`lint-cleanup-mechanical` → `lint-cleanup-no-explicit-any`
  → `lint-cleanup-svelte`) is complete; there is no remaining `warn` backlog and `yarn lint` exits 0 with
  **0 warnings, 0 errors**. Every rule the config encodes is now a hard `error` gate.
- **Not machine-enforceable** here (remain human-review-only): lowercase SQL reserved words (SQL lives in
  template literals), and the "no runtime inline `import()`" rule (no clean ESLint rule;
  `consistent-type-imports` only covers type-position imports). Tab indentation is left to `.editorconfig`,
  not linted, to avoid a formatter war.
- Scope notes: type-aware linting (`projectService`) is enabled only for the node/library `src` trees;
  the bundler/expo apps (`reference-app-web`, `reference-app-rn`, `cadre-host/ui`) get non-type-aware rules.
  `maestro/` (Maestro JS engine), `strand-proto` (deprecated), and non-package trees (`tess/`, `ops/`,
  `scripts/`) are ignored.

## Multi-node use-case validation (2026-06-26)

Hands-on debugging of two flows (real cadre-cli processes on localhost + integration
tests + `reference-app-web` e2e). Source of truth: the runs below, not aspiration.

**Update (2026-06-27):** the optimystic multi-coordinator ticket filed from this work was
split and **both halves are now fixed & complete** in `../optimystic`. Case (a) — the
**relayed** inter-coordinator stream reset — `multi-coordinator-write-relay-stream-reset`
(promise-phase immediate retry + `connect()` prefers a direct over a relayed connection).
Case (b) — **cross-network coordinator selection** —
`multi-coordinator-cross-network-coordinator-selection` (network-membership scoping:
`Libp2pKeyPeerNetwork` takes a `protocolPrefix`, classifies peers `serves`/`foreign`/`unknown`
from their peerStore protocols, and `findCoordinator`/`findCluster` exclude `foreign` peers).
Rebuilt the linked optimystic `dist` and re-tested (see per-flow results below): the **real
product topology** (edge/`transaction` initiator) now passes end-to-end; a **residual** remains
only for **`storage` + `storage` cross-network** coordination (documented optimystic/Fret
follow-up, below).

**Update (2026-06-29): the `storage`+`storage` residual is now FIXED & VERIFIED.** The optimystic
selection-layer ticket `cross-network-unknown-peer-backfill-hardening` was planned (split into
`cross-network-cohort-no-unknown-backfill` + `cross-network-coordinator-no-unknown-fallback`),
implemented, reviewed, and is **complete** in `../optimystic` (HEAD `56db2fd`). Rebuilt the linked
`db-p2p` dist and re-ran the integration suite: `strand-formation-e2e` **11/11 pass** (was 3 fail /
8 pass — Phase 2 storage+storage now green), `strand-membership-closed-strand-e2e` **1/1 pass**, and
the **full integration suite is 98 passed / 2 failed** (was broadly blocked). The 2 remaining
failures are a *separate, pre-existing* membership-authorization issue (not the cross-network path) —
see "Membership gate" below; filed as `tickets/plan/membership-gate-uses-cadrepeer-record-presence.md`.
The FRET root-cure ticket (`network-scoped-ring-admission`, `../fret/tickets/plan/`) is no longer
required to unblock Sereus, but remains wanted as defense-in-depth on the routing substrate.

### Adding a cadre member (cadre-cli)
- [x] **Works** for the realistic topology: one `storage`/owner node + `transaction`
  member(s). Verified live: owner (`cadre start --owner --admin-port`) →
  `POST /admin/accept-phone` authorizes the member → member joins via
  `controlNetwork.bootstrapNodes` → both nodes converge on the `CadrePeer` roster
  **and** the member self-registers its dialable address (`registerSelf: refreshed`).
- [x] **Fixed (cadre-cli):** `cadre enroll create` writes the identity key as libp2p
  *protobuf* hex, but the config loader's `identity.keyFile` path fed those bytes to
  `privateKeyFromRaw` → `No decoder for tag 8`, so a freshly-enrolled identity could
  never start a node. `loader.ts` now decodes protobuf-first with a raw fallback
  (`decodePrivateKey`); regression tests added in `test/protobuf-identity.spec.ts`.
- [ ] **Blocked — multiple `storage` members.** Two `storage`/coordinator nodes in the
  same party cannot complete a control-network write: the member's `registerSelf`
  write fails with `Failed to get super-majority: 0/2 approvals (needed 2)` /
  `StreamResetError: The stream has been reset` in optimystic's `NetworkTransactor`.
  Reads/roster converge (pull-on-read) and single-coordinator writes succeed; only
  multi-coordinator writes fail. See the optimystic blocker below.
- Gaps noted (not bugs): no CLI surface to **create a strand** (`cadre strands` is
  list-only) or to **export a `ControlNetworkSeed`** (admin exposes `/admin/invites`
  = `CadreInvite`, but `--seed` consumes a `ControlNetworkSeed` with no extract path).

### Inviting another user / cross-party strand formation
- [x] **Works for the real product topology** (edge/`transaction` initiator inviting), verified
  2026-06-27 against the rebuilt optimystic case-(b) fix:
  - `reference-app-web` formation e2e (`e2e/distributed/formation-convergence.spec.ts`, a real
    browser ↔ headless-responder test) **passes** — *"a redeemed invitation forms a closed
    strand and the responder seed converges to the browser"* (2 passed). This is the same
    1+1 test that previously failed with the case-(b) signature; the consent write
    (`StrandFormationManager.provisionAsResponder` → `ControlDatabase.recordFormationUsage`)
    now reaches quorum.
  - Integration `strand-formation-e2e` Phase 1 (`transaction`-profile parties via
    `createParty`) **passes** — open-invitation formation, token reuse rejection, disclosure
    accept/reject, and Phase 4 consent enforcement all green.
- [x] **`storage` + `storage` cross-network — FIXED & VERIFIED (2026-06-29).** `strand-formation-e2e`
  Phase 2 (`new CadreNode(... profile:'storage')` for *both* parties) and the closed-strand
  membership e2e now **pass** (`strand-formation-e2e` 11/11, closed-strand 1/1). The optimystic
  selection-layer fix (`cross-network-unknown-peer-backfill-hardening`, split into
  `cross-network-cohort-no-unknown-backfill` + `cross-network-coordinator-no-unknown-fallback`,
  both complete at optimystic HEAD `56db2fd`) stops the `min(2, clusterSize)` viability floor from
  backfilling an unconfirmed `unknown` peer into the write cohort, so party A no longer dials party
  B's `/repo/1.0.0`. The `could not negotiate /optimystic/control-<party>/repo/1.0.0` +
  `super-majority: 1/2` signature is gone. The FRET root cure (`network-scoped-ring-admission`)
  remains wanted as substrate-level defense-in-depth but is not required for this.

### Optimystic blocker (root cause — sibling repo `../optimystic`, HEAD past v0.14.1)
Multi-coordinator control-network **writes** can't reach a super-majority. The original
ticket (`multi-coordinator-write-stream-reset-supermajority`) was split into two distinct
root causes:
- **Case (a) — relayed stream reset → FIXED & COMPLETE.** Same-party two-`storage`-node
  writes over a circuit-relay (limited) connection saw the promise-phase stream reset
  transiently (`StreamResetError` / `super-majority: 0/2`). Fix
  (`multi-coordinator-write-relay-stream-reset`): promise-phase immediate retry
  (`promiseImmediateRetries`, default 1) + `Libp2pKeyPeerNetwork.connect()` prefers a
  direct connection over a limited/relayed one. Full db-p2p suite green.
- **Case (b) — cross-network coordinator selection → FIXED & COMPLETE (with a residual).**
  `multi-coordinator-cross-network-coordinator-selection` (optimystic `tickets/complete/`,
  commit `f712bfb`). A write on network A could pick a coordinator that only serves network B,
  failing to negotiate `/optimystic/control-<A>/repo/1.0.0` at `super-majority: 1/2`. Fix:
  `Libp2pKeyPeerNetwork` takes a `protocolPrefix` (threaded by `createLibp2pNode`, so all sereus
  nodes get it) and classifies ring peers `serves`/`foreign`/`unknown` from their peerStore
  protocol list; `findCoordinator` drops `foreign`, `findCluster` over-fetches a wider band and
  keeps same-network peers, and a new `NO_NETWORK_COORDINATOR` replaces the generic failure.
  Verified end-to-end for the **edge/`transaction` initiator** topology (the product path).
  **Residual → RESOLVED (2026-06-29).** The `storage`+`storage` cross-network case was fixed by the
  optimystic follow-up `cross-network-unknown-peer-backfill-hardening` (split + complete at HEAD
  `56db2fd`): the viability-floor no longer backfills an unconfirmed `unknown` peer, so a write is
  never handed to a peer that isn't confirmed to serve this network. Verified in Sereus (formation +
  closed-strand e2e green; see formation finding above). The FRET-side cure
  (`network-scoped-ring-admission`) remains wanted as substrate defense-in-depth. Intersects
  optimystic backlog `cohort-topic-participant-coord-routing-key-mismatch` (FRET routing-key scoping).

### Membership gate (cadre-level `isMember`) — hole CLOSED (2026-07-27); chain steps 5–6 remain
With the cross-network blocker cleared, the full integration suite is **98 passed / 2 failed**. Both
residual failures share one root cause and are **not** related to the optimystic work: `isMember()`
is `listMembers().some(...)`, and `listMembers()` returns raw `CadrePeer` **address records**, so
membership = "has published an address record", not "is authorized". Effects: (1) a fresh party lists
its own self-registered row (`cadre-host-owner-node` fresh-party test — expected `[]`); (2) an
outsider that has seeded its own `CadrePeer` row passes the push-wake authorization gate
(`push-wake-e2e` non-member test — a non-member wakes a hibernating strand).

**Update (2026-07-03): decision made (Option B), spike done, implement chain filed.** The scope
question ("pull the deferred node-local trusted-owner anchor forward?") was routed to the human
via `blocked/membership-gate-authority-anchor-decision.md`, and the ticket's own "single
highest-value next step" — the empirical spike settling **Option A (cheap) vs B (robust)** — was run.
**Result: pollution CONFIRMED.** A focused two-`CadreNode` integration spike measured that a same-party
self-appointed-owner outsider's self-minted key replicates into a legitimate peer's *local*
`OwnerKey` table the instant they connect (Rx's table went 0 → 1 == O's key). So checking a
recorded voucher against the *replicated* `OwnerKey` table (Option A) is **unsound** — a correct
fix needs a **node-local, non-replicated trusted-owner anchor** (Option B). The spike also exposed
a second victim of the same false anchor: the "secure default" seed-trust policy sourced its trust
set from the same pollutable replicated table.

Human approved **Option B** with a connection-gater hardening layer folded in. Filed as a 6-ticket,
`prereq`-chained `implement/` set:
1. `membership-authorized-surface-split` — split the *addressable* set (dial/seed/fan-out, includes
   self) from the *authorized-member* set (wake gate, excludes self); no trust change. Fixes the
   fresh-party self-listing test.
2. `membership-cadrepeer-voucher-persist` — persist the vouching owner (`VouchOwner`/`VouchSig`)
   on each `CadrePeer` row (the sign/verify helpers in `peer-authorization.ts` already exist; the
   signature was just being discarded at write).
   - `membership-cadrepeer-authority-antireplay` (inserted 2.5) — persisting the voucher on a replicated
     row turned one signature over `digest(peerId)` into a lift-and-replay token for insert/delete/reauth.
     Fix: a `not null unique` `StampId` nonce per row and action-scoped digests — insert/reauth sign
     `digest(peerId, stampId)` (`cadrePeerVoucherDigest`), delete signs the distinct
     `digest(peerId, stampId, 'remove')` (`cadrePeerRemoveDigest`) — and the combined `check on insert,
     delete` splits into `AuthorizedInsert`/`AuthorizedDelete`, with `StampId`+voucher immutable on
     self-update. (Insert-replay after a delete frees the nonce; that residual is subsumed by #6's gater.)
3. `membership-node-local-authority-anchor` — build the node-local, non-replicated
   `TrustedAuthorityStore`, seeded out-of-band (genesis self-trust / invite-pinned keys); pulls the
   long-parked interim pinned-trust store forward.
4. `membership-authorized-predicate-and-gates` — `isAuthorizedMember` = voucher recorded ∧ its
   owner ∈ node-local anchor ∧ signature verifies ∧ not-self; routes the wake/strand-addr gates
   through it and reworks the cross-node convergence/push-wake tests to model real enrollment. **Closes
   the non-member wake hole.**
5. `seed-trust-anchor-from-local-store` — repoint seed-trust's `knownOwnerKeys` from the replicated
   table to the node-local anchor (closes the seed-acceptance variant of the same hole).
6. `membership-connection-gater` — defense-in-depth: reject the sensitive control protocols
   (control-DB repo / wake / strand-addr) from unauthorized peers at stream/connection time, with an
   enrollment carve-out (seed/accept-phone stay open to strangers).

**Update (2026-07-27): steps 1–4 have LANDED — the wake hole is closed.** `isAuthorizedMember`
is now the real predicate (not-self ∧ complete voucher ∧ `VouchOwner` in the node-local anchor ∧
signature verifies over `digest(PeerId, StampId)`), and both the push-wake and strand-addr
receivers consult it. Proven end-to-end in `push-wake-e2e` scenario 3: an outsider's self-minted
owner key plus self-vouched `CadrePeer` row are written into the receiver's replicated tables — so
`isMember` is TRUE — and the wake is still refused and the strand-addr RPC returns empty, until one
`trustOwnerKeys` pin flips the identical state to authorized. Enrollment supplies that pin in
production (`CadreInvite.ownerKeys` on the phone, `CADRE_OWNER_KEYS` / `--pin-owner-key` on a
CLI/donated node); a node with an empty anchor authorizes no one, by design.

**Step 5 has LANDED too.** Seed trust now reads the same node-local anchor: `SeedTrustContext.knownOwnerKeys`
comes from `TrustedOwnerStore.all()`, the default policy is `anchoredTrustPolicy` (renamed from
`dbAnchoredTrustPolicy` — the name asserted the wrong anchor), and a key sitting only in the replicated
`OwnerKey` table authorizes no seed. Two follow-ons rode along: a key accepted via a pin or a TOFU
confirmation is now **persisted** into the anchor (`SeedTrustDecision.anchorAs`), so enrollment supplies
the invite once rather than on every seed; and `createInvite` hands out the anchor's keys *and only* the
anchor's keys — never the replicated table's, not even as a fallback — since the invitee anchors whatever
arrives and a poisoned invite would defeat the whole chain. A service with no anchor wired therefore mints
an invite with no `ownerKeys`, which costs an extra out-of-band step rather than silently anchoring an
unvouched key. The replicated table survives only as the replication mechanism and as the `isOwner` dial
hint in seeds (and the matching owner-preference in `reconcileControlCohort`) — never as a trust anchor.
Backlog `seed-accepted-authority-persistence` was retired here: its persistence half landed, and its
`seed.transactions[]` half is `backlog/later/seed-warm-cache-prepopulation`.
Address resolution, push fan-out and the host trust-circle listing stay on the addressable surface
(`isMember`) deliberately — dialability is not trust — with the listing consequence tracked in
backlog `bug-host-trust-circle-lists-unauthorized-peers`.

**Step 6 has LANDED (2026-07-28) — connection-layer gate + stranger allowlist; the per-stream gate on
the Optimystic DB protocols is blocked upstream.** The control node now composes a membership
connection gater (`membership-connection-gater.ts`) onto any caller-supplied gater:
`denyInboundEncryptedConnection` refuses a peer that is positively NOT an authorized member once the
node is fully established (non-empty node-local anchor AND ≥1 authorized member) — an outsider is no
longer even in the conversation. It admits (fail-open, deferring to the fail-closed stream gates)
during every legitimate stranger path: an un-enrolled node (empty anchor / empty authorized set —
the seed-delivery and replication cold starts), an open enrollment window (`createInvite` opens it
for the invite's validity, `openEnrollmentWindow` for out-of-band flows), a registered
strand-formation responder (stranger-serving by design), and the configured bootstrap/relay
infrastructure peers. The stranger-open protocol allowlist (seed + formation, each with its own
in-protocol trust check) is documented in one place in that module. Outbound dials are never gated
(`resolvePeerAddrs`' trust policy already gates what gets dialed). Strand cohort nodes do NOT get
the membership gater — their peers are legitimately cross-party. What step 6 wanted but cannot have
yet: a per-stream `isAuthorizedMember` check inside the Optimystic control-DB protocols
(`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}`) — `@optimystic/db-p2p`'s services
expose no inbound-stream authz seam, so that half is filed as
`blocked/control-repo-protocol-stream-authz-optimystic` (upstream repo). Until it lands, the
connection gate is the outermost defense for those protocols and the read-time voucher predicate
(step 4) remains the real fix.

**Step-6 review (2026-07-28) found the formation exemption too wide to be worth much yet.** "A
strand-formation responder is registered" is a process-lifetime condition — only `stop()` clears the
service, `formStrand` opens it on the initiator side that never needs inbound strangers, and
`reference-app-rn` registers the responder during node bring-up. So on the phone reference app the
connection gate denies nobody, and the web app's gate opens permanently after the first formation
action. Nothing is unsafe (steps 4–5 still hold), but the defense-in-depth layer buys nothing on the
primary client until the exemption tracks *an unexpired open invitation outstanding* rather than
*capability to serve one* — `plan/narrow-formation-stranger-carveout`. The review also bounded the
admission decision (`ADMISSION_DECISION_TIMEOUT_MS`, 2s → admit): libp2p awaits
`denyInboundEncryptedConnection` **without** racing its inbound-upgrade timeout, so an unbounded
control-DB read there could wedge an inbound upgrade permanently and hold its connection-manager
slot — the opposite of the layer's fail-open contract.
- **Not** a super-majority-threshold rounding bug: `Math.ceil(2 * 0.75)` and the
  "fix" `Math.floor(2/2)+1` both yield 2 — 2-of-2 is correct for a 2-node quorum. The
  defect is upstream of the count (peer selection / protocol negotiation), and is
  optimystic-side networking work, not a one-line sereus change.

