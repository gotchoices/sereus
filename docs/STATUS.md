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
  - [x] `sereus/ops/docker/sereus-node/` — removed as a duplicate; see the "Superseded" note below (canonical template is `packages/cadre-cli/docker/docker-compose.yml`)
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
  - [ ] “Add a headless sereus-node to a cadre” (deferred; a real image/entrypoint exists now — `packages/cadre-cli/docker/` — this is just a missing quickstart doc, not a missing artifact)

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
  - [x] `relay?: boolean` in `NodeOptions` now wires a circuit-relay **server** (`circuitRelayServer(options.relayServerInit)` in `db-p2p`'s `libp2p-node-base.ts`); cadre sets it from `network.enableRelay`, defaulting on for the storage profile. Reserving a slot on someone else's relay is the other direction and needs no server: `network.relayAddrs` becomes a `/p2p-circuit` listen address (`cadre-core/src/relay-addrs.ts`).
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

- [x] **Superseded (2026-07-28):** `sereus/ops/docker/sereus-node` no longer carries its own
  compose/env template. It had drifted into a hand-maintained duplicate of the real one shipped
  with `@serfab/cadre-cli` (`packages/cadre-cli/docker/`, which already builds from a real
  `Dockerfile` — the "placeholder `SEREUS_NODE_IMAGE`" below is stale), so `ops/docker/sereus-node/`
  is now a pointer README to that canonical template
  (`tickets/complete/8-consolidate-duplicate-cadre-node-docker-templates.md`). It intentionally does
  **not** move to the `./svc`/`env.local` ops pattern used by relay/bootstrap — a `sereus-node`
  belongs to one user's cadre, not shared ops infra — so the sub-bullets below no longer apply.
  - [ ] ~~Replace the current placeholder `SEREUS_NODE_IMAGE` approach with either:~~
    - ~~a local-build Dockerfile + entrypoint (preferred, consistent with other ops/docker stacks), or~~
    - ~~an explicitly deferred “prebuilt image” doc.~~
  - [ ] ~~Refactor `env.example` to host-level knobs (`HOST_PORT`, `HOST_BIND_IP`, `HOST_DATA_DIR`) plus the minimum `sereus-node` knobs above.~~
  - [ ] ~~Update the compose file to use `./svc` and `--env-file env.local` workflow (same as relay/bootstrap).~~

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
  - Single-use approvals (`devicetoken-authority-antireplay`): the owner's insert approval covers the
    WHOLE row ending in its one-off `StampId`, the delete approval covers `(PeerId, StampId)` only, and a
    clear must retire the stamp into `Revocation` in the same transaction (`RevocationRecorded`) while an
    insert refuses an already-retired stamp (`NotRevoked`). `resolveDeviceToken` also drops a live row
    whose stamp is retired. The owner re-touch (`vouch`) update branch was removed — it rewrote the row
    outside the monotonicity guard, so an owner correcting a token deletes and re-inserts it. Covered by
    `control-devicetoken-stamp-constraint.spec.ts` (crypto-free truth table),
    `control-authorization-domain-separation.spec.ts` (cross-domain replays),
    `control-revocation-replay.spec.ts` (tombstone/`RowIsGone` branches), and
    `device-token-registry.spec.ts` (clear → re-register mints a fresh stamp; retired-stamp read gate).
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
- [x] Donated nodes hold a durable identity. Each one is written its own `identity.key` in its
  workdir on first spawn and re-launched with it (`orchestrator/node-identity.ts` →
  `--identity-protobuf`), so its peer id survives a restart and `cadre-cli start` opens the
  file-backed bootstrap-peer + trusted-owner stores beside it. `removeContainer` deletes the
  workdir, so all of it dies with the loan. The same gap on the multi-tenant provider has since
  been closed: `DockerOrchestrator` mounts a per-container named Docker volume at `/data` and
  `docker/entrypoint.sh` mints/exports the identity key into it on first boot, re-applying it
  every start — see [Durable Container Identity](architecture.md#durable-container-identity) and the
  "Cold-start bootstrap retries" bullet under [Control Network Seed](architecture.md#control-network-seed).
- [x] `DonationService` lifecycle (`provision` / `getPeer` / `applySeed` / `terminate` / `get` /
  `list`, exported from `@serfab/cadre-host`) — proven end-to-end by the integration test below.
- [x] **The multi-tenant provider's seed path now works end-to-end.** Previously `PUT /containers/:id/seed`
  delivered fine (bearer token) but every container refused the seed: nothing pinned an owner key, so the
  node fell back to its empty node-local anchor. `POST /containers` now takes `pinnedOwnerKeys` (array of
  base64url owner keys, validated as such and rejected with `INVALID_REQUEST` otherwise); they are recorded
  on the `Container` record, threaded through `ContainerService.provisionContainer` into
  `OrchestratorCreateRequest.pinnedOwnerKeys`, and injected by `DockerOrchestrator` as comma-separated
  `CADRE_OWNER_KEYS` — the same var cadre-host uses. **Strictly per-tenant, no provider-level default**
  (a shared pin would let one tenant's owner seed another tenant's node); a create with no keys is logged
  and still succeeds, but that container accepts no seed. First accepted seed anchors the key on the
  durable `/data` volume, so later seeds need no pin. Tested: `docker-orchestrator-push.test.ts` (env
  injection + omission), `container-owner-keys.test.ts` (forwarding, no default, cross-tenant),
  `create-container-owner-keys.test.ts` (route accept/validate). **Not yet covered**: a real node
  actually accepting a provider-delivered seed — `container-seed-endpoint.test.ts` stubs `fetch`, so no
  test exercises a live `SeedTrustPolicy` decision on the provider path.
- [x] Grantee-facing `/grants` provisioning surface + `bin/host.ts` wiring + stale-`awaiting_seed`
  reap sweep + `DonationService` unit tests (`donation/__tests__/donation-service.test.ts`, a fake
  orchestrator over a real on-disk store).
- [x] Stuck-`provisioning` reap sweep (`DonationService.reapStaleProvisioning`, 5-minute TTL, on the
  same startup + periodic trigger as the stale-`awaiting_seed` reap). A host that died between
  writing the `provisioning` row and finishing the spawn otherwise left that row live forever,
  permanently holding one slot of the grantee's node quota. Terminalizes the row to `error` and, when
  the orchestrator can still resolve the spawned child (`resolveDockerId`), stops and reclaims it.
  Covered by unit tests only — no integration-level crash/restart scenario.
- [x] Respawn of a crashed donated node. The record persists every spawn input and
  `DonationService.respawn(id)` replays it against the same workdir (so the node returns with its
  original peer id), and the orchestrator no longer strands the previous spawn's handle/ports. The
  `DonationSupervisor` now decides *when* to respawn — startup sweep, child-exit event, and a
  1-minute periodic sweep, with exponential backoff and a give-up-to-`error` path after 5 attempts —
  and is wired into `bin/host.ts` (see docs/cadre-host.md § Respawn). Exercised only against a fake
  orchestrator; a real respawned child rejoining the borrower's cadre is not yet covered by the
  cross-package integration scenario below. A `terminate` (or reap) that lands while a respawn's
  spawn is in flight now wins: `respawn` re-reads the record after the spawn and abandons its own
  child — stopping *and* reclaiming it — rather than overwriting the terminal write.
- [ ] WAN reachability for the request surface and per-donated-node NAT/relay mapping — deferred
  (`tickets/backlog/feat-cadre-host-wan-grant-reachability.md`); v1 donation is loopback-only.
- [x] Cross-package node-donation integration test (a real cadre-cli requester ↔ a donated node) —
  `packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts`, drives
  `DonationService` directly (5/5 steps green).

## Testing / CI

- [ ] Wire `@serfab/strand-proto` tests into workspace CI
- [x] **`reference-app-web` has a vitest unit suite** (`yarn test` → `vitest run`), previously e2e-only.
  First spec: `test/node-local-slots.spec.ts` covers `kvSlot` (the browser's `DurableSlot` over the
  control database's `kv` store) and its composition with the real `PersistentTrustedOwnerStore` /
  `PersistentBootstrapPeerStore` — the two node-local records' *policy* is covered once, in
  `packages/cadre-core/test/node-local-snapshot.spec.ts`, and is not re-asserted per platform.
  Still uncovered: `startCadre`'s own wiring of those stores into a running `CadreNode`.
- [x] **`reference-app-rn`'s node-local slots are unit-covered** —
  `packages/reference-app-rn/test/node-local-slots.spec.ts` covers the phone's two slots
  (`secureStoreSlot` over `expo-secure-store`, `kvStoreSlot` over `LevelDBKVStore`), the key-shape
  helpers as persistence contracts, each slot composed with the real store it backs, and the anchor
  slot living beside `SecureStoreKeyStore` in one secure store without entering its `__index`. The
  `expo-secure-store` double is shared with `secure-key-store.spec.ts` (`test/fake-secure-store.ts`).
  Same scope boundary as web: store *policy* is not re-asserted. Still uncovered:
  `startPhoneNode`/`stopPhoneNode`'s own wiring and the `sereus-node-local` LevelDB handle lifetime,
  which no unit test opens a real handle for.
- [ ] Add root-level scripts for running package tests consistently (Yarn workspace)
- [x] **Stale-build guard for `integration-tests`.** Every scenario there runs *compiled* cadre
  output — a spawned real `cadre-cli` child, or an in-process import of `@serfab/cadre-host` /
  `@serfab/cadre-core` from their `dist`. An edit to `src` with no following `yarn build` used to be
  invisible: the run silently exercised the previous build and surfaced as an unrelated 90s startup
  timeout. `test/global-setup.ts` (wired as vitest `globalSetup`) now calls `assertBuildFresh(TARGETS, import.meta.url)`
  once per suite, comparing each package's newest `src` mtime against the entry point the tests
  actually load (`dist/index.js` for cadre-core/cadre-host, `dist/bin/cadre.js` for cadre-cli), and
  fails the run up front naming every stale package plus its `yarn workspace <name> build` remedy.
  Test files (`*.test.ts`, `*.spec.ts`, `test/`, `__tests__/`) are excluded — they aren't build
  inputs. The guard itself is unit-covered by `test-harness/build-freshness.spec.ts`.
- [x] **Stale-build guard extended to the linked sibling workspaces.** The suite also runs compiled
  output from `../optimystic` and `../quereus`, which reach `node_modules` as symlinks via the root
  `package.json`'s `resolutions`. Those repos are developed concurrently, so the suite ran whatever
  they last *built* — which cost three re-investigations of an `@optimystic/db-p2p` replication bug
  whose fix had already landed but had not been rebuilt. `@optimystic/db-core`, `db-p2p`,
  `db-p2p-storage-fs`, `quereus-plugin-crypto`, `quereus-plugin-optimystic` and `@quereus/quereus`
  are now checked the same way, resolved through the `node_modules` symlink rather than the
  `packages/` scan, and a stale sibling fails the run with a remedy naming that sibling's own
  checkout (`yarn workspace` cannot reach outside this repo). A dependency that is a real directory
  rather than a symlink — i.e. installed from the registry — is **skipped**, never judged: its `src`
  and `dist` mtimes are packing artifacts (the copied `db-p2p-storage-fs` has `src` 13ms newer than
  `dist`) and would report a permanent, unfixable "stale".
- [x] **Stale-build guard shared, and extended to `cadre-core`.** The same false-green happened in
  `packages/cadre-core`'s own suite: `@serfab/quereus-plugin-sereus` resolves through a
  `node_modules` symlink whose manifest points at `dist`, so a new control-database table added to
  its `src` was silently absent from the database under test while 938 tests reported passing. The
  guard therefore moved out of `integration-tests` to `test-harness/build-freshness.ts` at the repo
  root, exporting `assertBuildFresh(targets, setupUrl)`; each consuming package owns its own target list in its
  own vitest `globalSetup` file (`packages/integration-tests/test/global-setup.ts`,
  `packages/cadre-core/test/global-setup.ts`, `packages/reference-app-web/test/global-setup.ts`). The guard caught a real
  stale `cadre-core` dist the first time it ran there. The module is imported by relative path, not as a
  workspace package, and is never built — a compiled shared package would be consumed from its own
  `dist` and so could be defeated by exactly the staleness it exists to catch. `test-harness/` is
  marked ESM by its own `package.json` (the root manifest has no `"type"`) and is excluded from knip's
  root workspace, since its `vitest` import belongs to the consuming packages.
- [x] **Target lists pinned against their manifests.** Those per-package lists are hand-written, so a
  dependency added tomorrow would go unguarded in silence — the same false green, back again.
  `test-harness/build-targets.ts` derives what each package actually runs from a rebuildable `dist`
  (a `workspace:` range, or a name the root `resolutions` points at with `link:`; registry copies are
  excluded, since the guard skips those anyway) and reports anything the list misses or files under
  the wrong `location`. Each consuming package asserts on it from its own suite
  (`packages/*/test/build-targets.spec.ts`), so drift fails that package's own `yarn test`. A list may
  be *wider* than its `dependencies` — `integration-tests` guards `cadre-cli`, `cadre-provider` and
  `quereus-plugin-sereus`, which it reaches transitively — so coverage is checked, not equality.
- [x] **Stale-build guard wired into `quereus-plugin-sereus`, `cadre-cli`, `cadre-host`.** The same
  `test/global-setup.ts` + `build-targets.spec.ts` pair now guards these three suites too, each with its
  own target list built by `distBackedDependencies`/`targetListProblems`, same as `cadre-core` and
  `integration-tests` above. `quereus-plugin-sereus` has no `@serfab/*` dependency of its own, so its
  list is linked-only (`@optimystic/*`, `@quereus/quereus`); it is wired into **both** its `unit` and
  `e2e` `vitest.config.ts` project blocks, since Vitest 4.1.8 does not run a project-array-sibling's
  `globalSetup` unless each project block sets it itself. `cadre-cli` pins `@serfab/cadre-core` (real,
  non-mocked symbols land in its specs) plus the linked siblings `cadre-core` already guards. `cadre-host`
  reaches `@serfab/cadre-cli`, `@serfab/cadre-core`, `@serfab/cadre-provider` and
  `@serfab/quereus-plugin-sereus` only through `workspace:` ranges (no `link:` entry of its own — the
  `@optimystic`/`@quereus` packages arrive transitively through `cadre-core`), and its guard files live
  beside its tests under `src/__tests__/` rather than a package-root `test/`, since that is where
  `cadre-host`'s specs already live. `cadre-provider` was evaluated and deliberately left unwired: it has
  zero `workspace:`/`link:` dependencies of its own, so there is nothing for the guard to check. Each of
  the three new packages' `tsconfig.typecheck.json` gained the same `rootDir: "../.."` already carried by
  `cadre-core`'s (TS6059 otherwise, since the new files import `test-harness/` above the package root);
  `cadre-host`'s `tsconfig.build.json` additionally excludes `src/__tests__/global-setup.ts`, the only one
  of the three whose test setup lives under `src` where the build's own `include` would otherwise sweep
  it into `dist`. Pulling `test-harness/build-targets.ts` into `quereus-plugin-sereus`'s typecheck program
  this way surfaced that its own `tsconfig.json` was the one package among these four still missing the
  `lib: ["ES2022", ...]` bump for `Error(message, { cause })` — added to match `cadre-core`/`cadre-cli`/
  `cadre-host`.
- [x] **The per-package target-list spec is shared, not copied.** Wiring three more suites had turned one
  ~40-line spec body into five verbatim copies differing only in the suite's name, its package root and
  the two dependencies it pins. `test-harness/build-targets-spec.ts` now exports
  `describeBuildTargets(suiteName, { packageDir, targets, expectFound })` plus a `packageRootFrom`
  helper, and each package's `build-targets.spec.ts`/`.test.ts` is a doc comment and one call — the
  comment still says why *that* list is wider than its own `dependencies`. `expectFound` takes a
  name→origin map instead of two hand-written `expect`s, so a failed pin now names the package. Note the
  one package with no guard at all: `cadre-provider` declares zero `workspace:`/`link:` dependencies, so
  nothing here would flag its omission if it ever gains one — a `NOTE:` in its `vitest.config.ts` says
  so at the site.
- [x] **`linked` targets resolve through the real `node_modules` chain.** The guard used to look for a
  linked sibling in the repo root's `node_modules` and nowhere else, which goes blind for any package
  that keeps its own copies: the reference apps set `installConfig.hoistingLimits: "workspaces"`, so
  yarn installs their `@optimystic/*` / `@quereus/*` into `packages/<app>/node_modules`, and that is
  what their suites load. `resolveLinkedPackageFrom(fromDir, packageName)` now walks `<dir>/node_modules`
  from the calling `global-setup` module's directory up to the monorepo root **inclusive** (a
  `node_modules` above the root is never consulted), and the first directory holding an entry wins
  whatever that entry is — a registry copy or a dangling link ends the walk rather than "recovering" to
  the root, because Node would load the near copy and judging the far one reports on code that never
  runs. `resolveLinkedPackage` classifies a single directory and gained an `absent` state so the walker
  can tell *keep looking* from *found and unusable*; when the whole chain comes up empty the message
  names every directory searched. `assertBuildFresh(targets, setupUrl)` therefore takes the caller's
  `import.meta.url` as a **required** second argument — a default would silently reinstate the blind
  spot — and all six call sites pass it.
- [x] **`reference-app-web`'s target list completed and pinned.** It had been a single entry
  (`@serfab/cadre-core`) with no `build-targets.spec.ts`, because until the `node_modules` walk above
  landed the guard could not see that package's own hoisting-limited copies of the linked siblings. It
  now lists all eight packages its suite runs compiled code from: the `@optimystic/*` and
  `@quereus/quereus` siblings it declares, plus `@serfab/quereus-plugin-sereus` and the two
  `@optimystic/quereus-plugin-*` packages it never declares but loads anyway — importing `cadre-core`'s
  entry point evaluates `cadre-node.js`/`control-database.js`/`strand-database.js`, which import them
  statically. Its `@serfab/cadre-core` range moved from `*` (an npm range yarn happened to satisfy from
  the workspace) to `workspace:^`, without which `distBackedDependencies` cannot classify it and the
  drift spec would pass having checked nothing. `@optimystic/db-p2p-storage-web` is guarded even though
  the current specs import it only as a type: it is a declared, link-resolved dependency the app itself
  runs, and the drift spec checks the manifest, not the import graph. `reference-app-rn` remains the one
  app with no guard at all, despite its `node-local-slots.spec.ts` importing real `cadre-core` symbols —
  see backlog `debt-reference-app-rn-build-guard`.
- [x] **Sequential integration runs restored.** `packages/integration-tests/vitest.config.ts` used
  `test.poolOptions.forks.singleFork`, which **Vitest 4 removed** — the setting was silently ignored
  and scenario files ran in parallel despite binding real network ports. Now expressed as top-level
  `pool: 'forks'` + `fileParallelism: false` (66s parallel → ~370s sequential confirms it takes
  effect). `vitest.config.ts` was also added to that package's `tsconfig.typecheck.json` so a future
  option removal fails `yarn typecheck` rather than degrading silently.

### Type-check coverage

`yarn typecheck` (root) now fans out to **every** TS workspace, not just `reference-app-web`.
Each package defines a `typecheck` script (`tsc --noEmit`) so type validation no longer depends on
the slower `yarn build`, and test files are type-checked where possible (vitest itself never type-checks).

- [x] Every TS package has a `typecheck` script; `yarn typecheck` validates all 10 workspaces (was 1 of 9,
  before `reference-app-ns` landed)
- [x] Every package that **has** a `vitest.config.ts` also has that file inside its `typecheck` program, so a
  Vitest option the installed version no longer recognizes fails `yarn typecheck` instead of sitting
  silently unused (this bit once: a `test.poolOptions.forks.singleFork` removal in Vitest 4 went
  unnoticed for a whole major-version upgrade — see "Sequential integration runs restored" above).
  Covered via `tsconfig.typecheck.json` (`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`,
  `quereus-plugin-sereus`, `strand-proto`, `integration-tests`) or the package's main `tsconfig.json`
  (`reference-app-rn`, `reference-app-web`). `reference-app-ns` is the tenth workspace and has no
  `vitest.config.ts` at all yet (see `debt-ns-unit-test-harness`), so nothing to include there.
  Verified by injecting an unknown key into each of the nine configs and confirming `TS2769
  … does not exist in type 'InlineConfig'` — including keys nested inside `test.projects[].test`
  (`ProjectConfig`), which is where the `poolOptions` precedent lived.
  Enforced going forward by `scripts/check-vitest-typecheck-coverage.mjs` (`yarn check:vitest-typecheck-coverage`,
  chained into root `yarn typecheck`): for every `packages/*` holding a `vitest.config.{ts,mts,cts}`,
  it reads that package's `typecheck` script, extracts the tsconfig(s) it invokes (`-p`/`--project`,
  falling back to `./tsconfig.json`), asks the TypeScript compiler API which files those actually
  resolve to (`ts.getParsedCommandLineOfConfigFile`, which follows `extends` and expands
  `include`/`exclude` — robust against `include` reaching the file by directory, glob, or not at all),
  and fails naming the package if the config file is absent from that resolved list. Silent about
  packages with no vitest config. `scripts/check-vitest-typecheck-coverage.test.mjs`
  (`yarn test:vitest-typecheck-coverage`, chained into root `yarn test`) proves the guard catches
  drift — not just that it passes today — with 16 throwaway-fixture workspaces covering: the config
  dropped from `include`, `typecheck` repointed at a build config that omits it (the second
  regression mode above), a `.mts`-renamed config, `--project`/`-p` in either position, two `-p`
  flags where only one program covers the file, a bare `tsc --noEmit` defaulting to `./tsconfig.json`,
  a glob `include` reaching the file implicitly, a missing or non-`tsc` `typecheck` script, and a
  `typecheck` script pointing at a missing config.
- Per-package scope:
  - Source **+ tests**: `cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`, `integration-tests`,
    `quereus-plugin-sereus` (via `tsconfig.typecheck.json`), `reference-app-rn`,
    `reference-app-web` (`test/**/*.ts` + `vitest.config.ts` are in its `tsconfig.json` `include`; the Playwright
    specs stay in `tsconfig.e2e.json`, checked by the separate `typecheck:e2e` script — which is chained into
    that package's `build`, **not** into root `yarn typecheck`, so the fast gate does not cover them)
  - Shippable **source only**, via a dedicated `tsconfig.typecheck.json` that also includes
    `vitest.config.ts` (kept separate from the real `tsconfig.build.json` so widening the typecheck
    program can't change what `yarn build` emits or where): `strand-proto` — deprecated, and it has no
    test files anyway, so nothing is hidden by the narrower program
  - `reference-app-ns` type-checks its whole `tsconfig.json` program (`tsc --noEmit -p tsconfig.json`) and has
    no test files yet (see `debt-ns-unit-test-harness`)
- Known coverage gaps:
  - `cadre-host` `ui/` (Svelte) and `reference-app-web` `.svelte` files are **not** covered — `tsc` can't type-check
    `.svelte`; that needs `svelte-check` (already a devDependency in both). Not wired into `typecheck` yet.
    `cadre-host`'s `ui/__tests__/*.ts` test files (not `.svelte`) **are** covered, via a second `tsc` pass over
    `ui/tsconfig.json` chained into the package's `typecheck` script. That config's `include` also lists
    `src/**/*.svelte`, which plain `tsc` silently ignores — the entry is there for `svelte-check`, not for this pass.
  - The seven `tsconfig.typecheck.json` files are near-identical (`extends ./tsconfig.json`, widen `rootDir`,
    `noEmit`, list `vitest.config.ts`). There is no shared base config in this repo — each package's
    `tsconfig.json` is hand-duplicated too — so the boilerplate is consistent with existing practice rather
    than new debt. If a compiler option ever has to change across all of them at once, that is the point to
    introduce a root `tsconfig.base.json` and have every package extend it.

### Dependency-check coverage

`yarn dep-check` (root) is now a **real** gate. It was previously a no-op (`workspaces foreach -A run dep-check`
with no package defining the script, exiting 0 in ~0s). It now runs [knip](https://knip.dev) from the repo
root against a single config (`knip.ts`, Option A) covering the workspaces listed in it.

- [x] **The gate exits 0 with no knip configuration hints.** It had exited 1 since `reference-app-ns` landed:
  NativeScript resolves page modules by string (`app-root.xml` `defaultPage`, runtime `Frame.navigate`), so
  knip's only auto-detected entry (`app/app.ts`, from `main`) reached almost nothing and 13 real deps looked
  unused. `knip.ts` now declares that package's real entry points — the `*-page.ts` pages, the webpack-only
  polyfills/shims, `nativescript.config.ts`, and the manual `solo-smoke.ts` helper — so the whole `src/` graph
  is genuinely analysed rather than excluded.
- [x] `dep-check` detects unused, missing (phantom/unlisted), and unresolved deps/binaries across all workspaces.
- Gate semantics (`knip.ts` `rules`): dependency-class issues are `error` (fail the gate); dead-code classes
  (unused **files / exports / types**) are `warn` (surfaced but non-blocking). Cleaning the existing dead-code
  backlog (~15 files, ~40 exports, ~29 exported types, mostly in the reference apps and host UI) is **deferred** —
  out of scope for the dep-check ticket.
- Phantom deps fixed (added as direct deps where production/test code imports them transitively):
  `@multiformats/multiaddr` (cadre-core, integration-tests, reference-app-rn), `@libp2p/crypto` + `@libp2p/interface`
  (cadre-cli, cadre-host), `@libp2p/peer-id` (cadre-cli, cadre-host, reference-app-web — the last a test-only
  `devDependency`, and like `reference-app-ns` it sets `installConfig.hoistingLimits: "workspaces"`, so a
  transitive resolution there is not a resolution it may rely on), `@vitest/coverage-v8` (cadre-core,
  integration-tests, quereus-plugin-sereus, strand-proto — coverage is configured in their vitest configs), and
  `@noble/ciphers` + `@noble/curves` (reference-app-ns — `src/shims/noise-crypto.js` imports both directly and
  only built because `@chainsafe/libp2p-noise` happened to install them; that package sets
  `installConfig.hoistingLimits: "workspaces"`, so it must not lean on root hoisting).
- Truly-unused deps removed: root `esbuild` + `svelte-eslint-parser` (the latter arrives as a real dependency of
  `eslint-plugin-svelte`), `aegir` (cadre-cli/core/provider — no longer used now that build/test run
  `tsc`/`vitest` directly), `@serfab/cadre-core` from cadre-provider (never imported),
  `@libp2p/peer-id-factory` from cadre-core (only strand-proto uses it, and declares it itself), and
  `@noble/hashes` from integration-tests.
- Documented framework/dynamic false-positive ignores live in `knip.ts` with rationale: Expo/Metro-implicit
  (reference-app-rn), Vite-config-implicit (reference-app-web), webpack-config-implicit plus the NativeScript
  platform runtime and the global `ns` CLI binary (reference-app-ns), dynamic-`import()`/runtime-`resolve` deps
  (cadre-host: nat-port-mapper, qrcode-terminal, cadre-cli bin), and runtime-registered Quereus plugins
  (integration-tests). Non-workspace trees (`tess/`, `ops/`, `docs/`, `scripts/`) are ignored.
- Only `warn`-class output remains on a green run: the dead-code backlog above, plus one `Duplicate exports` hit
  on `reference-app-ns/src/shims/noise-crypto.js` — intentional, since that shim binds all four of upstream's
  export names (`pureJsCrypto`/`nodeCrypto`/`asCrypto`/`defaultCrypto`) to the same pure-JS object so it can
  stand in for `@chainsafe/libp2p-noise`'s node-crypto module.

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
- **Project-specific invariant rule:** `no-restricted-syntax` flags a literal `insert into` /
  `update` / `delete from` against `CadreControl.CadrePeer` outside `control-database.ts`. Every
  membership write must run through `ControlDatabase.mutateCadrePeer` (which refreshes the
  authorized-member snapshot the control-stream gate reads); raw SQL skips it silently, a mistake
  made twice before the writers were consolidated. Matches both plain-string and template SQL;
  SQL assembled from variables is out of reach by design. Exempt: `control-database.ts` (the
  destination) and the two constraint fixtures that drive raw SQL at a bare database
  (`control-authorization-domain-separation.spec.ts`, `control-revocation-replay.spec.ts`).
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

### Declared dependency range vs linked workspace (a real coverage gap — keep them equal)

Root `package.json` `resolutions` maps every `@optimystic/*` and `@quereus/quereus` import to the
**linked sibling workspace** (`link:../optimystic/...`, `link:../quereus/...`). So *nothing in this
repo ever exercises the version a consumer installs* — that comes from each package's declared
`dependencies` range. When the two drift, a regression on the published floor is invisible here.

That drift caused a real report: `@serfab/cadre-core` 0.9.0 declared `@optimystic/*: ^0.14.1` while
the workspace linked 0.16.x, so an embedding app installed a substrate two minors behind everything
this repo tests against, and hit a solo control-DB hang we could not reproduce.

- [x] **Rule: bump the declared range in lockstep with the linked workspace version.** As of
  2026-07-29 all seven optimystic-consuming packages (`cadre-core`, `cadre-cli`,
  `quereus-plugin-sereus`, `integration-tests`, `reference-app-{rn,web,ns}`) declare
  `@optimystic/*: ^0.17.0`, and the six of those that also declare `@quereus/quereus` (all but
  `cadre-cli`, which reaches Quereus only through `cadre-core`) declare `^4.5.0` — matching both the
  linked workspace and the newest npm release (verified against the registry 2026-07-29). The `@optimystic/*` half was a genuine gap — for a `0.x` version `^0.16.3`
  *excludes* 0.17.0, so the declared range omitted the four `db-p2p` replication fixes and the
  inbound-stream authorization seam this repo builds and tests against. The `@quereus/quereus` half was
  floor tracking only; `^4.4.0` already admitted 4.5.0.
- [x] **Gate: `yarn dep-check` now also runs `scripts/check-dep-ranges.mjs`** (`dep-check` is
  `knip && yarn check:dep-ranges`), so this drift can no longer recur silently — it landed twice
  before this existed. For every root `resolutions` entry that is a `link:` target, the script reads
  the linked sibling workspace's `package.json` version, then walks every `packages/*/package.json`'s
  `dependencies` / `peerDependencies` / `optionalDependencies` and fails if a declared range does not
  admit that version (`semver.satisfies`), printing the package, the field, the declared range, the
  linked version, which direction it drifted, and a suggested `^<linked version>` edit. It is generic
  over whatever `resolutions` contains — not hardcoded to `@optimystic/*` — so it also covers
  `@quereus/quereus`, and any future linked package for free. If a linked sibling workspace directory
  is absent (e.g. a clean CI clone with no `../optimystic` checkout), that entry is skipped with a
  logged notice rather than failing. Correctly treats the `0.x` vs `1.0+` caret boundary (`^0.16.3`
  excludes 0.17.0; `^4.4.0` admits 4.5.0) since it defers to `semver` rather than a naive floor
  comparison. `scripts/check-dep-ranges.test.mjs` (`yarn test:dep-ranges`, chained into root
  `yarn test`) covers both caret-boundary directions, the "declared newer than linked" direction,
  the absent-sibling skip, a clean pass, multiple drifted ranges reported in one run across all three
  dependency fields, a non-`link:` resolution being ignored, and the two unparseable-input cases (a
  non-semver declared range such as `workspace:^`, and a malformed sibling version) reported as
  readable failures rather than a crash — each against a throwaway fixture workspace (not this
  repo's own packages) via `DEP_RANGE_CHECK_ROOT`.
- `yarn upgrade:optimystic` / `yarn upgrade:quereus` (npm-check-updates) rewrite the declared ranges;
  run them when the sibling workspace is bumped, not only at release time.
- Note `@optimystic/db-p2p-storage-fs` has **no** `resolutions` entry, so it always resolves from the
  registry — it is the one substrate package whose declared range is exercised here, and the only one
  a range bump actually re-fetches (0.16.3 → 0.17.0 changed its `yarn.lock` checksum; every other
  `@optimystic/*` entry moved metadata only). Earlier it was stuck at 0.14.1 while everything around
  it ran 0.16.x. NOTE: that makes it the one package whose *resolved* version can silently trail its
  linked siblings — it is consistent at 0.17.0 today only because 0.17.0 is published. The moment the
  sibling checkout carries an unpublished version, this package runs an older build against newer
  `db-core`/`db-p2p`. If that mix ever produces a confusing failure, add a `resolutions` entry for it
  like the other storage backends have.
- NOTE: the published packages declare `@quereus/quereus` as a regular `dependency`, not a
  `peerDependency` — including `quereus-plugin-sereus`, which is loaded *into* a Quereus host. Ranges
  agree today, so installers dedupe to one copy. If a consumer ever pins a Quereus major that our
  range does not admit, they get two Quereus instances and cross-instance `instanceof` checks start
  failing; move to `peerDependencies` at that point.

### Control DB liveness: solo (cadre-of-one) and known-but-offline peers — supported and covered

A **cadre of one** — a node whose only member is itself, the normal first-run state of every
embedding app — is a supported configuration. Its single node is the whole membership and the sole
authority over its own control data, so control reads and writes must complete from local state
without consulting a network it knows is empty. The same holds one step up: a cadre of **more than
one** whose known siblings are currently unreachable must answer control reads and writes from
local rows (Optimystic downsizes a cohort it cannot fill) — never hang, and never return empty
where local rows exist.

- [x] `packages/cadre-core/test/control-database-solo.spec.ts` — the **non-listening** solo shape that
  mobile and browser embedders actually configure: WebSockets-only transports, `listenAddrs: []`,
  `bootstrapNodes: []`. Covers genesis → read-back (typed API *and* raw `select`) → a post-genesis
  solo write (`registerSelf`) → read-back, for **both** the `transaction` and `storage` profiles, plus
  a warm restart on the same identity + block storage (the catalog-hydrate path) that re-reads its
  rows and writes again.
- [x] `packages/cadre-core/test/control-database-genesis.spec.ts` — the **listening** solo shape
  (default TCP `listenAddrs`, default transports), i.e. the server/CLI posture. A matched pair with
  the spec above, not a duplicate: a node with no listen address cannot be dialed back, which is where
  a cluster/cohort round-trip would hang rather than fail.
- Every control operation in the solo spec runs under an explicit per-operation deadline that **fails
  the test naming the operation** (`solo control op <operation> timed out after <ms>ms`). A bare `await`
  on a hung control call would instead blow vitest's own timeout and report nothing diagnosable. Keep
  that pattern when extending the spec. The deadline is `control-stream.ts`'s `withTimeout` — the same
  primitive the formation / wake / strand-addr protocols use — now covered directly by
  `packages/cadre-core/test/control-stream-timeout.spec.ts` (previously it had no direct tests at all,
  so a regression in it would have silently downgraded every caller from "fails with a label" to
  "hangs until some outer timeout").
- [x] `packages/cadre-core/test/control-database-offline-peers.spec.ts` — a cadre of **more than
  one** whose known siblings are all unreachable (the phone + laptop most of the day). Two offline
  flavours: **departed** (a real second node's published address, dead after `stop()` — connect
  refused) and **blackhole** (RFC 5737 TEST-NET-1 — connect never answers, where a freeze would
  live). Full control read/write table under per-op deadlines for both profiles, contents asserted
  (an empty read where local rows exist is the same failure class as a hang) — both write
  directions, `authorizePeer` (owner-vouched INSERT) and `removePeer` (stamp-retiring DELETE,
  including the already-absent re-run), each read back separately and each checked against the
  write-while-alone queue; an awaited `reconcileControlCohort()` that resolves despite dead dials;
  a **warm restart** on stored rows, where the sibling is on record before `start()` so the eager
  reconcile pass dials a dead address while the first reads run; three-sibling sequential-dial cost
  (~10 s per blackhole dial, js-libp2p's default, measured ~30 s for three); a concurrent
  in-flight pass grinding through dead dials that cannot block local ops (the dials themselves are
  sequential); `stop()` bounded with a dial in flight; and a
  circuit-relay transport variant. Shared harness with the solo spec:
  `test/control-db-node-helpers.ts`. WebRTC-in-the-transport-set is deferred — see backlog
  `debt-webrtc-transport-control-liveness-coverage`.
- [x] `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
  — the third flavour, the one the two specs above cannot reach: a sibling that is **connected and
  inside the cohort** but slow or silent, so it counts against the 0.75 approval bar instead of
  being downsized out of it. Real three-node trio over localhost websockets, with cohort discovery
  and coordinator assignment forced (`harness/forced-cluster.ts`) because FRET's routing table stays
  cold inside a test's lifetime; degradation is injected by re-registering the third node's cluster
  protocol handler behind a delay or a never-answer hold, so everything else about that node stays
  honest. Covers the healthy trio, a 2 s per-RPC delay (commits, ~55 s — see `architecture.md` on
  why a small per-RPC delay becomes a large per-write one), a never-answering member (clean named
  super-majority failure, both write directions, neither queued for re-replication nor left
  half-applied), and post-failure recovery. Latency figures and the uncovered
  degraded-node-is-coordinator branch are in `architecture.md`. One case is a standing `it.fails`
  reproducer for `fix/control-reads-blocked-by-stalled-write`: local control reads on the writing
  node block behind an in-flight stalled write. Runtime ~185 s.
- [x] `packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts` — the
  counterpart that uses **real** cohort discovery instead of forcing it: it proves a control write
  was offered to more than the machine that issued it. A control write that merely passes cannot
  tell "three machines agreed" from "one machine wrote to itself" (a one-member cohort commits on
  the writer's own vote), so every claim of multi-machine consensus has to establish the cohort
  size separately — `harness/control-cohort.ts` (`waitForControlCohort`, `observeControlCohorts`).
  Three cases over owner-plus-two-drone parties: the owner's peer ring reaches all three machines
  while a **drone's caps at two forever** (drones dial only the owner, never each other, so no
  amount of waiting adds the third — asserted on the observed size, not merely on "it threw"); a
  real `createStrand` into a *waited* three-machine cohort (commits, ~0.7–1.0 s, read back by
  strand id); and the same write into a *forced* cohort (~0.2–0.4 s). Healthy three-machine writes
  clear the unanimity bar comfortably every run — the unanimity fragility (and the bounded retry
  that now absorbs its transient half, `architecture.md` → "Replication cluster size") is
  about a member that is slow or silent, which is the file above, not about three healthy machines.
  Runtime ~24 s.
- [x] `packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts`
  — party-wide strand removal reaches the OTHER side: two real nodes, owner A publishes a strand,
  sibling B discovers it over the wire (`strand:discovered` — B is deliberately not an owner, so
  the sighting proves a network read), runs it (`mode: 'bootstrap'`), and stops it exactly once
  when its 1 s watcher poll observes A's `unpublishStrand` delete — the first proof anywhere that
  a control-plane DELETE becomes visible to a sibling reader (the two-node convergence scenario
  proves an INSERT; the degraded-cohort scenario reads `removePeer` back on the writer). A
  five-poll quiet window pins exactly-once / no re-add; a re-publish is then rediscovered, proving
  the watcher cleared the id and the removal's `Revocation` tombstone is not read back as a live
  row. Test body ~25–30 s.
- [x] `reference-app-web` boots solo end-to-end in Playwright (`e2e/solo/boot.spec.ts`,
  `e2e/solo/diagnostics.spec.ts` — the latter asserts owner self-genesis reaches `genesis|existing`).
  `reference-app-ns` has a solo entry point (`startSolo`) and needs no owner genesis.
  `reference-app-rn` cannot be booted headlessly; its network config is byte-for-byte the shape the
  cadre-core solo spec covers.
- Open shape: the reference apps `await` control operations with **no deadline** (RN `startPhoneNode` →
  `runOwnerGenesis`; web `runOwnerGenesis`; web diagnostics `queryCadrePeers`). Their `try`/`catch`
  guards catch rejections, not a call that never settles. Nothing hangs today, so no per-app deadline
  was added — see the `NOTE:` comments at those three sites. If a control operation can hang again,
  bound it inside cadre-core so every embedder benefits, rather than time-boxing each call site.

### Control DB local write serialization — covered

Every public writer on `ControlDatabase` runs through its process-local write queue
(`withWriteLock` / `execWrite`), so two of a node's own components never interleave mid-statement —
see [`architecture.md` → Local write serialization](architecture.md#local-write-serialization).

- [x] `packages/cadre-core/test/control-write-lock.spec.ts` — mutual exclusion and call order on
  `withWriteLock` itself, raced strand inserts, a bare write raced against two transactional
  `CadrePeer` mutations, both orderings of the self-publish/authorize first-row race (exactly one
  row, no UNIQUE violation, and the insert reporting whether it won the seat), and a rejecting
  locked body followed by a normal write.
- That race spec pins the lock/uniqueness contract only. Recovery from a LOST race — the
  self-publish seeing the authorize's `Sig`-null row and falling through to a self-UPDATE instead
  of waiting a heartbeat — is covered end-to-end in
  `packages/cadre-core/test/peer-record-resolution.spec.ts`: both orderings, plus the row being
  REMOVED between the lost insert and the fall-through's re-read (the publish reports `skipped`
  rather than signing against a row that is no longer there).
- Recovery from a lost race is also covered for `FormationUsage.UseNumber`: two redemptions of one
  invitation racing for the same use number are retried under `ControlDatabase.withUseNumberRetry`,
  re-presenting the SAME approver sign-off rather than asking a second time — see
  `packages/cadre-core/test/control-formation-use-number-retry.spec.ts` (19 cases: the classifier
  against real engine errors, concurrent `recordUsage`/`redeemInvitation` races landing sequential
  use numbers with the hook asked exactly once, rollback on both a pre-commit and a commit-time
  loss, attempts bounded at 3, and an exhausted invite raising `InvitationExhaustedError` instead
  of retrying forever — on a first attempt for a same-node race as well as on a spent retry, and
  through the recorder, which passes the seat budget down rather than re-reading it).
- The direct `withWriteLock` case exists because the real writers cannot pin the contract on their
  own: control writes are fast in-memory statements and Quereus serializes each one internally
  (`Database._withMutex`), so a unit-scale race between two of them completes the first before the
  second starts and passes with or without the lock. Only a body that spans a timer forces the
  overlap. Keep that case when extending the spec.
- Gap: the torn-transaction interleave the lock also prevents is asserted only by the
  `strand-addr-seed-convergence` integration scenario — no unit reproduces it deterministically.

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
8 pass — Phase 2 storage+storage now green), `strand-membership-closed-strand-e2e` **1/1 pass** (its
only test at that date; the file has grown to **five** tests since — the joiner-authored join
2026-07-30, then physical block replication and manager-actions-from-the-second-node 2026-07-31.
Four of the five are currently **intermittent** on a platform fault outside this repo, tracked as
`blocked/strand-unique-index-sync-stale-revision`), and
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
- Gaps noted (not bugs): no CLI surface to **create a strand** (`cadre strand` is
  list/remove only) or to **export a `ControlNetworkSeed`** (admin exposes `/admin/invites`
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
- [x] **An operator can now enroll the approver key a `ValidationUrl` invitation needs (2026-07-30).**
  The redemption side was already wired and unit-tested: `ControlFormationUsageRecorder` reads the
  invite's `ValidationUrl`, calls the approval hook with the redemption nonce the joiner minted,
  and writes the sign-off with the `FormationUsage` row on both redemption paths; failures map to distinct
  joiner-visible rejection reasons and consume nothing (`strand-formation-consent.spec.ts` cases
  (h)–(k)). The missing other half — the control database only accepts a sign-off from a key
  present in the `ValidationKey` table — landed as `feat-validation-key-enrollment`:
  `ControlDatabase.queryValidationKeys`, `CadreNode.enrollValidationKey` /
  `removeValidationKey` / `listValidationKeys`, and the `cadre validation-key add|remove|list`
  command (`validation-key-enrollment.spec.ts` 9/9, `validation-key.spec.ts` in cadre-cli).
  The HTTP approver itself now runs against a real server: `formation-approval-real-fetch.spec.ts`
  (integration-tests, 2026-07-31) drives `createHttpFormationApprover()` with the real
  `globalThis.fetch` against a throwaway `node:http` hook — approval, refusal, 5xx, redirect,
  connection failure, caller abort, mid-body timeout, and the 64 KiB streaming cap. That run
  surfaced a real defect, **since fixed (2026-07-31)**: Node's `fetch` sometimes drops the client's
  abort mid-body-read, so a silent hook could hold a responder ~5 minutes on a 10 s budget. The
  client no longer relies on the abort alone — one per-request budget (`startBudget` in
  `formation-approval.ts`) races a deadline against every await that can outlive it (the `fetch`,
  each stream `read()`, and the readerless-path `text()`), while still aborting to hand the socket
  back where that works. Covered deterministically in `formation-approval.spec.ts` by a stub whose
  body never settles and ignores aborts.
  The full path now runs end to end (2026-07-31): `strand-formation-e2e.integration.ts` Phase 5
  redeems a `ValidationUrl` invitation over real libp2p against a real `node:http` approval hook
  (`harness/fixtures/approval-hook-server.ts`) through the recorder's DEFAULT HTTP approver — happy
  path (including that the hook is posted the five signed fields and nothing else), hook refusal
  with the seat provably still spendable, an unenrolled approver key, a key removed after the
  invitation went out, and a replayed sign-off. Enrollment also accepts any non-blank text as a
  key (no base64url/length check), so a typo enrolls silently — `backlog/debt-control-key-enrollment-accepts-malformed-keys`.
  Invitations without a `ValidationUrl` (every e2e above) are unaffected.
- [x] **A party owner can now remove a shared strand party-wide (2026-07-30).**
  `CadreNode.unpublishStrand` — the first caller of `ControlDatabase.deleteStrand` — deletes the
  party's owner-signed `Strand` row (tombstoning its stamp), forces a watcher poll, and stops any
  still-running local instance before resolving; sibling nodes stop theirs on their next watcher
  poll — except a sibling whose `strandFilter` excluded the strand, which never observes the
  removal and keeps running until stopped locally (both sides pinned by
  `strand-unpublish.spec.ts`; the sibling stop is additionally proven across two real nodes by
  `strand-unpublish-sibling-convergence.integration.ts`). The old local-only
  `CadreNode.removeStrand` was renamed `stopStrand` (behaviour unchanged:
  the row survives and the strand is rediscovered on restart). Unpublishing a closed strand
  destroys its `MemberPrivateKey` irreversibly; the id itself is not blacklisted — an owner
  re-publish re-seats it on a fresh stamp (`strand-unpublish.spec.ts`). The operator surface
  landed as `feat-strand-removal-cli`: `cadre strands` became a `cadre strand list|remove`
  group (`strands` kept as an alias, with `list` as the default subcommand so the bare
  invocation and its options keep working), where `remove <strandId>` reads the row first,
  reports "nothing to do" (exit 0) for an unpublished strand, and **refuses a closed strand
  without `--yes`** — naming the consequence (the membership key in that row exists nowhere
  else) rather than destroying it on the operator's behalf. The refusal exits non-zero and is
  structured under `--json`. `--yes` is a flag, not a prompt, because these commands run
  non-interactively (`strand.spec.ts` over a fake store; `subcommand-wiring.spec.ts` drives the
  real commander → `runSubcommand` → `nodeStore` path over a stubbed `withConnectedNode`,
  pinning the refusal's non-zero exit). **Still not exercised against a real node:** no test
  stands one up, so the last hop — `withConnectedNode` itself and the control-database write —
  is covered only by the node-level `strand-unpublish.spec.ts` on the far side. A cadre-host UI
  for the same operation is parked in `backlog/feat-cadre-host-strand-removal-ui`.
- [x] **`storage` + `storage` cross-network — FIXED & VERIFIED (2026-06-29).** `strand-formation-e2e`
  Phase 2 (`new CadreNode(... profile:'storage')` for *both* parties) and the closed-strand
  membership e2e now **pass** (`strand-formation-e2e` 11/11, closed-strand 1/1 at that date, 3/3
  today). The optimystic
  selection-layer fix (`cross-network-unknown-peer-backfill-hardening`, split into
  `cross-network-cohort-no-unknown-backfill` + `cross-network-coordinator-no-unknown-fallback`,
  both complete at optimystic HEAD `56db2fd`) stops the `min(2, clusterSize)` viability floor from
  backfilling an unconfirmed `unknown` peer into the write cohort, so party A no longer dials party
  B's `/repo/1.0.0`. The `could not negotiate /optimystic/control-<party>/repo/1.0.0` +
  `super-majority: 1/2` signature is gone. The FRET root cure (`network-scoped-ring-admission`)
  remains wanted as substrate-level defense-in-depth but is not required for this.

### Optimystic blocker (root cause — sibling repo `../optimystic`; fixed at the HEAD linked here)
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
     `digest('CadreControl.CadrePeer', 'vouch', peerId, stampId)` (`cadrePeerVoucherDigest`), delete signs
     the distinct `digest('CadreControl.CadrePeer', 'remove', peerId, stampId)` (`cadrePeerRemoveDigest`;
     both carry the domain/action tags every control-plane approval now leads with) — and the combined `check on insert,
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
signature verifies over the tagged voucher digest `digest('CadreControl.CadrePeer', 'vouch', PeerId, StampId)`), and both the push-wake and strand-addr
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
for the invite's validity, `openEnrollmentWindow` for out-of-band flows), an outstanding open
invitation (cross-party formation is stranger-serving by design), and the configured bootstrap/relay
infrastructure peers. The stranger-open protocol allowlist (seed + formation, each with its own
in-protocol trust check) is documented in one place in that module. Outbound dials are never gated
(`resolvePeerAddrs`' trust policy already gates what gets dialed). Strand cohort nodes do NOT get
the membership gater — their peers are legitimately cross-party.

**The per-stream half of step 6 has LANDED too (2026-07-29, `control-repo-protocol-stream-authz`):**
`@optimystic/db-p2p` grew an inbound-stream authorization seam (`inbound-authorization.ts` — the
service runs the predicate before decoding any frame and on deny aborts the stream, so the remote
sees only a reset and the connection survives), and the control node wires it to
`CadreNode.authorizeInboundControlStream`: a fail-closed, synchronous, in-memory check of the
**materialized** authorized-peer snapshot (`authorizedControlPeers`, refreshed on membership writes,
on an applied inbound seed, and each `reconcileControlCohort` pass — a live DB read inside the gate would deadlock into mutual
denial). It shares the connection gate's unconditional admissions (not fully up, absent/empty
anchor, bootstrap infra, empty-snapshot cold start) but has NO stranger carve-outs — an enrollment
window admits a stranger's connection for seed delivery while its repo/cluster/sync/block-transfer
streams stay refused. Unit matrix in `cadre-core/test/control-stream-authorization.spec.ts`;
end-to-end proof in integration scenario `control-stream-authz` (raw `RepoClient` pend/commit: the
member succeeds, the enrollment-window outsider is refused with connection intact and nothing
written). Known bounded staleness: a member added while a sibling was down is admitted by that
sibling only after its next reconcile refresh.

**Step-6 review (2026-07-28) found the formation exemption too wide to be worth much yet.** "A
strand-formation responder is registered" is a process-lifetime condition — only `stop()` clears the
service, `formStrand` opens it on the initiator side that never needs inbound strangers, and
`reference-app-rn` registers the responder during node bring-up. So on the phone reference app the
connection gate denies nobody, and the web app's gate opens permanently after the first formation
action. Nothing is unsafe (steps 4–5 still hold), but the defense-in-depth layer bought nothing on
the primary client. **Narrowed (2026-07-28, `narrow-formation-stranger-carveout`):** the exemption
now tracks *an unexpired, not-fully-consumed open invitation outstanding* rather than *capability to
serve one*. `StrandSolicitationService.hasOutstandingInvitation` answers from an in-memory registry
of tokens this process minted/published (pruned on expiry and on observed consumption) and, when the
registry is dry, from the usage recorder's optional durable scan
(`ControlDatabase.hasOutstandingFormationInvite` — unexpired AND usage below `TotalUses`, matching
`isTokenValid`/`isTokenUsed` semantics exactly, so a token the handler would reject cannot hold the
gate open). The check moved to the END of the admission chain, after the authorized-member reads, so
only a peer already on the deny path pays for it, and it catches its own errors (fail-open). Eager
`initializeStrandSolicitation` on the phone and `formStrand`'s lazy service on an initiator now both
leave the gate armed. Two accepted caveats, both self-healing: the registry dies with the process
(after a restart only persisted `FormationInvite` rows hold the exemption — re-mint otherwise, same
story as the enrollment window), and a peer whose invite row has not replicated to this node yet is
denied even though the handler would have accepted it. A never-expiring invite (`ExpiresAt` null)
holds the exemption open indefinitely by design — unlike "a responder object exists", that is an
explicit, owner-signed, single-purpose statement, and both reference apps pass an expiry. The review
also bounded the
admission decision (`ADMISSION_DECISION_TIMEOUT_MS`, 2s → admit): libp2p awaits
`denyInboundEncryptedConnection` **without** racing its inbound-upgrade timeout, so an unbounded
control-DB read there could wedge an inbound upgrade permanently and hold its connection-manager
slot — the opposite of the layer's fail-open contract.
- **Not** a super-majority-threshold rounding bug: `Math.ceil(2 * 0.75)` and the
  "fix" `Math.floor(2/2)+1` both yield 2 — 2-of-2 is correct for a 2-node quorum. The
  defect is upstream of the count (peer selection / protocol negotiation), and is
  optimystic-side networking work, not a one-line sereus change.

