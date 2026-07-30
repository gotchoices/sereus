----
description: When a write loses a race to another machine, the two write paths disagree about whether that is worth retrying — single-table writes retry, multi-table writes give up. Make the losing response say plainly that it is a lost race so both paths agree.
files: ../optimystic/packages/db-core/src/network/struct.ts, ../optimystic/packages/db-core/src/network/index.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/testing/test-transactor.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-core/test/coordinator.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts
difficulty: medium
----

# Make "you lost the race" an explicit field on the failure response

All work is in the sibling `../optimystic` workspace (separate git repo, linked into Sereus via
`resolutions`), currently on branch `main` with the prior ticket's changes still uncommitted in the
tree. No Sereus source changes.

## Confirmed reproduction

Added a throwaway spec (`db-core/test/zz-repro-tmp.spec.ts`, since deleted) that drives
`TransactionCoordinator.pendPhase` with two collections where one collection's `pend` returns
exactly what `CoordinatorRepo.classifyStaleRejection` returns today — `{ success: false, reason:
'stale revision: block c1-tail at rev 3, requested rev 3' }`, no `missing`, no `pending`:

```
1) REPRO: reason-only confirmed stale loss in pendPhase
     should classify a confirmed optimistic-concurrency loss as retryable (staleLoss=true):
     confirmed lost race must be retryable
     - false
     + true
```

`pendPhase` returned `staleLoss: false`, i.e. "hard rejection, don't retry", for a confirmed lost
race. That is the bug. The single-collection writer (`Collection.sync`) is unaffected — it retries
on any non-success and reads `reason` only for diagnostics
(`db-core/src/collection/collection.ts:333`).

## Why the failure response is reason-only in the first place

`CoordinatorRepo` (`db-p2p/src/repo/coordinator-repo.ts:705`) confirms the loss by re-reading its
own storage, which tells it the revision is taken but not which actions took it. It reaches storage
only through the narrower `IRepo` interface, which exposes no revision listing.

Two ways out were evaluated. **Reconstructing the `missing` list is the wrong one:**

- Delegating confirmation to `storageRepo.pend` is unsafe, not merely awkward. `StorageRepo.pend`
  is **side-effecting**: when it finds no conflict it calls `savePendingTransaction` for every
  block (`db-p2p/src/storage/storage-repo.ts:404-408`). Calling it to "confirm" a rejection would
  leave a local pending action behind for a write the cluster already refused, and nothing cancels
  it. It also *throws* when a listed revision's transform is unreadable (line 360), converting a
  confirmed loss back into a throw — the exact failure mode this whole line of work removes.
- Widening `IRepo` with revision listing purely to rebuild evidence is disproportionate, **and the
  evidence is never read.** Grepped every consumer of `StaleFailure.missing` across `db-core`: the
  contents are only counted or logged (`network-transactor.ts:522,639,673`,
  `coordinator.ts:935`). Nothing rebases from them. So the whole list would be reconstructed at
  real cost to feed a `.length > 0` test.

**Chosen approach: stop inferring retryability from payload shape.** Add one explicit field and one
shared predicate, so both writers read the same response the same way.

## Design

In `db-core/src/network/struct.ts`, add to `StaleFailure`:

```ts
export type StaleFailure = {
	success: false;
	reason?: string;
	missing?: ActionTransforms[];
	pending?: ActionPending[];
	/**
	 * Explicit retryability. True when this failure is an optimistic-concurrency loss — the
	 * requested revision was taken, or a rival pend holds the blocks — so a re-read, rebase and
	 * re-pend can win. Set it only when the producer genuinely classified the failure; leave it
	 * absent otherwise, and consumers fall back to inferring from `missing`/`pending`.
	 */
	conflict?: boolean;
};
```

`struct.ts` is types-only, so the predicate gets its own module (e.g.
`db-core/src/network/stale-failure.ts`) re-exported from `db-core/src/network/index.ts`:

```ts
/**
 * The single rule for "is this non-success retryable after a re-read?" Both write paths and the
 * transactor's aggregation call this — no consumer re-derives it.
 *
 * `conflict` is authoritative when present. The `missing`/`pending` fallback covers producers that
 * have not been taught the field, including a remote peer on an older build (the repo protocol is
 * plain JSON, so an unset field simply arrives absent).
 */
export function isConflictFailure(failure: StaleFailure): boolean {
	return failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length);
}
```

Wire path is JSON end to end (`db-p2p/src/protocol-client.ts:141`,
`db-p2p/src/repo/service.ts:274`) with no field whitelist, so the new field crosses the network
without codec work. But `NetworkTransactor.pend` **rebuilds** the `StaleFailure` from the per-batch
responses rather than forwarding one (`db-core/src/transactor/network-transactor.ts:519-523`), so
the field is dropped unless that aggregation is taught to carry it. That is the step that is easy
to miss and that makes the fix a no-op if skipped.

## Scope boundary

The commit-side rules that also key on payload shape — `commitCollection` treating every returned
non-success as a retryable stale loss (`coordinator.ts:1041-1060`), and `ClusterRepo`'s
ahead-vs-behind divergence test on `result.missing?.length`
(`db-p2p/src/cluster/cluster-repo.ts:1275-1297`) — are **out of scope**. They are a different
question (tolerate-vs-propagate for a commit, not retry-vs-fail for a pend) and are correct today.
Do not set `conflict` on `StorageRepo.commit`'s failures in this ticket; leave those rules reading
`missing` as they do now.

## Constraints carried forward

- Keep `classifyStaleRejection` conservative exactly as it is: confirmation stays a local re-read,
  and the free-text rejection reason is never parsed. It rides inside a signed vote payload and
  must not become control flow.
- `Collection.sync` must not start depending on `conflict`. It retries on any non-success; that
  stays true.
- Do not make the coordinator treat every reason-only response as retryable. Genuine hard
  rejections (storage faults, validator policy) also arrive reason-only, and re-driving those burns
  the whole retry budget.

## TODO

- Add `conflict?: boolean` to `StaleFailure` in `db-core/src/network/struct.ts` with the doc comment
  above.
- Add `isConflictFailure` in a new `db-core/src/network/stale-failure.ts`, exported via
  `db-core/src/network/index.ts`.
- Set `conflict: true` in `CoordinatorRepo.classifyStaleRejection`
  (`db-p2p/src/repo/coordinator-repo.ts:726`) and update its doc comment — it no longer returns a
  "reason-only" failure.
- Set `conflict: true` on `StorageRepo.pend`'s three optimistic-concurrency returns: the `missing`
  branch (`storage-repo.ts:374`) and both `pending`-policy branches (`'f'` at 382, `'r'` at 384).
  Leave the validation-failure return (line 325) without the field — it is a hard rejection.
- Teach `NetworkTransactor.pend`'s stale aggregation (`network-transactor.ts:519-523`) to propagate
  retryability: set `conflict` from whether any stale batch response satisfies
  `isConflictFailure`. Keep the existing `reason` and `missing` passthrough unchanged.
- Replace the shape inference in `TransactionCoordinator.pendCollection`
  (`coordinator.ts:935`) with `isConflictFailure(pendResult)`, and update the comment above it to
  describe the field-plus-fallback rule instead of the missing/pending rule.
- Update `TestTransactor` (`db-core/src/testing/test-transactor.ts:195,203,219,299,307,440`) so its
  stale returns set `conflict` where they model a lost race and leave it absent where they model a
  hard rejection. It is shipped test infrastructure other packages build against, so its shapes
  should match what real producers now emit.
- Add a permanent regression test in `db-core/test/coordinator.spec.ts` (`pendPhase` describe) built
  from the reproduction above: a collection whose pend returns `{ success: false, conflict: true,
  reason: 'stale revision: …' }` must yield `staleLoss: true`, and one returning a reason-only
  failure with no `conflict` must still yield `staleLoss: false`. The existing
  `InstrumentedTransactor.failCollections` path already models the hard-rejection half — keep its
  current assertions passing.
- Extend `db-p2p/test/coordinator-repo-stale-classification.spec.ts` to assert the returned
  `StaleFailure` carries `conflict: true`, alongside the existing `reason` assertion.
- Validate: `cd ../optimystic/packages/db-core && yarn test 2>&1 | tee /tmp/db-core.log`, then the
  same for `packages/db-p2p`. Stream the output — do not silently redirect.
