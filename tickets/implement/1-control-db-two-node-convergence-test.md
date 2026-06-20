description: Prove that a membership record written on one of a party's nodes actually becomes visible to a second node over the live network — the thing the current tests stub out — and document exactly what has to be true for that to happen.
prereq:
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts, packages/integration-tests/src/harness/test-network.ts, packages/integration-tests/src/harness/wait-utils.ts, packages/cadre-core/src/cadre-node.ts (getControlDatabase/isMember/resolvePeerAddrs/registerSelf, lines ~577-807, 1717-1810), packages/cadre-core/src/control-database.ts (queryCadrePeers/queryPeerRecord/countRows), packages/cadre-core/src/seed-bootstrap.ts (authorizePeer/insertSelfPeerRecord), docs/architecture.md (lines ~155, 169, 177)
difficulty: hard
----

## Background — the design question is settled: YES, the control DB replicates P2P

Research (this ticket's plan stage) confirmed that the `CadreControl` store **is designed to converge peer-to-peer** across a party's cadre nodes, using the **same** Optimystic network transactor that demonstrably converges for strand databases in this very harness:

- The control DB is built with `optimysticPlugin(db, { default_transactor: 'network', default_network_name: 'control-<partyId>', ... })` and a `coordinatedRepo` from the control libp2p node (`control-database.ts:176-200`).
- Convergence linchpin: every SQL table maps to an Optimystic `Tree` collection whose header block id **equals the deterministic collection id** (the table's tree URI `control-<partyId>/CadrePeer`). The id is identical on every node for the same party, so node A and node B hash to the **same FRET coordinate** and `findCoordinator`/`findCluster` resolve the **same** responsible cohort. Node B's read routes to whoever holds the block A wrote.
- The write path replicates via cluster 2-phase consensus (`CoordinatorRepo` / `ClusterCoordinator`); the read path pull-repairs missing blocks from the cohort over the sync protocol. This is the same machinery that `convergence-stress.integration.ts` exercises for strands ("Optimystic convergence is read-driven: a peer observes another peer's appends when it reads").

So the `docs/architecture.md` claims that `CadrePeer` is the "replicated" authoritative form (lines ~155, 169) are **correct in intent** — they are NOT to be deleted. They are missing only a *convergence-prerequisites* caveat (added in this ticket).

### Why the earlier two-node attempt saw no convergence after 24s

Not because the receiver lacked a control DB — `CadreNode.start()` unconditionally builds one (`cadre-node.ts:302`, public via `getControlDatabase()` at 1717). The cause was **(b)+(c)**:

- **(c) write-while-alone → local-only.** A write commits to local storage only when the block's FRET cohort size ≤ 1 (`optimystic` `coordinator-repo.ts`, the `getClusterSize(blockId) <= 1` branch in pend/commit). The authority wrote the `CadrePeer` row before the second node was placed in its keyspace cohort, so the row was stranded on the writer's local store with no broadcast.
- **(b) cohort never formed A↔B for the control key.** A later read on B only pulls A's block if `findCluster` placed A in B's cohort with a reachable address. The strand tests achieve this with an **explicit direct `dial()` + both-sides connection wait + read-driven poll** (`strand-formation-e2e.integration.ts:413-445`, `convergence-stress.integration.ts:217-225,309-318`). The control plane has **no equivalent** — control-network cohort discovery is the production gap tracked separately in `control-network-cohort-discovery` (plan/). Plain bootstrap/relay connectivity did not form the cohort within 24s.

## What this ticket builds

A **real two-node control-DB convergence integration test** that proves a `CadrePeer` row written on node A becomes readable on node B over the live control network — using the proven strand recipe (direct dial + both-sides wait + read-driven poll), with the cohort populated **before** the write so the commit does not take the local-only branch.

This is a foundational regression anchor. It validates the architecture and unblocks `2-push-wake-replication-backed-authorization` (which removes the local-seeding workaround in push-wake-e2e). It uses a **test-only manual dial** to stand in for the not-yet-built production cohort discovery — exactly as the strand tests do — and says so in comments.

### Test shape (TDD — expected outputs)

Two `CadreNode`s on one party, each its own authority (mirror `makeOwnAuthority` in push-wake-e2e), each with its own `ControlDatabase` via `getControlDatabase()`:

- **Primary assertion — connect-then-write converges.**
  1. Start A and B. Establish a **direct** control-network connection: dial A's control multiaddr from B (`B.<controlNode>.dial(aAddr)`), then `waitUntil` **both** sides report a connection (so FRET can place each peer in the other's cohort). Expose the control libp2p node to the test (add a minimal accessor or reuse an existing one — do NOT widen the public surface more than needed).
  2. On A: authority-sign + insert a `CadrePeer` row for a third peer id `X` (use `A.getSeedBootstrapService().authorizePeer({ peerId: X })` or `insertSelfPeerRecord`). The cohort is now ≥2, so the commit replicates rather than going local-only.
  3. On B: poll-read `B.getControlDatabase().queryCadrePeers()` (read-driven convergence) via a `waitUntil`/`waitForCount` loop. **Expected:** within a bounded timeout (start ~20s, tune down) B observes the row for `X`. Assert `peerId === X` present.
  4. Stronger end-to-end: assert `await B.isMember(X) === true` (the production authorization gate), proving convergence — not local seeding — satisfies the gate.

- **Secondary / characterization — write-then-connect (documents the local-only edge).**
  Write on A *before* connecting B, then connect, then poll-read on B. Document the observed behavior in the test (a comment + an assertion that matches reality): does pull-on-read read-repair heal a row that committed local-only while A was alone? If it converges, assert it; if it does NOT within the window, mark it `it.skip`/`it.todo` with a comment pointing at `control-network-cohort-discovery` and the `getClusterSize <= 1` local-only branch. Do not let an indeterminate result fail the suite — the point is to record the production-relevant boundary, not to force a behavior the cohort-discovery ticket owns.

### Harness helper

Add a cross-node convergence waiter to the harness so future scenarios reuse it (the existing `waitForControlSync` is explicitly scoped to *one* DB per party — `test-network.ts:204-235`):

- `waitForCrossNodeControlSync(readerDb: ControlDatabase, predicate, opts)` (or a `queryCadrePeers`-based count waiter against an arbitrary node's DB) built on `wait-utils.ts`. Keep `waitForControlSync`'s single-party scope intact and document the new helper's broader scope.

### Doc correctness pass (in this ticket)

In `docs/architecture.md`, near the existing `CadrePeer` "replicated" language (lines ~155, 169, 177), add a short **Convergence prerequisites** note (do not contradict or delete the existing claims):
- Control-DB convergence is real but requires the control collections' **cohort/cluster to form** (cadre nodes actually connected, FRET routing populated) — not merely a bootstrap link.
- A write made while a node is alone (cohort ≤1) commits **local-only** and propagates only once the cohort forms (re-publish or pull-on-read repair).
- Reads are **pull-on-read**: `resolvePeerAddrs`/`isMember` do a single read with no wait, so callers converge by **polling/refresh** (already noted as "periodic refresh until reactivity" at line ~177). Point to `control-network-cohort-discovery` for the production auto-connect mechanism.

## Edge cases & interactions

- **Local-only commit (cohort ≤1 at write time):** the primary assertion MUST connect before writing; otherwise it silently exercises the stranded-write path and may flake. Make the both-sides connection wait a hard precondition of the write step.
- **Direct vs relayed connection:** a `/p2p-circuit` (relay-only) link may not seat peers in each other's FRET cohort for the control key the way a direct dial does. Prefer a direct dial between A and B (both on localhost in-harness). If a relay node is introduced, assert a non-relay path formed (see `getConnectionPaths`, `cadre-node.ts:243`) before relying on convergence.
- **Read-repair window timing:** a *missing* block always triggers a cluster fetch, but a present-but-stale block respects the lazy read-repair window (~10s). Poll long enough; do not assert on the first read.
- **clusterSize 3 with only 2 nodes:** `clusterSize: 3` + `clusterPolicy.allowDownsize` (`cadre-node.ts:510`) means the effective replica set can shrink to the live mesh. With 2 nodes the writer staying online is required for B to fetch — keep A running for the whole assertion.
- **Authority identity vs transport peer id:** `authorizePeer` derives `PublicKey` from the (Ed25519) peer id; `isMember`/`resolvePeerAddrs` re-check the `publicKey<->peerId` binding and self-signature. Use a real Ed25519 peer id for `X` (or use B's own peer id and have A authorize B, then assert `B.isMember(B.peerId)` after convergence — simplest and exercises the real gate).
- **Teardown / port leaks:** follow the existing scenarios' afterEach shutdown (`network.shutdown()` / per-node `stop()`); release ports. Two full nodes + Optimystic are heavy — keep timeouts streamed (`tee`) if you add a long-running validation, and keep the suite under the 10-min idle window.
- **Flakiness budget:** convergence is timing-dependent. Use generous `waitUntil` timeouts with small intervals (250ms) rather than fixed sleeps; assert on the converged predicate, not on elapsed time.

## TODO

- Add a control-node accessor usable by the test (minimal; reuse existing `getMultiaddrs()` for the dial target and add only what's needed to call `.dial()` on the control node, or have the test dial via an existing seam).
- Implement `waitForCrossNodeControlSync` (or equivalent reader-scoped waiter) in the harness on top of `wait-utils.ts`.
- Write `control-db-two-node-convergence.integration.ts`: primary connect-then-write convergence assertion (`queryCadrePeers` + `isMember`), plus the characterization write-then-connect case (skip/todo if indeterminate).
- Add the **Convergence prerequisites** note to `docs/architecture.md` (do not remove the existing "replicated" claims).
- Run the integration suite for the new file (and the push-wake/strand-formation scenarios to confirm no regression); type-check + lint the integration-tests and cadre-core packages.
- Hand off honestly: if the primary assertion does not converge despite connect-then-write + both-sides wait + polling, do NOT force-pass it — document the exact failure (with optimystic `debug` logs) in the review handoff and note it likely belongs to `control-network-cohort-discovery`.
