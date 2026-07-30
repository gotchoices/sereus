----
description: A write that loses a race to another machine is supposed to be retried automatically, and now is — but only for single-table writes. A write that spans several tables still treats the same lost race as a permanent failure and gives up immediately.
files: ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/network/struct.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

# Confirmed lost race is reported in a shape the multi-collection writer reads as "permanent"

Found during the review of `bug-control-db-stale-revision-not-retryable`. That ticket made a
lost concurrent-write race **retryable**: instead of throwing, `CoordinatorRepo.pend` now returns a
"you lost, your revision is taken" response and the caller retries. It works for the
single-collection writer (`Collection.sync`), which retries on *any* non-success response.

It does not work for the multi-collection writer.

## The mismatch

The "you lost" response (`StaleFailure`) has three optional payload fields: `reason` (free text),
`missing` (the newer committed actions the loser hasn't seen), and `pending` (in-flight actions on
the same blocks). The new classifier fills in **only `reason`** — it confirms the loss by re-reading
its own storage, which tells it the revision is taken but not which actions took it.

`TransactionCoordinator.pendPhase` (`db-core/src/transaction/coordinator.ts:930-937`) decides
retryability from the payload, not from the fact of failure:

```ts
// A committed `missing` action or a `pending` action on a touched block is an
// optimistic-concurrency conflict — retryable after a re-read. A bare `reason` is a hard
// rejection (storage/policy) that re-driving won't fix.
const conflict = Boolean(pendResult.missing?.length || pendResult.pending?.length);
throw new PendRejectedError(collectionId, conflict, pendResult.reason);
```

A reason-only response therefore lands in the `conflict = false` bucket — "hard rejection, don't
retry" — which is exactly backwards for a confirmed lost race. Every other producer of this
response (`StorageRepo.pend`) fills in `missing`, so the coordinator's rule has been correct until
now; the new classifier is the first producer to break the assumption the rule rests on.

## Impact and urgency

Not currently reachable from Sereus: the multi-collection (session/coordinator) write mode is
never wired up here — `configureTransactionMode` is called only from Optimystic's own tests. So
this is latent, not a live bug, and no observed failure traces to it.

It is also **not a regression** — before the retry fix this case threw, which the coordinator also
treated as non-retryable. The fix simply did not reach this path. Filing it because it is
definitely wrong the moment multi-collection writes are turned on, and because the two write paths
now disagree about what the same response means, which is the kind of split that rots quietly.

## What a fix needs to establish

- Whether the classifier can cheaply produce the `missing` list. `StorageRepo.pend` already builds
  it (`storage-repo.ts:344-378`) by listing the revisions between the requested one and the current
  latest; `CoordinatorRepo` reaches storage only through the narrower `IRepo` interface, which
  exposes no revision listing — so either the interface widens, or the classifier delegates the
  whole confirmation to `storageRepo.pend` and returns whatever it returns.
  - If delegating: check the failure modes. `StorageRepo.pend` throws if a listed revision's
    transform is unreadable, and its `policy`/`pending` handling can produce a different
    non-success shape than the plain lost-race one.
- Or, whether retryability should stop being inferred from payload shape at all — an explicit
  field on the response ("this is an optimistic-concurrency loss") would let both writers agree
  without either having to reconstruct evidence. Note this changes a shared type used across
  packages.

Prefer whichever keeps the two writers reading the same response the same way. Don't fix it by
special-casing the coordinator to treat every reason-only response as retryable — genuine hard
rejections also arrive reason-only, and re-driving those burns the whole retry budget for nothing.

## Constraints

- Keep the existing conservative gate in `classifyStaleRejection`: confirmation stays local, and
  the free-text rejection reason is never parsed. It is part of a signed vote payload and must not
  become control flow.
- Whatever shape is chosen must keep `Collection.sync`'s current behavior working — it retries on
  any non-success and must not start depending on a field that is sometimes absent.
