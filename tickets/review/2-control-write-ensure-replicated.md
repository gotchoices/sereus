description: A node that changed the shared membership database while no other node was online used to keep that change trapped locally forever; now it re-sends those changes once another node connects, so they finally reach the rest of the group.
prereq:
files: packages/cadre-core/src/cadre-node.ts (write-while-alone re-replication: state fields ~178-215, committedAlone/noteControlWrite/drain/reconstruct/retouch/connection-listeners after peerStoreAddrs ~1033-1300, instrumentation in publishSelfRecord/registerDeviceToken/authorizePeer/removePeer, wiring in start() + teardown/reset in stopRecordRefresh), packages/cadre-core/src/seed-bootstrap.ts (canAuthorize ~211, reauthorizePeer after removePeer ~404), packages/cadre-core/test/cadre-node-control-replication.spec.ts (NEW, 15 unit tests), packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts (NEW, 2 live-network scenarios), docs/architecture.md (Control Network status), tickets/backlog/control-delete-while-alone-tombstone.md (NEW follow-up)
difficulty: hard
----

## What was built

Closes the **write-while-alone durability gap** for insert/update-shaped control
writes: an authority that authorizes/removes a peer or (re)publishes its own
`CadrePeer`/`DeviceToken` while no sibling is connected commits **local-only**
(Optimystic does not broadcast when the block's cluster is ≤1). The fix detects
this, queues the affected row, and **re-issues it on the 0→≥1 control-connection
growth edge** so it finally replicates.

### Mechanism (three parts, per the ticket)

1. **Detect "wrote while alone."** `committedAlone()` = `controlNode.getConnections().length === 0`
   — a sound *lower bound* for local-only (0 connections ⇒ cluster ≤1). Instrumented
   at the four write sites: `authorizePeer`/`removePeer` (→ `noteControlWrite`, a
   `pendingPeerWrites` map of `peerId → 'authorize' | 'remove'`) and
   `publishSelfRecord` insert+refresh / `registerDeviceToken` insert+refresh
   (→ `pendingSelfPeerWrite` / `pendingSelfDeviceWrite` flags). A write that commits
   while connected clears any stale queue entry.

2. **Re-issue on cohort growth.** A `connection:open` listener (wired in `start()`,
   so no early edge is missed) detects the 0→≥1 transition (`hasControlConnection`
   edge; `connection:close` re-arms it at 0) and fires a **single-flight** drain
   (`drainPendingControlReplication`). The drain: re-touches self rows
   (`registerSelf` + `retouchSelfDeviceToken` — idempotent, re-signs, bumps
   `UpdatedAt`); re-issues each pending authorize as an authority `UpdatedAt` bump
   via the new `SeedBootstrapService.reauthorizePeer` (authority branch of
   `CadrePeer.AuthorizedUpdate`, signing the same `digest(peerId)` `authorizePeer`
   uses); attempts best-effort re-issue of pending removes.

3. **Survive restart.** On the **first** growth after start, an authority also
   reconstructs the queue (`reconstructAuthoredMembership`): re-touch every
   `Sig`-null `CadrePeer` membership row (not self, not already queued) — these are
   authority-authored rows the peer has not yet self-published, the only kind safe
   to bump without invalidating a self-signature. Covers writes made before this
   process started. Over-applies safely (monotonic `UpdatedAt`; the schema rejects a
   replayed older record). One-shot via `reconstructedLocalOnlyWrites`.

Re-replication state is reset in `stopRecordRefresh` so a `stop()→start()` cycle
re-arms the edge and re-reconstructs.

## How to validate

- **Unit:** `yarn workspace @serfab/cadre-core test --run cadre-node-control-replication`
  (15 tests). Covers: queueing alone vs connected (authorize/remove, remove-wins);
  drain re-issues (authorize → monotonic bump > stored stamp; skip self-Sig'd row;
  skip vanished row; remove best-effort); first-growth reconstruction (Sig-null only,
  skip self + self-published + already-queued; runs once); **non-authority safety**
  (no re-sign of held rows); single-flight; not-running guard; the 0→≥1 transition
  fires once + re-arms after full disconnect.
- **Integration (live network):** `control-write-while-alone-convergence.integration.ts`
  — (a) authority `CadrePeer` row authorized while alone converges to a reader after
  connect (converges ~700ms; **hangs without the fix** — regression guard); (b)
  `DeviceToken` + `CadrePeer` self-registered while alone, reader resolves the token
  after connect. Both write **before** connecting (the inverse of
  `control-db-two-node-convergence`, which connects first).
- **Full suite + lint (run, green):** `yarn workspace @serfab/cadre-core test`
  → **590 passed / 1 skipped** (was 575; +15 from the new unit file). `eslint` clean
  on all touched files. `typecheck` clean (cadre-core + integration-tests). Existing
  `control-db-two-node-convergence` + `control-cohort-auto-convergence` re-run green
  (no regression). Did NOT run the full integration suite (long, network-heavy) — only
  the three control-convergence scenarios.

## Honest gaps / where to look hard (reviewer: treat this as a floor)

- **Delete-while-alone is NOT durable — this is the biggest open item (security-relevant).**
  `removePeer` is a physical delete; once committed local-only the row is gone, so a
  re-issued `delete … where PeerId = X` matches nothing and does **not** propagate (a
  revoked peer can persist as a member elsewhere). Shipped disposition per the ticket's
  permitted fallback: **log loudly** at commit-alone time + best-effort re-issue
  (helps only if the row is still present) + documented + **follow-up ticket filed**
  (`tickets/backlog/control-delete-while-alone-tombstone.md`, needs a schema tombstone).
  Consequence: the remove-while-alone path is **unit-tested only** (queueing + best-effort
  re-issue), NOT proven to converge end-to-end — verify the unit assertions match the
  intended contract and that the loud log + follow-up are adequate, or escalate.
- **Coarse proxy.** `getConnections() === 0` over-approximates "alone": a write made
  while connected to a non-block-cluster peer (or a relay) could still be local-only
  yet NOT be queued. The agreed first cut leans on the cohort's periodic pull-on-read
  + heartbeat as a second convergence path. The precise fix would consult the block's
  `getClusterSize` (no seam exposed today). Confirm this is acceptable.
- **Re-issue timing / no continuous retry.** The drain fires on the `connection:open`
  edge only — deliberately not on every reconcile tick (the ticket warned against a
  re-touch storm). If a re-issue races ahead of FRET seating the block's cluster, it
  could re-commit local-only and stay queued until the next 0→≥1 edge (a full
  disconnect→reconnect), with no retry while continuously connected. In practice the
  integration tests converge sub-second, but consider whether a bounded retry (or a
  reconcile-driven drain while items remain) is warranted for flakier networks.
- **Reconstruction over-applies.** It re-touches ALL `Sig`-null membership rows on
  first growth (the authority signature isn't stored, so "rows I authored" can't be
  filtered) — harmless (monotonic) but O(rows) write amplification on the first
  connect after a restart for large member sets.
- **Test connection is manual.** Both integration scenarios form the cohort with a
  test-only `dial()` (as the sibling convergence scenario does); only the
  re-replication is production. A scenario where proactive dial forms the connection
  AND the write was made earlier-while-alone would exercise the full production path.
- **DeviceToken/clearDeviceToken deletes** have the same physical-delete gap as
  `removePeer` (lower severity — a stale push token); folded into the tombstone
  follow-up, not separately handled here.
