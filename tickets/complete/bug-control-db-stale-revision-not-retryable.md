----
description: When two machines write to the party's shared database at the same time, the loser used to fail outright instead of quietly trying again — sometimes leaving a write half-applied. It now retries, and this review confirmed the fix and cleaned up its rough edges.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/testing/mesh-harness.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, ../optimystic/docs/internals.md, ../optimystic/docs/transactions.md
----

# Complete: stale-revision loss is retryable, not a thrown error

## What landed

A concurrent-write conflict on the control database used to escape the coordinator as a thrown
error, so the losing node never retried and a per-table commit sweep could split one logical write
across tables. Now:

- `ClusterCoordinator` throws a typed `ValidatorRejectionError` carrying the per-peer reject reasons
  (`db-p2p/src/repo/cluster-coordinator.ts`).
- `CoordinatorRepo.pend` classifies it (`classifyStaleRejection`): typed error + the request carries
  a revision + a **local** re-read confirms `latest.rev >= request.rev` (any affected block) → return
  a `StaleFailure` instead of throwing. Anything unconfirmed — including a failed confirmation read,
  or a newer revision only remote members saw — still throws.
- The existing bounded retry loop in `Collection.syncInternal` therefore picks the loss up, backs
  off, re-reads through a fresh `TransactorSource`, rebases, and retries.
- No reject-reason text is ever parsed; the comparison is byte-for-byte the rule cluster members
  vote by (`db-p2p/src/cluster/cluster-repo.ts:1049-1065`).

All changes live **uncommitted in the `../optimystic` working tree** (this repo consumes Optimystic
through `resolutions`).

## Review findings

### Verified

- **Error identity survives the call chain.** `ValidatorRejectionError` is carried by `Pending`
  (stores and rethrows the original object) and rethrown unwrapped by `executeClusterTransaction`.
  The `instanceof` check is reliable — the error never crosses a package or wire boundary.
- **The three-condition gate is right and exhaustive**, and classifier and voter cannot disagree
  (same rule, same operands).
- **No reject-text parsing anywhere** — confirmed by reading.
- **Retry is bounded and re-reads real state**, not the collection's cache, so the absent `missing`
  payload costs the single-collection writer nothing.
- **The commit path needs no equivalent change.** Only pend operations are validated by cluster
  members; the sole reject vote a commit can draw is "Transaction expired", which is not a lost race
  and must keep failing fast. Checked specifically because a split write is a commit-time symptom.
- **Lint, builds, tests pass** (see *Validation*). No pre-existing failures surfaced; nothing written
  to `tickets/.pre-existing-error.md`.

### Major — filed as its own ticket

- `tickets/fix/bug-stale-loss-looks-permanent-to-multi-collection-writer`. The multi-collection
  writer (`db-core/src/transaction/coordinator.ts:930-937`) infers retryability from the *payload
  shape*: a failure carrying neither `missing` nor `pending` is bucketed as a permanent hard
  rejection. The classifier returns a reason-only failure, so the retry fix reaches the
  single-collection writer only. Latent (that write mode is not wired up in Sereus) and not a
  regression (it threw before, equally non-retryable), but definitely wrong once that mode is
  enabled — and the two writers now read the same response differently.

### The open question this review inherited — answered, no new ticket

The one `PartialCommitError` in the implementer's 20-run validation is **not** a new defect. All 6
failures in that sample are the same root cause — the writer's re-read never observing the winner's
revision — in three costumes: 2 replication timeouts, 2 benign retry exhaustions (first tree,
nothing written), and 1 exhaustion that landed on the second tree after the first had committed
(the split write). Which costume you get is luck about where the commit sweep was. Zero were the
original "thrown instead of retried" symptom, so this fix did its job. Evidence folded into
`tickets/fix/bug-control-db-rx-record-never-converges-on-sender`; the residual split is downstream
of that convergence bug plus the documented, deliberate non-atomicity of the single-node commit
sweep.

### Minor — fixed in this pass

- **Diagnostic reason was being dropped.** `network-transactor.ts` pend's stale-preemption branch
  rebuilt the result as `{ success: false, missing }`, silently losing `reason` — which is why
  `SyncRetryExhaustedError.lastReason` was `undefined` in every observed failure. Now carries the
  first defined reason from the stale batch responses. Classification keys off `missing`/`pending`,
  so no control flow changed. The analogous commit-path branch was left alone (it has its own
  `NOTE:` explaining why it drops the reason).
- **Test gap closed.** The new spec only exercised a single affected block at exactly the requested
  revision, leaving the classifier's block loop and its `>=` (not `===`) comparison untested. Added
  a case: two blocks, only the second stale and by more than one revision, asserting the returned
  reason names that second block. Required a per-block revision override on the storage stub.
- **`as any` removed, honestly.** The spec cast its client factory to `any` because
  `CoordinatorRepo`/`ClusterCoordinator` declared it as `(peerId) => ClusterClient` — a concrete
  class with a private constructor no mock can satisfy — while the only member either class ever
  calls is `update`. Widened both declarations (and `coordinatorRepo`'s) to `ICluster`, which is
  exactly that one method. This also deleted a second `as any` in
  `db-p2p/src/testing/mesh-harness.ts`, which already built an `ICluster` and cast it. Production
  `ClusterClient` satisfies `ICluster`, so the live wiring is unchanged.
- **Throw-vs-return contract documented.** `docs/internals.md` § "Consensus Execution" exhaustively
  lists which consensus outcomes throw and which return, including the commit-side equivalent; the
  new pend-side rule was absent. Added.

### Tripwires (recorded, deliberately not ticketed)

- **Remote-only confirmation.** If only remote cluster members saw the newer revision, the
  classifier cannot confirm locally and still throws. Parked as a `NOTE:` at the site
  (`coordinator-repo.ts` end of `classifyStaleRejection`). Deliberate and correct; re-confirmed.
- **Where a lost race now surfaces.** `docs/transactions.md` said a conflict/stale rejection
  "surfaces at pend before any durable commit" — true per *attempt*, but with retries a loss that
  exhausts its budget surfaces wherever the flush sweep happens to be, so it can hit tree N>1 and
  split the write. Added a `NOTE:` sentence to that bullet. Architectural with no single code site,
  hence a doc home.

### Checked and found nothing

- Resource cleanup / error handling in the changed code: the classifier opens nothing, the new error
  class holds no handles, and the confirmation read's failure path is explicitly handled and logged.
- Source hygiene: no file grew materially; `classifyStaleRejection` is one short purposeful method;
  no comment block substituting for decomposition.
- Other consumers of the widened client-factory type: none outside `db-p2p` (grepped both repos).

## Validation

At the Optimystic root, after the fixes above:

- `yarn lint` — clean, exit 0.
- `yarn workspace @optimystic/db-core build`, `... db-p2p build` — clean (the type widening
  typechecks across both packages).
- `yarn workspace @optimystic/db-core test` — 1267 passing.
- `yarn workspace @optimystic/db-p2p test` — 1437 passing, 41 pending (+1 vs. the implementer's run:
  the new multi-block classification case).

The integration scenario was **not** re-run: it was already run 20 times during implement, and its
residual failures are attributed above and recorded in `tickets/.pre-existing-known.md`.
