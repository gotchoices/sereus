description: When a node updates the shared membership database while no other node is online, that change stays trapped on that one node and never reaches the others even after they reconnect; make the node re-send such changes once it has company so they finally propagate.
prereq: control-cohort-proactive-dial
files: packages/cadre-core/src/cadre-node.ts (reconcileControlCohort + cohort-growth signal from prereq, registerSelf/publishSelfRecord ~577-631, registerDeviceToken ~858-894, authorizePeer/removePeer ~1883-1900, getConnections summary ~237-244, getControlNode), packages/cadre-core/src/seed-bootstrap.ts (authorizePeer/insertSelfPeerRecord/insertSelfDeviceToken ~250-300,600-700), packages/cadre-core/src/control-database.ts (queryCadrePeers ~402, getAuthorityKeys ~390, updateSelfPeerRecord/updateSelfDeviceToken), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter (coordinator-repo getClusterSize local-only branch — reference only), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (write-then-connect ordering)
difficulty: hard
----

## Problem

Even with proactive cohort discovery (`control-cohort-proactive-dial`), an authority that performs a control write **while no sibling is connected** commits **local-only**: Optimystic's coordinator (`getClusterSize(blockId) <= 1` branch) commits without broadcasting when the block's cluster has ≤1 member. The row exists in the writer's local control DB but was never registered in any cluster's consensus, so a sibling that connects *later* may never observe it — pull-on-read routes to the block's cluster, which never learned of the block.

This is the **write-while-alone durability gap**. The convergence test sidesteps it by **connecting before writing** (cohort ≥2 at commit). Production cannot guarantee that ordering: an authority phone/server routinely authorizes a peer, registers its own `CadrePeer`/`DeviceToken`, or removes a peer while it happens to be the only node online. Without a remedy, those writes are silently non-durable across the party.

## Design (resolved)

**Re-issue authority-authored control writes once the cohort grows to ≥2.** The fix has three parts:

### 1. Detect "wrote while alone"

At the time of an authority control write (`authorizePeer`, `removePeer`, `registerSelf` insert/refresh, `registerDeviceToken` insert/refresh), probe whether the write could have replicated. The precise signal is the block's cluster size; a **pragmatic, available proxy** is `controlNode.getConnections()` — **0 connected peers ⇒ the write definitely committed local-only**. (A coarse over-approximation is fine here: re-touching an already-replicated row is harmless because the re-issue is an idempotent monotonic update — see below.) Record the affected row key (subject peerId / table) in an in-memory `pendingControlReplication` set when connections == 0 (or, if a precise `getClusterSize` seam is later exposed, when cluster < 2).

### 2. Re-issue on cohort growth

The cohort-discovery routine from the prereq is the natural growth detector. When the control cohort transitions **0 → ≥1 connected sibling** (observed in `reconcileControlCohort` / a `connection:open` listener on `controlNode`), drain `pendingControlReplication`: for each entry, **re-issue the write as an idempotent authority UPDATE** that bumps `UpdatedAt` and re-signs. Because the table is now backed by a ≥2 cohort, the re-issued transaction broadcasts and replicates. The existing self-publish path already does exactly this shape — `registerSelf()` is idempotent and strictly increases `UpdatedAt` — so self rows just call `registerSelf()` again; authority-authored *other-peer* rows (`CadrePeer` for X, that peer's `DeviceToken`) are re-touched via an authority-signed UPDATE that bumps `UpdatedAt`.

### 3. Survive restart (reconstruct the pending set)

The pending writes are themselves already in the **local** control DB (they committed local-only). On (re)start, before/at the first cohort-growth, an authority can reconstruct "rows I authored that may be unreplicated" by scanning local `CadrePeer`/`DeviceToken` for rows whose authority-signer is this node's authority key, and re-touch them once the cohort forms. **Recommended default (simple, robust, O(rows) on small control tables): on the first 0 → ≥1 cohort growth after start, an authority re-touches every row it is the authority-signer of** (bump `UpdatedAt`, re-sign, UPDATE). This subsumes the in-memory pending set for the restart case and needs no persisted queue. The in-memory set from part 1 is then an optimization that also covers writes made *after* start while still alone.

Re-touch is **safe to over-apply**: `UpdatedAt` strictly increases and the schema rejects a replayed older record, so re-touching an already-replicated row is a no-op-equivalent monotonic bump, not a conflict.

## Edge cases & interactions

- **Re-touch of a removed peer.** `removePeer` is a DELETE, not an `UpdatedAt` bump — a delete-while-alone cannot be "re-touched" by bumping a row that no longer exists. Decide and implement: re-issue the DELETE on cohort growth (track removed subjects separately in the pending set), so a removal made while alone also propagates. A removal that never replicated and is then lost on restart is a **security-relevant** durability gap (a revoked peer stays a member elsewhere) — the restart reconstruction must account for removals (e.g. a tombstone the schema already carries, or accept that DELETEs require a connected cohort and **log loudly** when one commits alone). Resolve this explicitly in the ticket work; do not leave the delete path silent.
- **Non-authority node.** A non-authority node cannot author inserts/removes; its only writes are self `UPDATE`s (already idempotent via `registerSelf`/`registerDeviceToken` refresh). Re-touch on cohort growth for a non-authority is just re-running `registerSelf()` — already covered by the prereq's `self:peer:update`/heartbeat republish, but ensure the 0 → ≥1 growth also triggers it.
- **Cohort growth proxy coarseness.** `getConnections() == 0` is a sound *lower bound* for local-only (0 peers ⇒ definitely alone). A connected-but-not-in-this-block's-cluster case may still commit local-only despite ≥1 connection; the re-touch-on-growth + the prereq's periodic membership reads (pull-on-read) provide a second convergence path. Document that the precise fix would consult `getClusterSize(blockId)`; the proxy is the agreed first cut.
- **Double-write / thundering re-touch.** Many local-only rows draining at once on first growth must not stampede: bound concurrency or batch the re-touch, and single-flight the drain so two growth signals don't double-issue. Reuse a guard like `registerSelfInFlight`.
- **Idempotency under concurrent self-republish.** The prereq's heartbeat republish and this drain can both call `registerSelf()` — the existing single-flight `registerSelfInFlight` already collapses these; ensure the drain joins it rather than racing a duplicate INSERT/UPDATE.
- **No authority key.** A node that holds no `seedBootstrapService`/authority key can re-touch only its own self rows; authority-authored other-peer rows it merely *holds* (received over the wire) must NOT be re-signed by it (it lacks the key) — skip them. Guard on `getSelfSigningKey()` / authority presence.
- **Growth from ≥1 → ≥2 vs 0 → ≥1.** The local-only branch is `clusterSize <= 1`; connection count is the proxy. The meaningful transition is **0 → ≥1** connected sibling (the earliest point a re-issue can replicate). Re-touching again on later growth is harmless (monotonic) but avoid doing it every pass — fire the drain on the *transition*, not on every reconcile tick.
- **Shutdown race.** A drain in flight during `stop()`/`cleanup` must early-return on `!_running`/null node, like the other background paths.
- **Interaction with `control-cohort-proactive-dial`.** This consumes the prereq's connection/cohort signal; if the prereq exposes a growth callback/event, hook it rather than adding a second connection listener. Keep the two routines from double-dialing or double-draining.

## Tests (key cases, TDD)

- **Write-then-connect convergence (the inverse of the existing test).** Boot authority A and reader B; **A writes X while B is disconnected** (no connection), THEN connect (or let proactive dial connect) and assert `waitForCadrePeerConverged(B, X)` succeeds — proving the re-touch-on-growth drains the local-only write. Without the fix this should hang (regression guard).
- **DeviceToken local-only then converge.** Same shape for a `DeviceToken` self-insert made while alone.
- **Remove-while-alone propagates (or logs loudly).** A `removePeer(X)` while alone, then connect: B must observe the removal (or, if DELETE-on-growth is deferred, the alone-commit is logged loudly and the limitation is documented + ticketed).
- **No re-touch storm.** With several local-only rows, the drain on first growth issues bounded, single-flight re-touches (no duplicate-INSERT conflicts, no unbounded fan-out).
- **Non-authority safety.** A non-authority node does not attempt to re-sign rows it merely holds.

## TODO

### Phase 1 — detection + drain
- Add `pendingControlReplication` (in-memory) populated when an authority control write commits with `getConnections().length === 0`; instrument `authorizePeer`/`removePeer`/`publishSelfRecord` insert+refresh/`registerDeviceToken`.
- Implement the cohort-growth drain: on 0 → ≥1 connected-sibling transition (hook the prereq's reconcile/connection signal), re-issue each pending write as an idempotent monotonic authority UPDATE (self rows via `registerSelf`/`registerDeviceToken`; other-peer rows via authority-signed `UpdatedAt` bump). Single-flight the drain; bound concurrency.

### Phase 2 — restart reconstruction + deletes
- On first cohort growth after start, an authority re-touches every row it authored (scan local `CadrePeer`/`DeviceToken` filtered by authority-signer == own key). Guard on authority/self-signing-key presence.
- Resolve the delete-while-alone path: re-issue DELETE on growth (track removed subjects) or document + loudly log the limitation and file a follow-up if full delete durability is deferred.

### Phase 3 — tests & docs
- Add the write-then-connect convergence scenarios (CadrePeer + DeviceToken), remove-while-alone, re-touch-storm bound, and non-authority safety tests.
- Update `docs/architecture.md` Control Network status: write-while-alone durability now remedied by re-touch-on-cohort-growth (note the `getConnections` proxy vs precise `getClusterSize`, and the delete-path disposition).
- Run `yarn workspace @serfab/cadre-core test`, the new convergence scenarios, and `yarn lint`; stream output with `| tee`.
