description: Cadre nodes in a party don't reliably connect to each other on their own, so their shared membership database can fail to sync in production; add an automatic routine that finds and dials fellow nodes (and keeps them connected) the way the tests do by hand.
prereq: control-db-network-backed
files: packages/cadre-core/src/cadre-node.ts (start ~272-379, scheduleSelfRegistration/startRecordRefresh/stopRecordRefresh ~540-736, resolvePeerAddrs ~755-807, listMembers/isMember ~1794-1807, getRelayAddress ~1984-1992, cleanup ~1067-1126), packages/cadre-core/src/control-database.ts (queryCadrePeers ~402, getAuthorityKeys ~390), packages/cadre-core/src/seed-bootstrap.ts (ed25519PublicKeyB64FromPeerId ~81, applySeed peerStore.merge + authority dial ~503-535), packages/cadre-core/src/strand-cohort.ts (CohortPeerRow), packages/cadre-core/src/types.ts (NetworkConfig ~139-183), packages/cadre-core/src/peer-record.ts (DEFAULT_PEER_RECORD_* ~30-38), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (manual connectControlNodes stand-in ~94-118), packages/integration-tests/src/harness/test-network.ts (waitForCadrePeerConverged)
difficulty: hard
----

## Problem

The `CadreControl` tables are now network-backed (`control-db-network-backed` landed: default vtab → Optimystic network transactor), so a control write on one cadre node *can* replicate to connected peers. But replication only happens once the control collections' **cohort actually forms** across the party's nodes — the nodes must be transport-connected so FRET seats each peer in the others' keyspace cohort, and a write must occur while that cohort has ≥2 members (otherwise it commits **local-only** and never broadcasts).

Today there is **no production mechanism that makes a party's control nodes actively connect to each other** for this. The convergence proof (`control-db-two-node-convergence.integration.ts`) achieves it with a **test-only manual `dial()` + both-sides connection wait** (`connectControlNodes`, lines 94-118). A node started with only `bootstrapNodes`/relay does not reliably form the control cohort. The result in production: sibling-written control rows (membership, peer addresses, device tokens) may never reach a node that only ever connected over the control network — breaking push-wake authorization (`isMember` reads an empty/partial local table) and any sibling-written-row read.

This ticket **productionizes what the test does by hand**: each node, on start and on a refresh cadence, resolves its known siblings' control addresses and proactively dials a bounded set to keep the control cohort connected.

## Design (resolved)

A new in-node routine — call it `reconcileControlCohort()` — runs:
- **eagerly on start** (folded into the existing post-start background work, after `scheduleSelfRegistration`), and
- **on a recurring cadence** (a dedicated interval, see below), and
- **on `self:peer:update`** (address/relay churn — reuse the listener already wired in `startRecordRefresh`).

Each pass:

1. **Enumerate known siblings.** Read `listMembers()` (`queryCadrePeers()` → `CohortPeerRow[]`), excluding self (`controlNode.peerId`). This control-DB read is itself a pull-on-read that helps converge the membership table — a virtuous loop.
2. **Select a bounded dial set** by the connection policy below.
3. **Skip already-connected peers** — diff against `controlNode.getConnections()` (peer ids already connected need no dial).
4. **Resolve addresses and dial.** For each selected, not-yet-connected sibling, resolve control addresses (source priority below) and `controlNode.dial(addr)`. Dials are best-effort: a failure is logged and the pass continues (mirrors `applySeed`'s per-peer try/catch). Connection *maintenance* (re-dial on drop) is just the next pass re-observing it as not-connected.

### Connection policy — backbone-preferential, bounded out-degree

Full N² mesh does not scale; FRET only needs a **connected** graph with the block clusters reachable. Storage/authority nodes are the stable, publicly-dialable backbone that hold the control blocks. Policy:

- **Backbone = authority members.** A member is backbone if its `publicKey` (derived from its peerId via `ed25519PublicKeyB64FromPeerId`) is in `getAuthorityKeys()`. **Always dial all authority members** (the authority set is small by design) — this routes cohort formation through publicly-dialable nodes and keeps the cohort ≥2 around where authority-signed writes originate.
- **Fill the remainder** up to a target out-degree with non-authority members, ordered deterministically (e.g. peerId sort) so every node makes a stable, predictable choice and load spreads.
- **Cap** total *non-authority* proactive dials at `targetControlDegree` (new `NetworkConfig.controlCohort?.targetDegree`, default a small constant — propose **6**). For small parties (members ≤ degree) this degenerates to full mesh, which is correct and cheap and matches the test; for large parties it bounds out-degree to backbone + degree.

### Address source priority (cold-start chicken-and-egg)

Resolving siblings from `CadrePeer` rows requires those rows, which require convergence, which requires connection — the cold-start cycle. It is broken **outside this routine** by the existing bootstrap paths, and this routine takes over once rows exist:

1. **Primary (steady state): `resolvePeerAddrs(peerId)`** — signed, fresh, trust-gated, signaling/relay-first control addresses from the converged `CadrePeer` record.
2. **Fallback (cold start): libp2p `peerStore`** entries that `applySeed` populated (and the bootstrap/relay connection that `applySeed`'s authority-dial established). At cold start `listMembers()`/`resolvePeerAddrs` may be empty; the **seed + `bootstrapNodes` + relay** establish the *first* connection to an authority, which converges the membership table, after which step 1 takes over on the next pass.

So this routine does **not** need to solve cold start from nothing — it consumes the seed/bootstrap-established first connection and then maintains+extends the cohort from converged rows. A node with neither a seed nor `bootstrapNodes` nor any converged row has no siblings to dial and the pass is a no-op (correct: it is genuinely alone).

### NAT / relay sufficiency

`resolvePeerAddrs` returns **signaling/circuit-relay-first** addresses. A relayed libp2p connection **is** a real connection and seats the peer in FRET's view, so accept relayed connections for cohort formation (push-wake already relies on relayed control connections). The backbone-preferential policy means edge (NAT'd/mobile) nodes dial the **backbone** (storage/authority nodes with public addrs) — direct, not relay-only — for the critical connections; only edge↔edge would be relay-only, and the policy avoids making those the load-bearing path. **WebRTC/DCUtR upgrade-to-direct is out of scope** (transport layer; tracked by `rn-webrtc-transport` in plan/); document that if sustained relay-only replication proves insufficient (relay data caps), that upgrade is the remedy, not a change here.

### Cadence

Add `DEFAULT_CONTROL_COHORT_RECONCILE_MS` (propose **15_000**, in the same spirit as `strandWatchInterval`'s 5s polling but lighter). Wire a dedicated `setInterval` in/near `startRecordRefresh` (so teardown is symmetric in `stopRecordRefresh`), `.unref()`'d like the existing timers. The eager start pass runs once immediately. The `self:peer:update` handler triggers a reconcile in addition to the self republish. Make the interval overridable via `NetworkConfig.controlCohort?.reconcileMs`.

### Why this is its own ticket / boundary with FRET-liveness

`fret-backed-peer-record-liveness` (backlog) is a **freshness optimization for a single peer-address record** behind `resolvePeerAddrs`; this ticket is **cluster formation for whole control collections**. They are **independent and complementary**: this routine consumes `resolvePeerAddrs` as-is (CadrePeer-backed) and neither requires nor implements FRET puts/gets; FRET-liveness, if/when it lands, only changes *where* `resolvePeerAddrs` sources an address from and transparently speeds this routine up. No change to the backlog ticket is needed beyond the cross-reference recorded here.

The **write-while-alone durability gap** (an authority writing while its cohort is <2 commits local-only) is a **separate** concern handled by `control-write-ensure-replicated` (prereq: this ticket), which builds on the cohort-growth signal this routine exposes.

## Edge cases & interactions

- **Cold start, no rows yet.** `listMembers()` empty → pass is a no-op; first connection comes from seed/`bootstrapNodes`/relay, not this routine. Must not throw or busy-loop when there are zero siblings.
- **Self in member list.** Exclude `controlNode.peerId.toString()` — never dial self.
- **Already connected.** Diff against `getConnections()` peer ids before dialing; a re-dial of a connected peer must be skipped (avoid churn / duplicate dials).
- **Single-flight / re-entrancy.** Two reconcile triggers (start pass + first interval, or `self:peer:update` + interval) must not run overlapping passes that double-dial — collapse concurrent passes into one in-flight (mirror the `registerSelfInFlight` single-flight guard).
- **Unresolvable / stale sibling row.** `resolvePeerAddrs` returns `[]` on signature/freshness/trust failure → that sibling is simply skipped this pass (no throw); falls back to peerStore addr if present, else skipped.
- **Dial failure (NAT, offline, relay down).** Per-peer try/catch, logged, pass continues — exactly like `applySeed`'s authority-dial loop. A failed dial is retried next pass.
- **Backbone identification before AuthorityKey converges.** If `getAuthorityKeys()` is empty/partial pre-convergence, no member is classified backbone yet → the bounded-fill path still dials up to `targetDegree` members, so progress is made; backbone preference sharpens as `AuthorityKey` converges. Must not deadlock waiting for authority classification.
- **Large party / out-degree cap.** With members ≫ degree, only backbone + `targetDegree` non-authority peers are dialed; **log what was capped** (don't silently bound coverage). Verify the deterministic ordering keeps the choice stable across passes (no flapping).
- **Connection-gater interaction.** Dials go through `network.connectionGater` (browser denies private/loopback/insecure-ws by default) — the routine must not assume a dial is allowed; gater denials surface as dial failures and are tolerated.
- **Shutdown race.** `stopRecordRefresh`/`cleanup` must clear the reconcile interval and abort any in-flight pass; a pass firing after `_running=false` / `controlNode=null` must early-return (guard like `publishSelfRecord`).
- **Hibernation.** A hibernating node keeps only the control network connected; ensure the reconcile interval is `.unref()`'d and does not by itself prevent hibernation or keep the event loop alive (match existing timer treatment).
- **Strand-cohort interaction (do NOT conflate).** This dials the **control** node only. It must not touch strand libp2p nodes; strand-network addresses are a *separate* namespace tracked by `strand-cohort-seed-uses-control-network-addresses` (plan/). Dialing control addresses reaches the control instance — correct here.
- **Idempotent membership read driving convergence.** The `listMembers()` read each pass is also the pull-on-read that converges the membership table — confirm a reader-only node (no authority, no writes) still converges purely by this routine's reads (the new acceptance test below).

## Tests (key cases, TDD)

- **Auto-convergence without manual dial (the acceptance proof).** New integration scenario mirroring `control-db-two-node-convergence` but with **no test-side `dial()`**: boot authority/storage node A and reader node B on a fresh party; give B a way to reach A initially (apply A's seed, or a shared relay/`bootstrapNodes`), start both, then `A.authorizePeer(X)` and assert `waitForCadrePeerConverged(B, X)` succeeds — proving the in-node reconcile establishes+maintains the cohort. Expected: B observes X within the convergence window with zero manual control dials.
- **No-op when alone.** A solo node with empty membership runs reconcile passes without throwing and without spurious dials.
- **Skip-connected / no double-dial.** Unit-level: with a member already in `getConnections()`, the pass issues no dial for it.
- **Backbone preference + cap.** With N members > degree and a known authority subset, assert all authorities are dialed and non-authority dials are capped at `targetDegree`, deterministically.
- **Shutdown cleanliness.** `stop()` during/after a reconcile leaves no live interval and no post-stop dial attempts (guarded early-return).

## TODO

### Phase 1 — core routine
- Add `NetworkConfig.controlCohort?: { targetDegree?: number; reconcileMs?: number }` to `types.ts` and `DEFAULT_CONTROL_COHORT_RECONCILE_MS` (15_000) + default `targetDegree` (6) constants.
- Implement `reconcileControlCohort()` in `cadre-node.ts`: enumerate members (exclude self), classify backbone via `getAuthorityKeys()` + `ed25519PublicKeyB64FromPeerId`, select bounded dial set, skip connected (`getConnections()`), resolve via `resolvePeerAddrs` (fallback peerStore), dial best-effort with per-peer try/catch.
- Add a single-flight guard for concurrent passes (mirror `registerSelfInFlight`).

### Phase 2 — wiring & lifecycle
- Run an eager pass after `scheduleSelfRegistration` in `start()`; add a `.unref()`'d reconcile `setInterval`; trigger a reconcile from the existing `self:peer:update` handler.
- Tear down the interval + abort in-flight pass in `stopRecordRefresh`/`cleanup`; guard the pass body against `!_running`/null `controlNode`.

### Phase 3 — tests & docs
- Add the auto-convergence integration scenario (no manual dial) and the unit cases above.
- Update `docs/architecture.md` Control Network "current status" (~167-177): cohort auto-connect now lands via proactive control-cohort dial; note the remaining write-while-alone durability item is `control-write-ensure-replicated`.
- Run `yarn workspace @serfab/cadre-core test`, the new + existing convergence scenarios, and `yarn lint`; stream output with `| tee`.
