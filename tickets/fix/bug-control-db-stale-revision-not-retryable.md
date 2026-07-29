----
description: When two machines happen to write to the party's control database at the same instant, one of them does not simply lose the race and try again — it dies with a hard error, and can leave a row half-written (the row itself saved, its index entry not). Shows up as an intermittent failure of the three-node push-wake test, roughly two runs in ten.
files: packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, packages/cadre-core/src/seed-bootstrap.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts
difficulty: hard
----

# Optimistic-concurrency loss on a control-DB write is thrown, not retried

A concurrent-write conflict is supposed to be *routine*: the loser re-reads, rebases, and retries.
`Collection.sync` already implements exactly that (bounded backoff + jitter, ~10 attempts). The
retry never runs here, because the conflict arrives as a **thrown exception** instead of the
`StaleFailure` **return value** the retry loop keys on. Because the SQL layer flushes each tree
(main table, then each index) as its own commit, that escaping throw lands mid-sweep and splits
the write across trees.

## Reproduction

From `packages/integration-tests`:

```
yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

Measured on 2026-07-29 at HEAD (`a12e72f`), sibling `dist/` confirmed fresh (no source newer than
its build output in either `../quereus` or `../optimystic`): **3 failures in 10 runs** (runs 4, 8,
10) — at or above the rate in the triage report. Scenario must be run **alone** — `-t`-filtered.
Whole-file runs mask it.

Two shapes; run 4 was Shape A, runs 8 and 10 Shape B:

**Shape A — split write (run 4 of 10).** The main `CadrePeer` tree committed; its unique index did not.

```
Error: Some peers did not complete: <peerA>[block:YDCR3xoIoYjfEVmY5RLxeodop0fPLHetvMc4Yn6bwng](in-flight)
  cause=Transaction rejected by validators (2/2 rejected):
    <peerA>: stale revision: block YDCR3xoIoYjfEVmY5RLxeodop0fPLHetvMc4Yn6bwng at rev 1, requested rev 1;
    <peerB>: stale revision: block YDCR3xoIoYjfEVmY5RLxeodop0fPLHetvMc4Yn6bwng at rev 1, requested rev 1,
  <peerC>[block:…](in-flight) cause=The stream has been reset,
  <peerB>[block:…](in-flight) cause=The stream has been reset
  at ClusterCoordinator.executeTransaction (../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts:337:10)
```

which the SQL layer wraps as (per the triage report's capture of the same shape):

```
PartialCommitError: Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed
  to storage before the commit failed and CANNOT be rolled back.
  Persisted: [default/CadrePeer]  Not persisted: [default/CadrePeer/index/_uniq_5]
  at SeedBootstrapService.insertCadrePeerRow (packages/cadre-core/src/seed-bootstrap.ts:343)
```

**Shape B — silent loss (runs 8 and 10 of 10; the more common shape).**

```
Error: Timeout waiting for S resolves Rx's address record via replication after 30000ms
```

## Root cause — the chain, link by link

Read in this order; each link is a named file:line, not a guess.

1. **`cluster-repo.ts:1011`** — a cluster member validating a `pend` finds the block already at the
   requested revision and votes reject with
   `reason: "stale revision: block <id> at rev N, requested rev N"`. This is the *correct*
   detection of an optimistic-concurrency loss.
2. **`cluster-coordinator.ts:337`** — enough members rejected that super-majority is impossible, so
   `executeTransaction` does `throw new Error("Transaction rejected by validators (…)")`. The
   *reason* for the rejection is flattened into the message string and otherwise discarded. A
   retryable stale loss and a genuine validation fault are now indistinguishable.
3. **`coordinator-repo.ts:643-646`** — `pend`'s `catch` logs and re-throws unconditionally.
4. **`network-transactor.ts:489-518`** — `pend` collects `stale` as *batches that returned a
   non-success **response***. A batch that **threw** is `isError`/`in-flight`, never a response, so
   `stale.length === 0` and the branch at line 517 does `throw error` instead of returning
   `{ success: false, missing: […] }`.
5. **`transactor-source.ts:96-97`** — `transact` returns `pendResult` only when it is a value;
   a throw propagates straight through.
6. **`collection.ts:330-331`** — `syncInternal` retries only `if (staleFailure)`. Nothing thrown
   ever reaches the backoff/`updateInternal()`/replay path. The whole retry mechanism is bypassed.
7. **`txn-bridge.ts:396-443`** — `commitDirtyTreesLegacy` flushes each dirty tree in its own
   `tree.sync()`. The `CadrePeer` table tree succeeded; the `_uniq_5` index tree threw at step 6;
   trees 1..N are durably committed and cannot be un-committed, so it raises `PartialCommitError`.
   This is the *documented* behavior of that path, not a bug in it — see the ⚠️ block at
   `txn-bridge.ts:329-338`. The bug is that step 6 threw at all.

**One-line statement of the defect:** a stale-revision rejection from cluster consensus is a
retryable optimistic-concurrency loss, but `db-p2p` surfaces it as a thrown error, so
`Collection.sync`'s retry loop never sees it and the legacy per-tree commit sweep splits the write.

### Where the concurrency comes from

The scenario's design notes say owner `A` is the sole writer of every row the assertions hinge on,
and that holds. But `A` is not the only writer of the *tree*: receiver `Rx` runs `registerSelf` in
the background (best-effort, non-fatal, `cadre-node.ts:600`), which writes its own `CadrePeer` row
from a different node. Both nodes compute `newRev = 1` for the same index block, both pend, one
loses. That is normal optimistic concurrency and must not be fatal. Note the rev in the capture is
**1** — this is the *first* write to that index block, so it is not a lagging-reader problem.

### Shape B is unconfirmed and must be established, not assumed

The 30 s replication timeout is *probably* the same race with the losing write on the other side —
e.g. `Rx`'s swallowed `registerSelf` failure leaves `A`'s `seedReceiverRecord` row split, so `S`
finds a row whose index entry is missing and `resolvePeerAddrs` never passes. **This is a
hypothesis.** Confirm it before fixing: run the loop under `DEBUG='sereus:cadre:*,optimystic:*'`
and check whether a failing Shape-B run contains a stale-revision rejection at all. If it does not,
Shape B is a second defect and this ticket splits. Note Shape B was the *majority* of the observed
failures (2 of 3), so "fixed Shape A, rate dropped a little" is not success.

## Design constraints

- **Do not classify by string-matching the reason text.** `rejectReason` is a free-form string that
  is *part of the signed vote payload* (`cluster-repo.ts:694-700`,
  `payload = hash + ':' + type + ':' + rejectReason`). Matching on `/^stale revision/` would make a
  wire-visible human-readable string load-bearing for control flow.
- **Prefer the fix that needs no wire change.** A reason-only `StaleFailure`
  (`{ success: false }` with no `missing`) is *already a supported shape* — see the explicit note at
  `network-transactor.ts:629-632`. So `coordinator-repo.pend` can catch a validator rejection,
  re-read the affected block states from its own `storageRepo`, and return a `StaleFailure` when the
  local view confirms `latestRev >= request.rev`. That is a purely local decision using local state,
  it needs no new protocol field, and it makes the batch a non-success *response* so
  `network-transactor.ts:505-518` takes the stale branch and `Collection.sync` retries. **This is
  the recommended shape.**
- **If a typed rejection code is added anyway, it is a signed-payload change.** Any new field on
  `ClusterSignature` (`../optimystic/packages/db-core/src/cluster/structs.ts:6`) that participates
  in `computeSigningPayload` changes what every peer signs and verifies. Mixed-version cohorts would
  fail signature verification. Do not do this without treating it as a protocol revision.
- **Preserve the `PartialCommitError` contract.** It exists to refuse to falsely claim a rollback
  (`txn-bridge.ts:348-356`). Do not weaken or swallow it to make the symptom disappear — the fix is
  upstream of it, so it should simply stop firing.
- **Keep the retry bounded.** `Collection.sync` defaults to 10 attempts / ~21 s
  (`collection.ts:289`, `DefaultMaxAttempts`). Converting throws into retryable failures must not
  turn a persistent hard rejection into an unbounded spin — a genuine (non-stale) validator
  rejection must still fail fast.
- **Do not "fix" this by serializing writes in `cadre-core`.** The writers are on different nodes;
  a local mutex cannot see them. Suppressing `Rx.registerSelf` would hide the race, not fix it, and
  would break the production behavior that scenario is there to protect.

## Cross-cutting obligations

- **Protocol / signed byte format** — only if the typed-code option is chosen over the recommended
  one; see constraint 3. The recommended fix triggers none.
- **Upstream repo** — the fix lands in `../optimystic` (`db-p2p`, possibly `db-core`), which this
  pipeline has modified before: `tickets/complete/0-control-db-convergence-optimystic-p2p.md`
  records four such commits (`50af693` → `559df6a`). Rebuild the touched sibling packages
  (`cd ../optimystic/packages/<pkg> && yarn build`) before re-running integration tests — sereus
  consumes their built `dist/`, not their `src/`.
- **No determinism edition bump, no golden fixture, no migration** — this changes error
  *classification* and retry behavior, not stored bytes or schema.

## Relationship to other tickets

- Not covered by `bug-control-cohort-no-auto-dial` (that is connection establishment; here all
  three nodes are explicitly meshed before any write).
- Not covered by the archived `control-db-convergence-optimystic-p2p`, which fixed *replication*
  (revision selection, reconcile, restore-on-read). This is the write path's conflict handling —
  the residual named in the scenario's own design note 1 ("the transactor does not retry").
- `bug-strand-three-party-replication` is a different subsystem. Do not chase it here.

## TODO

- [ ] Confirm Shape B shares this root cause (see above). Split the ticket if it does not.
- [ ] Add a unit-level regression in `../optimystic` for the classification itself: two concurrent
      pends on one block via the cluster path → the loser gets a `StaleFailure` **return**, not a
      throw, and its subsequent `Collection.sync` attempt succeeds at the next rev.
- [ ] Add a regression asserting a *non*-stale validator rejection still fails fast and is not
      retried, so the classification is not "retry everything".
- [ ] Land the classification fix in `coordinator-repo.pend` per the recommended shape.
- [ ] Rebuild the touched sibling packages; re-run the scenario **20×** alone. It is a ~20 % failure
      rate, so fewer than ~20 runs cannot distinguish a fix from luck.
- [ ] Re-run the full `packages/integration-tests` suite and confirm no regression against the
      current baseline (24 of 27 files green).
- [ ] Remove this entry from `tickets/.pre-existing-known.md` once green.
