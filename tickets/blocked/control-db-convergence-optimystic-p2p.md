description: A test that checks whether a party's control database replicates a peer row from one node to a second connected node fails intermittently, because the underlying peer-to-peer networking library (in the separate ../optimystic project) can't reliably form a two-node cluster and keeps rejecting or dropping the write.
blocked-reason: external-dependency (../optimystic p2p substrate)
files:
  - packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts
  - ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
  - ../optimystic/packages/db-core/src/transactor/network-transactor.ts
  - docs/STATUS.md
difficulty: hard
----

**Category (b): dependency outside this repo.** The failure originates entirely in the
linked sibling workspace `../optimystic` (the peer-to-peer database substrate), not in
any Sereus code. **What unblocks it:** an optimystic-side fix to two-node control-network
convergence — the cluster membership-admission decision and the transport stream-reset —
after which this test goes green. There is no Sereus change that resolves it (see
"Ruled-out" below).

## Failing test

```
cd packages/integration-tests
yarn vitest run control-db-two-node-convergence
```
(package: `@serfab/integration-tests`)

- File: `packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts`
- Name: `Two-node control-DB convergence > replicates an authority-written CadrePeer row
  from node A to node B over the live control network`

Reproduces at HEAD against **freshly-built** deps (the `../optimystic` `dist/` is newer than
its `src/`, so this is not stale-portal-dist build drift). It is **flaky / non-deterministic**:
consecutive runs fail with different p2p-layer signatures.

## Error output (differs run-to-run)

Reproduced this pass:
```
Error: Some peers did not complete:
  <peerB>[block:...](in-flight) cause=The stream has been reset,
  <peerA>[block:...](in-flight) cause=Transaction rejected by validators (2/2 rejected):
    <peerA>: membership-not-admitted:low-confidence-downsize;
    <peerB>: membership-not-admitted:low-confidence-downsize;
  root: The stream has been reset
 ❯ NetworkTransactor.pend        ../optimystic/packages/db-core/src/transactor/network-transactor.ts:502:22
 ❯ TransactorSource.transact     ../optimystic/packages/db-core/src/transactor/transactor-source.ts:96:22
 ❯ Collection.syncInternal/updateAndSync ../optimystic/packages/db-core/src/collection/collection.ts
 ...
Caused by: StreamResetError: The stream has been reset
 ❯ YamuxStream.onRemoteReset     @libp2p/utils/.../abstract-message-stream.js:253:21
```

Prior triage also observed a run that failed *only* with `StreamResetError` (no
validator rejection), and a run that failed *only* with the 2/2
`membership-not-admitted:low-confidence-downsize` rejection — two distinct p2p-layer
failure modes for the same test.

## Root cause (external)

Every failing frame is inside `../optimystic`:
- `db-core` `NetworkTransactor` / `TransactorSource` / `Collection` (the write/sync path),
- `db-p2p` `ClusterCoordinator` membership admission (`membership-not-admitted:low-confidence-downsize`),
- `@libp2p` / `@chainsafe/libp2p-yamux` transport (`StreamResetError: The stream has been reset`).

`membership-not-admitted:low-confidence-downsize` is an optimystic **cluster-node**
sizing/confidence decision: forming a two-node cluster, the coordinator can't admit
membership because confidence is too low, so the write's validators reject 2/2. The
stream-reset variant is transport-level. Neither touches `CadreControl` / `CadrePeer` or
any cadre-core code.

`docs/STATUS.md` already characterizes this exact behavior as external:
- The "Optimystic blocker (root cause — sibling repo `../optimystic`, HEAD past v0.14.1)"
  section (~line 484): multi-coordinator control-network **writes** can't reach a
  super-majority.
- The Option-B membership section (~line 552): "**Not** a super-majority-threshold
  rounding bug … The defect is upstream of the count (peer selection / protocol
  negotiation), and is optimystic-side networking work, not a one-line sereus change."

## Ruled-out (why this is not a Sereus-side fix)

- **Not stale portal-dist:** `../optimystic` `dist/` timestamps are newer than its `src/`
  — deps are freshly built; the failure is genuine runtime behavior, not build drift.
- **Not a test-harness misconfiguration:** the Sereus test wires a normal two-node control
  cohort (`bootPair` → `connectControlNodes`, both sides confirm the connection before the
  write) exactly as the passing strand convergence scenarios do. There is no Sereus knob
  that raises the optimystic cluster's admission confidence for a 2-node cluster.
- **The single-node authority write path is green:** `cadre-host-authority-node`
  "accept-phone authorizes a peer, then removePeer deletes it" passes, as do the cadre-core
  unit/constraint specs — so the voucher insert/delete through the schema predicates works;
  only the multi-node p2p convergence leg is flaky.

## What unblocks / next step (in ../optimystic, not here)

The fix belongs in the `../optimystic` workspace: make two-node control-network convergence
reliable — (a) the `ClusterCoordinator` membership admission must admit a legitimate
two-node cluster rather than emitting `low-confidence-downsize`, and (b) the Yamux/libp2p
transport stream-reset during the promise/commit phase must be handled (retry / prefer
direct connection) so a two-node write completes. This intersects the already-tracked
optimystic work referenced in `docs/STATUS.md` (multi-coordinator write super-majority /
cross-network coordinator selection). Once landed and the built `dist/` is linked here,
re-run the command above to confirm green, then remove this ticket's entry from
`tickets/.pre-existing-known.md`.
