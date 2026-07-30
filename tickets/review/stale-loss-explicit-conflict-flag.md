----
description: A write that loses a race to another machine now says so plainly in its failure response, so both write paths agree it is worth retrying instead of one of them giving up.
files: ../optimystic/packages/db-core/src/network/struct.ts, ../optimystic/packages/db-core/src/network/stale-failure.ts, ../optimystic/packages/db-core/src/network/index.ts, ../optimystic/packages/db-core/src/transaction/coordinator.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/src/testing/test-transactor.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/storage/storage-repo.ts, ../optimystic/packages/db-core/test/coordinator.spec.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/docs/internals.md, ../optimystic/docs/transactions.md
difficulty: medium
----

# Review: explicit `conflict` flag on pend failures

All changes are in the sibling `../optimystic` workspace (separate git repo, linked into Sereus via
`resolutions`), on branch `main`, uncommitted alongside the previous ticket's changes. **No Sereus
source changes.**

## What was wrong

Two write paths disagreed about whether a failed write was worth retrying, because each inferred
retryability from the *shape* of the failure payload rather than from anything the failure actually
said:

- `Collection.sync` (single collection) retries on any non-success — so it was fine.
- `TransactionCoordinator.pendPhase` (multi-collection) called a failure retryable only if it
  carried a `missing` (already-committed newer actions) or `pending` (rival in-flight action) list.

`CoordinatorRepo.classifyStaleRejection` confirms a lost race by re-reading its *own* storage, which
reveals that the revision is taken but not which actions took it — so it returned a failure with
only a free-text `reason` and neither list. The coordinator read that as a hard rejection and
refused to retry a race it could have won.

## What changed

Retryability is now stated, not inferred.

- `StaleFailure` gained `conflict?: boolean` (`db-core/src/network/struct.ts`) — "this was an
  optimistic-concurrency loss; a re-read, rebase and re-pend can win."
- New `isConflictFailure` (`db-core/src/network/stale-failure.ts`, re-exported from
  `network/index.ts`) is the one rule every pend consumer calls:
  `failure.conflict ?? Boolean(failure.missing?.length || failure.pending?.length)`. The fallback
  keeps producers that never set the field working, including a remote peer on an older build (the
  repo protocol is plain JSON with no field whitelist, so an unset field simply arrives absent).
- Producers set `conflict: true` on genuine lost races only: `CoordinatorRepo.classifyStaleRejection`
  (the confirmed-loss return) and `StorageRepo.pend`'s three optimistic-concurrency returns
  (`missing` branch, `'f'` policy, `'r'` policy). `StorageRepo.pend`'s validation-failure return is
  deliberately left without the field and now carries a comment saying why.
- `NetworkTransactor.pend` **rebuilds** its aggregate `StaleFailure` from the per-batch responses
  rather than forwarding one, so it re-derives `conflict` across them via `isConflictFailure` — any
  conflicting batch makes the aggregate a conflict. Skipping this step would have made the whole fix
  a no-op for the real network path.
- `TransactionCoordinator.pendCollection` now calls `isConflictFailure(pendResult)` instead of
  testing `missing`/`pending` lengths.
- `TestTransactor.pend`'s three optimistic-concurrency returns set `conflict: true` so shipped test
  infrastructure emits the same shapes real producers do.
- Docs updated: `docs/internals.md` (new bullet on explicit retryability, plus the amended
  pend-rejection bullet) and `docs/transactions.md` (clean-stale-loss vs hard-failure bullets).

## Testing / validation performed

All commands run from `../optimystic`:

| command | result |
| --- | --- |
| `yarn lint` (root, `eslint .`) | clean, exit 0 |
| `yarn build` (all workspaces) | clean, exit 0 |
| `yarn test` (all workspaces) | **0 failing.** db-core 1272 passing; db-p2p 1437 passing / 41 pending; remaining packages 52+49+44+43+12+125+326+6+258 passing, 12 pending total |

The 41 + 1 + 11 pending specs are pre-existing skips, untouched by this ticket.

New/changed tests:

- `db-core/test/coordinator.spec.ts` (`pendPhase` describe) — three new cases:
  - a collection whose pend returns `{ success: false, conflict: true, reason: 'stale revision: …' }`
    (no `missing`/`pending`) yields `staleLoss: true`. **This is the regression test for the original
    bug**; it fails against the old shape-inference code.
  - a reason-only failure with no `conflict` still yields `staleLoss: false`.
  - a failure carrying `pending` but no `conflict` yields `staleLoss: true` (older-producer fallback).
  - `InstrumentedTransactor` gained a 4th ctor param `conflictPendCollections` for the first case.
- `db-core/test/network-transactor.spec.ts` — the existing `pend mixed stale + transport failure`
  body was extracted into a `runMixedPend(staleResponse)` helper driven by three cases: conflict-
  flagged (asserts the aggregate carries `conflict: true` even with an empty `missing`), hard
  rejection (`conflict: false`), and `missing`-only fallback (`conflict: true`).
- `db-p2p/test/coordinator-repo-stale-classification.spec.ts` — the confirmed-loss cases now assert
  `conflict: true` on the returned `StaleFailure` and that `isConflictFailure` agrees.

### Useful manual/adversarial checks for the reviewer

- Grep for any remaining pend-path consumer that re-derives retryability instead of calling
  `isConflictFailure`. I checked every `.missing` / `missing?.length` / `pending?.length` site across
  `db-core` and `db-p2p` src; the only remaining ones are commit-side (see scope below) plus pure
  logging (`coordinator-repo.ts:672-673`, `cluster-repo.ts:1228-1229`, `network-transactor.ts:681`).
- Cross-version behaviour: an older peer returning `missing` with no `conflict` must still be
  treated as retryable, and a newer peer's `conflict: true` with no `missing` must be too. Both are
  covered by tests, but the wire path itself (`db-p2p/src/protocol-client.ts:141`,
  `db-p2p/src/repo/service.ts:274`) was only reasoned about, not exercised end-to-end with a mixed-
  version pair — see gaps.

## Scope boundaries honoured

The commit-side rules that also key on payload shape were left alone, per the implement ticket:

- `TransactionCoordinator.commitCollection` still treats every returned non-success as a retryable
  stale loss. A `NOTE:` comment now sits at that site explaining it deliberately does not consult
  `isConflictFailure`, and what would have to change if a commit producer ever starts distinguishing
  hard commit rejections from lost races.
- `ClusterRepo`'s ahead-vs-behind divergence test on `result.missing?.length`
  (`db-p2p/src/cluster/cluster-repo.ts:1275-1297`) is unchanged.
- `StorageRepo.commit` sets no `conflict`, and correspondingly neither does `TestTransactor.commit`
  nor the `FlakyCommitTransactor`-style forced-failure helper at `test-transactor.ts:440`. The
  implement ticket's TODO listed those three lines, but its own scope boundary forbids flagging
  commit failures and asks test infrastructure to "match what real producers now emit" — so leaving
  them absent is the reading I took. **Worth a second opinion.**
- `classifyStaleRejection` stays conservative: confirmation is still a purely local re-read and the
  free-text reject reason is still never parsed.
- `Collection.sync` does not read `conflict`; it still retries on any non-success.

## Known gaps / things I did not do

- **No end-to-end mixed-version wire test.** That `conflict` survives serialization rests on the
  protocol being plain JSON with no field whitelist (verified by reading `protocol-client.ts` and
  `repo/service.ts`), not on a test that round-trips the field through a real libp2p stream. The
  `db-p2p` integration suite (`yarn test:integration`) was **not run** — it is gated behind
  `OPTIMYSTIC_INTEGRATION=1` and risks exceeding the 10-minute idle window for an agent run.
- **`isConflictFailure` has no dedicated unit spec.** It is covered only indirectly, through the
  coordinator and network-transactor tests. A small table-driven spec over its four input shapes
  (conflict true / conflict false / evidence-only / empty) would be cheap and would pin the
  `??`-vs-`||` precedence, which is the one subtle thing in the function: `conflict: false` must
  suppress the fallback, and only `undefined` must trigger it. Worth adding.
- **`conflict: false` is never produced by a real producer**, only by `NetworkTransactor.pend`'s
  aggregation. That means the "explicitly not retryable" case is exercised only at the aggregate
  level. A producer that wanted to say "definitely a hard rejection, do not even infer" has the
  vocabulary but no user yet.
- I did not audit `quereus-plugin-optimystic` or `db-cli` for pend-failure handling beyond
  confirming they build and their tests pass.

## Tripwires parked

- `db-core/src/transaction/coordinator.ts`, in `commitCollection` — `NOTE:` at the returned-stale
  branch: the commit path deliberately ignores `StaleFailure.conflict`; gate `stale` on
  `isConflictFailure` there **if** a commit producer ever starts distinguishing hard commit
  rejections (validator policy, storage fault) from lost races.
