----
description: When two machines write to the party's control database at the same instant, the loser should quietly re-read and try again — instead it dies with a hard error and can leave a row half-written. Make the loser retry, which is what the code one layer up is already waiting to do.
files: ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/cluster/cluster-repo.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/collection/collection.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
difficulty: hard
----

# Classify a stale-revision cluster rejection as a retryable failure, not a thrown error

A concurrent-write conflict is meant to be routine: the loser re-reads, rebases, retries.
`Collection.sync` already does exactly that (bounded backoff + jitter, ~10 attempts). The retry
never runs, because the conflict arrives as a **thrown exception** instead of the `StaleFailure`
**return value** the retry loop keys on. The SQL layer flushes each tree (main table, then each
index) as its own commit, so the escaping throw lands mid-sweep and splits the write across trees.

## Confirmed reproduction (fix stage, 2026-07-29, HEAD `7be4675`)

From `packages/integration-tests`, scenario must run **alone**:

```
yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

25 valid runs: **18 pass, 2 Shape A, 5 Shape B** (~28 % failure). A passing run takes ~15 s; a
failing one ~45 s. Shape B turned out to be a **different defect** and is now tracked separately —
see "Scope" below. This ticket covers **Shape A only**.

Before running, both `@serfab/cadre-core` and `@serfab/cadre-host` needed a rebuild; the suite's
build-freshness gate (`packages/integration-tests/src/harness/build-freshness.ts`) refuses to run
otherwise. It also aborts whenever a sibling repo (`../quereus`, `../optimystic`) has `src` newer
than `dist` — which happens whenever another agent is mid-edit there. That is deliberate (see the
module comment); tolerate it by retrying, do not weaken the gate.

## The chain, verified against current source

Each link checked by reading the file at the stated line, and each observed in the captured log.

1. `db-p2p/src/cluster/cluster-repo.ts:1056-1063` — a cluster member validating a `pend` finds the
   block already at the requested revision and votes reject with
   `reason: "stale revision: block <id> at rev N, requested rev N"`. Correct detection.
2. `db-p2p/src/repo/cluster-coordinator.ts:324-337` — enough members rejected that super-majority
   is impossible, so `executeTransaction` does
   `throw new Error("Transaction rejected by validators (…)")`. The reason is flattened into the
   message string and otherwise discarded; a retryable stale loss and a genuine validation fault
   become indistinguishable.
3. `db-p2p/src/repo/coordinator-repo.ts:684-687` — `pend`'s `catch` logs and re-throws
   unconditionally.
4. `db-core/src/transactor/network-transactor.ts:490-519` — `pend` collects `stale` as batches that
   returned a non-success **response** (line 511). A batch that **threw** is `isError`/`in-flight`,
   never a response, so `stale.length === 0` and line 519 does `throw error`.
5. `db-core/src/transactor/transactor-source.ts:96` — `transact` returns `pendResult` only when it
   is a value; a throw propagates straight through.
6. `db-core/src/collection/collection.ts:330` — `syncInternal` retries only `if (staleFailure)`.
   Nothing thrown reaches the backoff/`updateInternal()`/replay path.
7. `quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:402` —
   `commitDirtyTreesLegacy` flushes each dirty tree in its own `tree.sync()`. The `CadrePeer` table
   tree succeeded, the `_uniq_5` index tree threw, and trees already committed cannot be
   un-committed → `PartialCommitError`. That is the documented behaviour of that path (see the
   warning block above `commitTransaction`), not a bug in it.

**One-line statement:** a stale-revision rejection from cluster consensus is a retryable
optimistic-concurrency loss, but `db-p2p` surfaces it as a thrown error, so `Collection.sync`'s
retry loop never sees it and the per-tree commit sweep splits the write.

### Captured evidence (Shape A)

The aggregate error at `network-transactor.ts:502` in the captured failure:

```
Some peers did not complete:
  <peerB>[block:9Lfsu…](in-flight) cause=The stream has been reset,
  <peerA>[block:YHyOl…](in-flight) cause=Transaction rejected by validators (1/2 rejected):
      <peerA>: stale revision: block YHyOl… at rev 1, requested rev 1,
  <peerC>[block:9Lfsu…](in-flight) cause=Can not dial self,
  <peerC>[block:YHyOl…](in-flight) cause=The stream has been reset,
  <peerA>[block:9Lfsu…](in-flight) cause=Transaction rejected by validators (2/2 rejected): …
  ; root: The stream has been reset
```

wrapped as

```
PartialCommitError: Legacy multi-tree commit was not atomic: 1 tree(s) were durably committed …
  Persisted: [default/CadrePeer]  Not persisted: [default/CadrePeer/index/_uniq_5]
```

Two details this adds beyond the fix-stage analysis, both load-bearing for the fix:

- **Every batch is `(in-flight)`.** Not one is a response, which is precisely why
  `stale.length === 0` at `network-transactor.ts:511`. The stale rejection reached the caller only
  as a *transport-level error on a batch*, never as a `PendResult`.
- **`root:` is the transient error, not the rejection.** `firstBatchError` picked
  `The stream has been reset`. So the aggregate's `cause` is a red herring for anyone trying to
  classify at that layer — another reason the classification must happen at the coordinator, before
  the throw crosses the wire.
- Stale and genuinely transient failures **co-occur in one pend**. The fix must survive a mixed
  batch set. `network-transactor.ts:511-518` already handles this correctly: any stale non-success
  response preempts the transient errors and returns a `StaleFailure`.

### Where the concurrency comes from

Owner `A` is the sole writer of every row the assertions hinge on, but not the sole writer of the
*tree*: receiver `Rx` runs `registerSelf` in the background (best-effort, non-fatal,
`packages/cadre-core/src/cadre-node.ts:1100`), writing its own `CadrePeer` row from a different
node. Both nodes compute `newRev = 1` for the same index block, both pend, one loses. Normal
optimistic concurrency; must not be fatal. The rev in the capture is **1** — the first write to
that index block — so this is not a lagging-reader problem.

## Recommended fix

`coordinator-repo.pend` catches the validator rejection, re-reads the affected block states from
its own `storageRepo`, and returns a `StaleFailure` when the local view confirms
`latestRev >= request.rev`. A reason-only `StaleFailure` (`{ success: false }` with no `missing`)
is already a supported shape — `coordinator-repo.commitBlock` (`coordinator-repo.ts:627-635`) has
an explicit note describing exactly that case on the commit side. Returning it makes the batch a
non-success **response**, so `network-transactor.ts:511-518` takes the stale branch and
`Collection.sync` retries.

Purely local decision from local state; no protocol field, no wire change, no signed-payload
change.

### Constraints — read before choosing anything else

- **Do not classify by string-matching the reason text.** `rejectReason` is free-form and is *part
  of the signed vote payload* (`cluster-repo.ts:704-707`,
  `payload = hash + ':' + type + ':' + rejectReason`). Matching `/^stale revision/` would make a
  wire-visible human-readable string load-bearing for control flow.
- **A typed rejection code is a protocol revision.** Any new field on the cluster signature
  (`db-core/src/cluster/structs.ts`) that participates in `computeSigningPayload` changes what every
  peer signs and verifies; mixed-version cohorts would fail signature verification. Do not take this
  option without treating it as such.
- **Preserve the `PartialCommitError` contract.** It exists to refuse to falsely claim a rollback.
  Do not weaken or swallow it — the fix is upstream, so it should simply stop firing.
- **Keep the retry bounded.** `Collection.sync` defaults to 10 attempts / ~21 s
  (`collection.ts`, `DefaultMaxAttempts`). A genuine, persistent, non-stale validator rejection must
  still fail fast rather than spin.
- **Do not serialize writes in `cadre-core`.** The writers are on different nodes; a local mutex
  cannot see them. Suppressing `Rx.registerSelf` would hide the race and break the production
  behaviour the scenario protects.

## Scope

**Shape A only.** The second failure shape observed in the same scenario — a 30 s timeout with the
message `Timeout waiting for S resolves Rx's address record via replication` — was investigated at
fix stage and is **not** this defect: 4 of 5 captured Shape-B failures contain zero
`cluster-member:validation-stale-revision` events, zero `cluster-tx:rejected-by-validators`, and no
`PartialCommitError`. It is now tracked as `bug-control-db-rx-record-never-converges-on-sender`.

Consequence for validation: **fixing this ticket will not make the scenario green.** Shape B was
the majority of observed failures (5 of 7). Expect the failure rate to drop from ~28 % to roughly
20 %, with every remaining failure being the replication timeout. Judge this ticket by the
disappearance of `PartialCommitError` / `Transaction rejected by validators` from the run, not by a
green suite.

## Cross-cutting obligations

- **Upstream repo.** The fix lands in `../optimystic` (`db-p2p`, possibly `db-core`), which this
  pipeline has modified before — `tickets/complete/0-control-db-convergence-optimystic-p2p.md`
  records four such commits. Rebuild the touched sibling packages
  (`cd ../optimystic && yarn workspace @optimystic/<pkg> build`) before re-running integration
  tests; sereus consumes their built `dist/`, not their `src/`.
- **No determinism edition bump, no golden fixture, no migration** — this changes error
  classification and retry behaviour, not stored bytes or schema.
- Not related to `bug-control-cohort-no-auto-dial` (connection establishment; here all three nodes
  are explicitly meshed before any write) or to the archived
  `control-db-convergence-optimystic-p2p` (replication read path).

## TODO

- [ ] Add a unit-level regression in `../optimystic` for the classification: two concurrent pends on
      one block via the cluster path → the loser gets a `StaleFailure` **return**, not a throw, and
      its subsequent `Collection.sync` attempt succeeds at the next rev.
- [ ] Add a regression asserting a *non*-stale validator rejection still throws / fails fast and is
      not retried, so the classification is not "retry everything".
- [ ] Add a regression for the mixed case: one batch stale-rejected, one batch failing with a
      transport error → still classified stale and retried (matches the captured evidence).
- [ ] Land the classification in `coordinator-repo.pend` per the recommended shape.
- [ ] Rebuild the touched sibling packages.
- [ ] Re-run the scenario **20×** alone. Assert zero occurrences of `PartialCommitError` and of
      `Transaction rejected by validators` escaping to the test. Do **not** expect zero failures —
      see "Scope".
- [ ] Re-run the full `packages/integration-tests` suite; confirm no regression against the current
      baseline.
- [ ] Update the `tickets/.pre-existing-known.md` entry: this slug drops off it, the Shape-B slug
      stays.
