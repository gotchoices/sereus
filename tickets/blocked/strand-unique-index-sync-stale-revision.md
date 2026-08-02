----
description: On a two-node strand, the first write a founder makes to a table after the second node attaches sometimes fails to commit. The table's rows are saved but its uniqueness index is not, so the two go out of step on disk. The failure comes from the shared database library in the sibling `optimystic` checkout, so it cannot be fixed here.
prereq:
files: packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts, ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 285-370, updateInternal ~line 125-185), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (commitDirtyTreesLegacy ~line 400-445), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection ~line 710-737)
difficulty: hard
----

# Blocked (b): a table's unique-index sub-collection cannot sync on a two-node strand

**Category (b) — dependency outside this repo.** The throw comes from
`@optimystic/db-core`'s `Collection` sync loop, in the sibling checkout
`../optimystic`, which sereus consumes as built `dist`. Nothing in this repository
can make the failing tests pass.

**Unblock condition (two parts, in order):**

1. **Right now the reported failure cannot be re-measured here, because a second,
   newer sibling regression masks it.** `../optimystic`'s own runner is mid-work
   across `packages/db-p2p` (an untracked `src/cluster/cluster-policy.ts` +
   `resolveClusterPolicy`, `ReconcileBlockDeps` reshaped, on top of committed
   `cdaa7bf ticket(fix): corroboration-floor-defaults-to-two-for-large-meshes`).
   Built against that tree, **cross-node strand replication does not complete at
   all** — see "Verification is gated" below. So the scenario now dies ~15 s earlier,
   during bring-up, and never reaches the write that produces this ticket's error.
   Wait for that sibling work to settle, rebuild, and confirm
   `strand-formation-e2e.integration.ts` Phase 2 is green again before judging
   anything here.
2. Then: an optimystic fix that lets a collection whose client-side revision context
   is *behind* the cluster's adopt the cluster's revision instead of re-requesting a
   revision that is already taken (see "The upstream defect"). Landed and rebuilt,
   then re-run and delete this ticket's entries from `tickets/.pre-existing-known.md`.

## The failing tests

File: `packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`
Suite: `Closed-strand membership lifecycle (real two-node strand)`

Run from `packages/integration-tests`:

```
yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts --reporter=verbose
```

Four of the five tests fail **intermittently**, all with one fingerprint:

- `founds a closed strand, admits a second member, and gates writes by membership`
- `a member clears its own device record and a manager clears a revoked member's leftovers`
- `replicates the founder's blocks PHYSICALLY into the joiner's own block store`
- `a manager promoted on the second node runs manager actions from its OWN database`

`a joining node runs the join against its OWN database and both nodes converge` has not
been observed failing.

Measured pass counts (whole-file runs, reported 2026-07-31 by
`implement/18-debt-manager-actions-from-second-node-validate`): test 1 0/3, test 2 1/3,
test 3 3/3, test 4 0/3, test 5 1/3. **A single green run proves nothing here.**

## Error output (representative; block id differs per run)

```
PartialCommitError: Legacy multi-tree commit was not atomic: 1 tree(s) were durably
committed to storage before the commit failed and CANNOT be rolled back.
Persisted (now out of sync with the unpersisted trees): [default/Member].
Not persisted (reverted in-memory only): [default/Member/index/_uniq_1, default/ConsumedInvite].
Underlying failure: sync for collection default/Member/index/_uniq_1 exhausted 10 retries:
stale revision: block fZy3gqwHlYxsoONtt2-dc4979HichWN091VfaSeOSkM at rev 2, requested rev 1
 ❯ TransactionBridge.commitDirtyTreesLegacy ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:441:15
 ❯ TransactionBridge.commitTransaction ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:339:9
 ❯ OptimysticVirtualTableConnection.commit ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts:41:3
 ❯ TransactionManager.commitTransaction ../../../quereus/packages/quereus/src/core/database-transaction.ts:274:7
```

inner cause:

```
SyncRetryExhaustedError: sync for collection default/Member/index/_uniq_1 exhausted 10 retries:
  stale revision: block <id> at rev 2, requested rev 1
    at Collection.syncInternal (../optimystic/packages/db-core/src/collection/collection.ts:341:12)
    at Collection.updateAndSync (../optimystic/packages/db-core/src/collection/collection.ts:377:4)
    at Tree.sync (../optimystic/packages/db-core/src/collections/tree/tree.ts:120:4)
```

## The three invariants that should narrow it fast

Across nine observed failures over five whole-file runs, without exception:

- The collection that cannot sync is **always a unique-index sub-collection**
  (`default/Member/index/_uniq_1`, `default/Manager/index/_uniq_2`), **never the data
  tree**. The data tree commits durably and is then reported as unrollbackable, so a
  failed run leaves the table's rows and its uniqueness index out of step on disk —
  a durability defect on top of the write failure.
- The revision pair is **always "at rev 2, requested rev 1"** — never any other numbers,
  and never moving across the ten retries. The client is asking for the *first* revision
  of that block while the coordinator already holds its second.
- The failing statement is always the **first founder-side write to that table after the
  joiner has attached the same strand** — `consumeInvite` (writes `Member`) in three
  tests, `addManager` (writes `Manager`) in the fifth.

## The upstream defect

**Hypothesis, not confirmed** — the reproduction could not be re-run at HEAD (see below),
and `collection.ts` carries no debug logging. Stated so whoever picks this up in
`../optimystic` has somewhere to start, not as a finding.

The rejection is emitted by `CoordinatorRepo.classifyStaleRejection`
(`db-p2p/src/repo/coordinator-repo.ts:731`): the coordinator re-reads its own storage,
finds `latest.rev >= request.rev`, and returns a retryable `StaleFailure`.
`Collection.syncInternal` backs off and calls `updateInternal()`, then recomputes
`newRev = (this.source.actionContext?.rev ?? 0) + 1`. Requesting rev 1 on all ten
attempts means `actionContext` was `undefined` (or `rev: 0`) every time — the client's
context for that sub-collection **never initialises at all**, rather than initialising
and then regressing.

That constant, small, never-moving revision pair is what distinguishes this from
`tickets/blocked/forked-control-collection-sync-livelocks` (see "Relationship" below),
where the client sits one behind a coordinator at rev 9. Two threads worth pulling:

- **Why the sub-collection and not its parent.** The data tree
  (`default/Member`) syncs fine in the very same transaction, so whatever warms the
  parent's `actionContext` does not reach the `index/_uniq_N` child. If the child
  `Collection` is opened lazily on first write and its `TransactionSource` starts with
  no context, its first `sync` will always ask for rev 1 — correct on a block nobody
  else has touched, wrong on one the cluster has already advanced.
- **Why the joiner's attach matters.** The block is at rev 2 by the time the founder
  writes, and the trigger is always the first founder-side write *after* the joiner
  attached the same strand. So the joiner's attach (or the replication it starts) is
  what advances the cluster's copy of that index block past what the founder's freshly
  opened child collection assumes.

Design constraints for the upstream fix (not a prescription):

- **A cold-opened collection must adopt the cluster's revision, not assume rev 0.** The
  first sync of a sub-collection whose block already exists at rev N has to request
  N+1. Retrying rev 1 ten times cannot ever succeed and burns ~20 s of backoff to
  produce a message that reads like ordinary contention.
- **A repeated *identical* stale rejection is not worth retrying.** Ten attempts that
  all request rev 1 against a coordinator that keeps answering "rev 2" learn nothing.
  The coordinator's `latest.rev` would let the client either rebase or fail fast with a
  named error — but `coordinator-repo.ts`'s own comment is explicit that the reject
  reason string is free-form prose and must never become control flow, so that number
  has to arrive as a structured field on `StaleFailure`.
- **The partial-commit hole is separately serious.** Even with the sync bug fixed, the
  legacy multi-tree commit path persisted the data tree and then could not roll it back
  when a sibling tree failed, leaving rows without their uniqueness index. That is
  `feat-optimystic-legacy-commit-two-phase` / `debt-bridge-partial-commit-branch-test`
  territory in `../optimystic/tickets/backlog/`; note the cross-reference when filing.

## Relationship to `forked-control-collection-sync-livelocks`

Same error class, same throwing line (`Collection.syncInternal`,
`db-core/src/collection/collection.ts:341`), but **a materially broader trigger**, which
is why this is filed separately rather than folded into that ticket:

- That ticket's trigger is a manufactured fork — a control-database write committed by a
  node that was alone, later reconnecting to a sibling with a different history. It once
  offered the delete-while-alone plan work as an "alternative unblock, entirely in this
  repo"; that work has since shipped (`control-revocation-reissuable-tombstone` +
  `control-revocation-drain-on-growth`) and does NOT remove the fork — it converges the
  revocation tombstone, not the delete — so that ticket now records the upstream fix as
  its only unblock.
- **This needs no fork of any kind.** A plain two-node closed strand doing ordinary
  membership writes: nothing partitioned, nothing restarted, no local-only commit
  anywhere. Removing the fork trigger would not make this go away.
- The revision pairs differ in kind: rev 9 / requested 9 (coordinator level with the
  request) there, rev 2 / requested 1 (client never left zero) here.

A scope-correction note has been added to that ticket pointing here, so a human reading
either one sees that its in-repo mitigation is not sufficient.

## Verification is gated on in-flight sibling work

This triage pass (2026-07-31) could not reproduce the reported failure, and did **not**
conclude it was absent. Two successive obstacles, both in `../optimystic`:

**First — the sibling would not build.** `packages/integration-tests`'s `globalSetup`
stale-build guard reported `@optimystic/db-p2p: dist is stale`, and the prescribed remedy
(`cd ../optimystic/packages/db-p2p && yarn build`) failed. Its runner was refactoring
live: four builds over ~15 minutes gave four different results as the working tree changed
under the compiler (`resolveClusterPolicy` unimported → `assumedClusterSize` missing from
`ReconcileBlockDeps` in `src` + tests → in tests only → clean). Modified files grew from
one to twelve across the window. The sibling's `src` was **not** touched to force it
through.

**Then — with a build that finally succeeded, a different failure appeared.** All five
tests (not four) now fail, and none of them reaches this ticket's error. They die in
`bringUpClosedStrand` (`strand-membership-closed-strand-e2e.integration.ts:434`):

```
Error: Timeout waiting for founder bootstrap rows replicate to joiner after 15000ms
 ❯ waitUntil src/harness/wait-utils.ts:53:9
```

That is **not scenario-specific — cross-node strand replication is broken repo-wide right
now.** Confirmed by the neighbouring, previously-green scenario:

```
× strand-formation-e2e.integration.ts > Phase 2 > should form strand, start instances, and replicate data
  → Timeout waiting for data replicates from Alice to Bob after 15000ms   (16 of 17 in that file pass)
```

`tickets/.pre-existing-known.md` records that file as **resolved and green** (13/13,
verified 2026-07-29 and again 2026-07-31), so this is a regression that arrived with the
build, not a standing failure. `rbac-signed-write.integration.ts` still passes, but it
proves nothing about this — its own log says
`cross-node replication observed=false (expected under an inferred bootstrap mode)`, i.e.
it never exercises the replication path.

Sibling state at the time of that measurement: HEAD
`cdaa7bf ticket(fix): corroboration-floor-defaults-to-two-for-large-meshes`, plus
uncommitted edits to `db-p2p/src/{cluster/quorum-restore.ts, cluster/reconcile-block.ts,
libp2p-node-base.ts, repo/coordinator-repo.ts}` and untracked
`db-p2p/src/cluster/cluster-policy.ts`. Cluster-policy and corroboration-floor work is
exactly the surface that decides whether a two-node cohort can corroborate a write, so it
is the obvious suspect — **but this was measured against an uncommitted, actively-moving
tree, so it is not a finding about anything committed anywhere.** Nothing was filed
against it; whoever picks this up should simply re-measure once that work settles.

**Why the reported failure is still believed real.** The reporting session
(`implement/18-debt-manager-actions-from-second-node-validate`, commit `f487e37`) observed
it nine times over five runs before this regression existed. That commit's diff is one
test file, additive — three read-only scan helpers, one import, one appended fifth test,
header comments — and tests 1-4's bodies are byte-identical to the parent commit's. The
parent commit's version of the file was extracted with `git show f487e37^:<path>`, run
from a scratch sibling file, and observed failing the same way
(`default/Member/index/_uniq_1 at rev 2, requested rev 1`). No product code is touched by
that commit.

The reporting session also noted the failure rate got **worse** across a mid-measurement
rebuild of `../optimystic/packages/db-p2p/src/libp2p-key-network.ts` (coordinator
selection, optimystic commit `892ac32`) — suggestive of coordinator-selection work
influencing which peer answers the read, but not proof.

## Cross-cutting obligations

None on the sereus side: no schema, byte format, golden fixture, or determinism edition
is touched by anything proposed here. If the upstream fix changes `StaleFailure`'s shape
(adding the coordinator's revision as a structured field), sereus consumes it only
through `@optimystic/db-core`'s public surface and needs a dependency-floor bump, tracked
the same way as `tickets/blocked/report-dependency-floor-bump-to-embedding-app.md`.

## Do not

- Do not skip, `todo`, comment out, or loosen the assertions of any of the four failing
  tests to get a green run. They cover the landed `strand-membership-*` behaviour and
  they are failing on a real write defect, not on a test bug.
- Do not edit `../optimystic`'s `src` to force its build through while its own runner is
  working there.
