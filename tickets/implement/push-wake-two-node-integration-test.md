description: Real-libp2p push-wake integration scenario — two CadreNodes on one control network, pushWake → StrandWakeService over a real dial, plus NAT'd-via-relay and non-member rejection.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (new), packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts (pattern), packages/integration-tests/src/scenarios/convergence-stress.integration.ts (relay pattern), packages/cadre-core/test/peer-record-resolution.spec.ts (record-seeding pattern), packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/authority-key.ts
----

Add a new integration scenario `packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts` that exercises the **real wire path** of control-network push-wake, which the `hibernation-push-wake` unit tests only cover with in-memory stream doubles (`wake-stream-helpers.ts`) and a stubbed `dialProtocol`/`resolvePeerAddrs`.

This ticket proves end-to-end: real `node.handle(WAKE_PROTOCOL, …)` dispatch, a real `dialProtocol` stream over a real transport, libp2p 3.x half-close (`stream.close()` write-EOF with the read end staying open for the ack), multi-chunk JSON framing, the circuit-relay (signaling-first) dial, and `pushWake`'s composition with `resolvePeerAddrs`.

## Architecture of the test

The design is fully resolved below — no open options for the implementer to decide.

### Topology

Each `it()` boots its own fresh nodes in a `try/finally` (mirror `strand-formation-e2e.integration.ts` "Phase 2"). All cadre nodes share **one** control network (same `controlNetwork.partyId`); the receiver bootstraps to the server. Because the control DB is an Optimystic coordinated store, a write on one node is visible to another via **pull-on-read** — no replication sleep/poll needed; just query after the write.

- **Server `S`** — the member authority + sender. `profile: 'transaction'`, holds the authority key, is the control-network bootstrap, calls `pushWake(...)`.
- **Receiver `Rx`** — the hibernating member. Same `partyId`, `bootstrapNodes: [S control addrs]`, `hibernation: { enabled: true }`, hosts the target strand and hibernates it.
- **Outsider `O`** (non-member scenario only) — a third `CadreNode` on the same control network that is **never** registered as a `CadrePeer`, so `Rx.isMember(O)` is false.
- **Relay `L`** (NAT scenario only) — a dedicated `profile: 'storage'`, `enableRelay: true` node so `Rx` (with `listenAddrs: []`) can reserve a circuit slot. `L` is transport infrastructure, not a cadre member. Keep `S` distinct from `L` so the wake dial genuinely traverses the relay (a dialer that *is* the relay short-circuits to its existing reservation connection and proves nothing).

### Control-plane setup (deterministic — no reliance on `registerSelf` heartbeats)

Follow the `peer-record-resolution.spec.ts` recipe:

- `S`: create with `privateKey: sKey`; after `start()`, `db.insertAuthorityKey(sPubB64)` and `node.initializeSeedBootstrap(sPrivB64)`, where `{ privateKeyB64: sPrivB64, publicKeyB64: sPubB64 } = authorityKeyFromLibp2p(sKey)`.
- Make `S` a member so `Rx.isMember(S)` passes: `await S.registerSelf()` (authority → `'inserted'`; inserts `S`'s self-signed `CadrePeer` row into the shared DB).
- Seed `Rx`'s resolvable record directly (deterministic; avoids `collectSelfAddrs`/heartbeat timing):
  - `const { privateKeyB64: rxPrivB64, publicKeyB64: rxPubB64 } = authorityKeyFromLibp2p(rxKey)`
  - `const record = signPeerRecord({ peerId: rxPeerId, publicKey: rxPubB64, addrs: rxAddrs, updatedAt: Date.now() }, rxPrivB64)`
  - `await S.getSeedBootstrapService()!.insertSelfPeerRecord(record)` (authority-signed INSERT into the shared control DB).
  - `rxPubB64` must equal `ed25519PublicKeyB64FromPeerId(rxPeerId)`; `authorityKeyFromLibp2p(rxKey)` derives from the same key, so the binding check passes.
- `rxAddrs` per scenario:
  - **happy path**: `Rx`'s real direct control addr — `Rx.getControlNode()!.getMultiaddrs().map(String)` (a `/ip4/127.0.0.1/tcp/<port>/ws` addr).
  - **NAT path**: `waitUntil` `Rx.getControlNode()!.getMultiaddrs()` contains a `/p2p-circuit` addr (reservation established via `L`), then build `record` from `[circuitAddr]` (optionally plus a direct addr) so `resolvePeerAddrs` returns it **signaling-first**.

### Hibernating-strand setup on `Rx`

- `Rx` config: `hibernation: { enabled: true }`. The strand's `latencyHint` must be **non-realtime** (use `'interactive'` via the sApp config) — realtime strands never hibernate.
- Create the strand instance, then hibernate it:
  - `const sApp = createSignedSAppConfig(SIMPLE_SCHEMA, '0.1.0')` (copy the `signSchema` helper from `strand-formation-e2e.integration.ts`; `latencyHint: 'interactive'`).
  - `const strand = await Rx.addStrand({ strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' }, sAppConfig: sApp, mode: 'bootstrap' })` — expect `strand.status === 'active'`. (Use `'bootstrap'` so the strand stands up solo with no strand-level peers; the wake travels over the **control** network, not the strand network. If `addStrand` rejects `'bootstrap'` standalone, fall back to `'networked'` — verify which yields `'active'`.)
  - `await Rx.hibernateStrand(strandId)`; assert `Rx.getStrand(strandId)?.status === 'hibernating'` before any wake.

### Scenarios (one `it()` each)

1. **Happy path (direct dial).** After setup, `const ack = await S.pushWake(rxPeerId, strandId, 'test wake')`. Assert `ack` is `{ accepted: true, status: 'active' }` and `Rx.getStrand(strandId)?.status === 'active'`. This exercises real `handle`/`dialProtocol`/half-close/framing and `pushWake`→`resolvePeerAddrs`→`dialWake`.

2. **NAT'd receiver via circuit relay.** Boot `L` (relay), `S`, `Rx` (NAT'd, `listenAddrs: []`, bootstraps to both). After `Rx` reserves a slot and its circuit addr is captured + seeded (above), `const resolved = await S.resolvePeerAddrs(rxPeerId)` — assert `resolved[0].toString()` contains `/p2p-circuit` (signaling-first). Then `const ack = await S.pushWake(rxPeerId, strandId)` — assert `{ accepted: true, status: 'active' }` and `Rx` strand is `active`. This is the path the in-memory tests cannot prove.

3. **Non-member sender rejected.** Boot `S` (authority, seeds `Rx`'s record), `Rx` (hibernating, direct addr), and `O` (joins control network, never registered). `const ack = await O.pushWake(rxPeerId, strandId)`. Assert `ack.accepted === false` and `Rx.getStrand(strandId)?.status === 'hibernating'` (unchanged — no wake). `O` can resolve `Rx` (its record is in the shared DB, `currentMemberTrustPolicy` trusts any peer with a row) and dials over the real transport; the receiver rejects on `isMember(O) === false`.

### Wall-clock / runner

Per-`it()` vitest timeout `60_000`; harness `defaultTimeoutMs: 20_000` for `waitUntil`. Three scenarios at ~30–60s each stay well under the 10-min idle ceiling — agent-runnable, no CI-only marking. If the NAT reservation proves slow, bump only that `it()`'s timeout (do not mark CI-only without evidence). Run with `2>&1 | tee` if streaming (see below).

## Key references (signatures already confirmed)

- `strand-wake-protocol.ts`: `WAKE_PROTOCOL = '/sereus/strand-wake/1.0.0'`; `StrandWakeService.initialize(node)` is called automatically in `CadreNode.start()` (cadre-node.ts:342) — the handler is live after `start()`. `dialWake(node, addrs, request, opts)` is the sender path `pushWake` uses.
- `cadre-node.ts`: `pushWake(targetPeerId, strandId, reason?): Promise<WakeAck>` (resolves → dials), `resolvePeerAddrs(peerId, opts?)` (binding+self-sig+freshness(15 min)+trust+signaling-first), `isMember(peerId)`, `registerSelf()`, `addStrand(config)`, `hibernateStrand(strandId)`, `getStrand(strandId)`, `getControlNode()`, `getControlDatabase()`, `getSeedBootstrapService()`, `initializeSeedBootstrap(privB64)`.
- `peer-record.ts`: `signPeerRecord({ peerId, publicKey, addrs, updatedAt }, privB64)`, `verifyPeerRecordSignature(record)`.
- `authority-key.ts`: `authorityKeyFromLibp2p(libp2pKey) -> { privateKeyB64, publicKeyB64 }`.
- `seed-bootstrap.ts`: `ed25519PublicKeyB64FromPeerId(peerId)`; `SeedBootstrapService.insertSelfPeerRecord(record)`.
- `WakeAck` = `{ accepted: boolean; status?: StrandStatus; reason?: string }`; `WakeRequest` = `{ strandId: string; reason?: string }` (both in `types.ts`).
- Config/relay pattern: `createTestNodeConfig` + `wsTransports()` (`[webSockets(), circuitRelayTransport()]`) from `strand-formation-e2e.integration.ts`; relay node = `profile: 'storage'`, `network.enableRelay: true`, `listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws']` (see `convergence-stress.integration.ts`).

## Edge cases & interactions (write these as assertions / guard against them)

- **Handler registration precondition.** Confirm the WAKE handler is live after `start()` (it is registered at cadre-node.ts:342). If a dial gets "protocol not supported", that is a real regression in `start()` wiring — surface it, do not paper over it.
- **Self-signature / binding gates in `resolvePeerAddrs`.** A record whose `publicKey` ≠ `ed25519PublicKeyB64FromPeerId(peerId)`, or with a bad/`null` `sig`, resolves to `[]` and `pushWake` throws before dialing. Use `authorityKeyFromLibp2p(rxKey)` + `signPeerRecord` exactly so the gates pass. (Optionally add a negative micro-assertion: a stale `updatedAt` → empty resolve.)
- **Freshness window.** `updatedAt: Date.now()` is required; the default max age is 15 min. Do not hardcode a past timestamp.
- **Signaling-first ordering (NAT path).** Assert `resolved[0]` is the `/p2p-circuit` addr when the record carries both a circuit and a direct addr — this is the ordering the in-memory tests stub.
- **Relay distinctness.** `S` (dialer) must not be the relay `L`, or the "relayed" dial degenerates to the existing reservation connection and proves nothing.
- **Reservation race (NAT path).** The circuit addr may not be present on `Rx.getControlNode().getMultiaddrs()` immediately after `start()`; `waitUntil` it appears before seeding the record.
- **Hibernation preconditions.** `hibernation.enabled: true` AND non-realtime `latencyHint`, else `hibernateStrand` is a no-op and the strand never reaches `'hibernating'` — assert the `'hibernating'` status before the wake so a silent no-op fails loudly.
- **Wake status read.** `processWakeRequest` wakes then reads `instance.status`; expect `{ accepted: true, status: 'active' }` (a hibernating/idle strand transitions to `active` before the ack is written). Assert both the ack and `Rx.getStrand(strandId)?.status`.
- **Non-member: no side effect.** After `O.pushWake`, assert `accepted === false` AND the strand is still `'hibernating'` (the receiver must reject before calling `wake`).
- **Pull-on-read membership.** `Rx.isMember(S)` depends on `S.registerSelf()` having inserted `S`'s row into the shared DB; if `isMember` is false on the happy path, the receiver rejects a legitimate member — verify `S`'s row is registered before `pushWake`.
- **Teardown.** Always `await node.stop()` for every booted node in `finally` (control nodes, relay, outsider) to release ports — mirror the Phase-2 cleanup.

## TODO

- Scaffold `push-wake-e2e.integration.ts`: vitest `describe`, shared `wsTransports()`/`createTestNodeConfig`/`createSignedSAppConfig` helpers copied from `strand-formation-e2e.integration.ts` (adjust `hibernation.enabled` per node), and a `SIMPLE_SCHEMA`.
- Implement a `bootServer()` helper: `CadreNode` (transaction, bootstrap) with authority key inserted, seed bootstrap initialized, `registerSelf()` called.
- Implement a `seedReceiverRecord(S, rxPeerId, rxKey, rxAddrs)` helper using `authorityKeyFromLibp2p` + `signPeerRecord` + `S.getSeedBootstrapService().insertSelfPeerRecord`.
- Implement a `bringUpHibernatingStrand(Rx, strandId)` helper: `addStrand` (assert `active`) → `hibernateStrand` (assert `hibernating`).
- Scenario 1 (happy path, direct): boot `S` + `Rx`, wait for control connection, seed `Rx`'s direct addr, hibernate strand, `S.pushWake`, assert ack `{ accepted:true, status:'active' }` + strand `active`.
- Scenario 2 (NAT via relay): boot `L` + `S` + `Rx` (NAT'd), wait for `Rx` circuit addr, seed it, assert `resolvePeerAddrs` returns circuit-first, hibernate, `S.pushWake`, assert wake.
- Scenario 3 (non-member): boot `S` + `Rx` + `O`, hibernate, `O.pushWake`, assert `accepted:false` + strand still `hibernating`.
- Run the new scenario in foreground with streamed output: `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/push-wake-e2e.log` (confirm the exact test script in `packages/integration-tests/package.json`; it is `vitest run`). Narrow to the file if the runner supports it.
- Run `yarn lint` and the package typecheck; fix any findings in the new file.
- Write a review/ handoff ticket: note which `addStrand` mode worked, the relay reservation timing observed, and any flakiness/timeout headroom for the reviewer.
