----
description: Review of the fix that lets a machine quietly retry when it loses a race to write to the party's shared database. Most of the review is done and written up below; a short list of small cleanups is left to apply before this can be signed off.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, ../optimystic/docs/internals.md, ../optimystic/docs/transactions.md
difficulty: easy
----

# Review (continuation): stale-revision retryability fix

<!-- resume-note -->
A prior review run hit its token budget partway through. **The investigation is complete** — the
diff was read, both suites and lint were run, the open question was answered, and the one major
finding was filed. What is left is a short list of small, well-specified edits that were not
applied because the run could not re-validate them. Apply them, re-run the two suites, then write
the `complete/` ticket using the "Review findings so far" section below as its
`## Review findings`, extended with whatever the remaining work turns up.

Do **not** redo the investigation.

## What the change is

Concurrent-write conflicts on the control database used to surface as a thrown error, so the
losing node never retried and a per-table commit sweep could split one write across tables. The fix
classifies that conflict shape and returns it as a "you lost, retry" value instead, so the existing
bounded retry loop picks it up.

All changes remain **uncommitted in the `../optimystic` working tree** (Sereus `master` is clean).
Changed: `db-p2p/src/repo/cluster-coordinator.ts` (new typed `ValidatorRejectionError`),
`db-p2p/src/repo/coordinator-repo.ts` (new `classifyStaleRejection`),
`db-p2p/test/coordinator-repo-stale-classification.spec.ts` (new, 4 cases),
`db-core/test/network-transactor.spec.ts` (one new case).

## Review findings so far

### Verified — the core fix is sound

- **Error identity survives the call chain.** `ValidatorRejectionError` is thrown in
  `ClusterCoordinator.executeTransaction`, carried by `Pending` (which stores and rethrows the
  original object, `db-core/src/utility/pending.ts`), and rethrown unwrapped by
  `executeClusterTransaction`. The `instanceof` check in the classifier is reliable, and the error
  never crosses a package or wire boundary.
- **The three-condition gate is right and is exhaustive.** Typed error + request carries a revision
  + a local re-read confirms the revision is taken. The comparison
  (`latest.rev >= request.rev`, any affected block) is byte-for-byte the same rule the cluster
  members apply when they vote (`db-p2p/src/cluster/cluster-repo.ts:1049-1065`), so classifier and
  voter cannot disagree.
- **No reject-text parsing anywhere.** Confirmed by reading, as the ticket claimed.
- **Retry stays bounded and re-reads real state.** `Collection.syncInternal`
  (`db-core/src/collection/collection.ts:302-370`) retries on *any* non-success, backs off, then
  calls `updateInternal()`, which builds a **fresh** `TransactorSource`/`Tracker` and re-reads
  through the network rather than the collection's cache. So the absent `missing` payload costs the
  single-collection writer nothing — it does not read that field at all.
- **The commit path needs no equivalent change.** Only pend operations are validated by cluster
  members (`cluster-repo.ts:1201` states this; `validatePendOperations` matches `'pend' in
  operation` only). The sole reject vote a commit can draw is "Transaction expired", which is not a
  lost race and must keep failing fast. Checked specifically because a split write is a commit-time
  symptom; no gap.
- **Lint and tests pass.** `yarn lint` at the Optimystic root: clean, exit 0. Builds of
  `@optimystic/db-core` and `@optimystic/db-p2p`: clean. `db-p2p`: 1436 passing, 41 pending.
  `db-core`: 1267 passing. No pre-existing failures surfaced in either; nothing added to
  `tickets/.pre-existing-error.md`.

### Major — filed as its own ticket

- **`tickets/fix/bug-stale-loss-looks-permanent-to-multi-collection-writer`.** The classifier
  returns a reason-only failure. The multi-collection writer
  (`db-core/src/transaction/coordinator.ts:930-937`) infers retryability from the *payload shape* —
  a failure carrying neither `missing` nor `pending` is bucketed as a permanent hard rejection. So
  the retry fix reaches the single-collection writer only. Latent (that write mode is never wired
  up in Sereus) and not a regression (it threw before, equally non-retryable), but definitely wrong
  once that mode is enabled, and the two writers now read the same response differently.

### The ticket's open question — answered: fold into the sibling ticket, no new ticket

The one `PartialCommitError` in the 20-run validation is **not** a new defect. Evidence, now
written into `tickets/fix/bug-control-db-rx-record-never-converges-on-sender`:

All 6 failures in the 20-run sample are the *same* root cause — the writer's re-read never
observing the winner's revision — wearing three costumes: 2 replication timeouts (that ticket's
headline symptom), 2 benign retry exhaustions (first tree, nothing written), and 1 retry exhaustion
that happened to land on the second tree after the first had committed, which is the split write.
Which costume you get is luck about where the commit sweep was. Zero of the 6 were the original
"thrown instead of retried" symptom, so this ticket's fix did its job; the residual split write is
downstream of the convergence bug plus the *documented, deliberate* non-atomicity of the
single-node commit sweep (`../optimystic/docs/transactions.md` § "Legacy (single-node) commit is
not atomic across trees", which already records a planned narrowing).

### Tripwires (recorded, deliberately not ticketed)

- Remote-only confirmation: if only remote cluster members saw the newer revision, the classifier
  cannot confirm locally and still throws. Already parked as a `NOTE:` at the site
  (`coordinator-repo.ts:730-732`). Deliberate and correct; re-confirmed during review.
- One further tripwire is still to be *written* — see the TODO below (commit-sweep note in
  `transactions.md`).

## Remaining work — apply, validate, then hand off to `complete/`

Minor findings, all fix-in-pass. None is speculative; each is specified enough to apply directly.

- **Propagate the diagnostic reason through pend aggregation.** In
  `db-core/src/transactor/network-transactor.ts:511-518`, the stale-preemption branch rebuilds the
  result as `{ success: false, missing: [...] }` and silently drops `reason`. That is why
  `SyncRetryExhaustedError.lastReason` was `undefined` in every observed failure
  (`collection.ts:333` reads `staleFailure.reason`) — the implementer flagged this as a known gap.
  Carry through the first defined `reason` among the stale batch responses. Checked the consumers:
  only `collection.ts:333` (diagnostic text) and `coordinator.ts:936` (message text) read it, and
  the `conflict` classification keys off `missing`/`pending`, so adding `reason` changes no control
  flow. Leave the analogous commit-path branch (line 629-633) alone — it has its own `NOTE:`
  explaining why it drops the reason.

- **Close a test gap in the new spec.** `coordinator-repo-stale-classification.spec.ts` only ever
  exercises a single affected block whose revision *equals* the requested one. The classifier's
  loop over multiple blocks and its `>=` (strictly-greater) comparison are both untested. Add one
  case: a request touching two blocks where only the *second* is stale and its revision is strictly
  greater — assert the returned reason names that second block.

- **Drop the `as any` in the new spec.** `new CoordinatorRepo(mockKeyNetwork, createClient as any,
  storage, cfg)` — `AGENTS.md` forbids type laziness. Type `createClient` against the constructor's
  declared client-factory parameter (or give `MockClusterClient` the minimal structural type that
  parameter needs).

- **Document the throw-vs-return contract.** `../optimystic/docs/internals.md` § "Consensus
  Execution" (lines 266-346) exhaustively documents which consensus outcomes are thrown and which
  are returned — including the equivalent split on the commit side ("The commit divergence split
  keys off `CommitResult`, not throw-vs-return"). The new pend-side rule belongs in that list and
  is currently absent. Add a bullet: a validator rejection that local storage confirms as a
  revision loss is *returned* as a stale failure; every unconfirmed rejection — including a failed
  confirmation read — still throws.

- **Add the commit-sweep tripwire.** `../optimystic/docs/transactions.md:25-28` says a
  conflict/stale rejection "surfaces at pend before any durable commit", offered as the reason
  first-tree failure is the common case. With the retry fix that is now only true for a *single*
  attempt: a lost race that exhausts its retry budget surfaces wherever the sweep happens to be, so
  it can hit tree N>1 and split the write. Add a sentence saying so. Architectural, no single code
  site — a doc bullet is the right home per the tripwire convention.

Then: re-run `yarn lint`, `yarn workspace @optimystic/db-p2p test`, and
`yarn workspace @optimystic/db-core test` at the Optimystic root. Re-running the integration
scenario is **not** needed — it was already run 20 times and its residual failures are attributed
above and recorded in `tickets/.pre-existing-known.md`.
