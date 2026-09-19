----
description: Once a control-database write has been committed by a node that was alone, that node and its sibling hold two different histories of the same table. When they reconnect, every later write from the alone node fails instead of reconciling — the write layer keeps asking for a revision number the other side has already used, ten times, then gives up. The retry loop lives in the sibling optimystic repo, so it cannot be fixed here.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 285-370, updateInternal ~line 125-185 — the actionContext assignment on line 184), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection ~line 710-737), packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts (successor of the deleted zz-scratch experiment; currently dies EARLIER, in setup — see "The failing test"), packages/cadre-core/src/control-database.ts + packages/cadre-core/src/cadre-node.ts (the shipped Revocation tombstone + growth-edge drain — converges the revocation, does NOT remove the fork; see "Alternative unblock")
difficulty: medium
----

**Upstream status 2026-09-17:** the fail-fast half has landed. Optimystic `complete/2-sync-fail-fast-on-a-stalled-revision-view` (`09ed71bb`, 2026-09-06) now stops within about 2 attempts with `SyncRevisionStalledError` (a subclass of `SyncRetryExhaustedError`, carrying `staleAt`/`requestedRev`/`heldRev`) instead of retrying 10 times. It deliberately does not adopt the responder's revision. This ticket's unblock condition is forward progress on a fork, and that is still only in optimystic backlog (`feat-refresh-can-demand-a-revision-floor`, `more-design/6.5-partition-healing`). `control-delete-while-alone-convergence` has not been on a failing list in `tickets/.pre-existing-known.md` since 2026-09-02. Those were full-suite runs, and this defect fails more often in isolation.

> **Re-measured 2026-09-02, after the control-network peer-join block catch-up landed
> (`review/control-network-peer-join-block-catch-up`, commit `50c39aa`). Still real, at a lower
> rate.** That work asked for this re-measurement explicitly, because it fixed a *different*
> failure in the same scenario file (the joiner never receiving the `default/CadrePeer`
> collection-header block, which made `isMember` false at line 154). Five isolated rounds of
> `control-delete-while-alone-convergence`:
>
> | observation | result |
> | --- | --- |
> | isolated rounds ×5 | **1 failed, 4 passed** (9 of 10 test cases green) |
> | failing fingerprint | `SyncRetryExhaustedError { collectionId: 'default/CadrePeer', attempts: 10 }` thrown out of `Collection.syncInternal` under `TransactionBridge.commitTransaction` — this ticket's fingerprint, unchanged |
> | the line-154 `isMember` fingerprint | **gone** — did not appear in any of the five rounds |
>
> So the two failures were genuinely separate causes sharing one file. The catch-up removed one of
> them; this one survives at roughly 1 case in 10 and still needs the upstream retry-loop fix. Which of
> the file's two tests failed was not captured in that round (the run was filtered to the error
> output); the 2026-08-21 audit above records the second one, and nothing here contradicts it.

> **Audit 2026-08-21 — confirmed still real, and the reproduction rate is measured.** This ticket
> was a candidate for retirement because its scenario passed both full-suite runs (2026-08-20 and
> 2026-08-21). Running it in isolation says otherwise:
>
> | observation | result |
> | --- | --- |
> | full-suite runs ×2 | 2/2 passing each |
> | isolated runs ×3 | **2 failed, 1 passed** |
>
> The failing case is consistently
> `control-delete-while-alone-convergence > survives ANOTHER restart of the remover before any
> connection (first-growth sweep)` — the second of the file's two tests, not the first. **Do not
> retire this ticket**, and note the shape: it fails *more* in isolation than under whole-suite
> load, which is the opposite of the boot-race pattern most of the other intermittents here show.
> Anyone re-measuring should run the file alone rather than trusting a green full-suite run.
>
> The scratch scenario the body mentions, `zz-scratch-delete-alone.integration.ts`, no longer
> exists — it was deleted, as the body anticipated. `control-delete-while-alone-convergence` is
> now the only live reproducer.

# Blocked (b): a forked control collection livelocks optimystic's sync retry loop

**Category (b) — dependency outside this repo.** The defect is in
`@optimystic/db-core`'s `Collection` sync loop (sibling checkout `../optimystic`,
consumed by sereus from its built `dist`). Nothing in this repository can make the
failing scenario pass.

**Unblock condition:** an optimystic fix that lets a client whose committed revision
has diverged from the cluster's make forward progress (see "The upstream defect"),
landed and rebuilt (`cd ../optimystic && yarn workspace @optimystic/db-core build`).
Then re-run the failing scenario and delete this ticket's entry from
`tickets/.pre-existing-known.md`.

**Alternative unblock — corrected 2026-08-01: there is none in this repo.** An earlier
version of this section pointed at the plan ticket
`10-control-delete-while-alone-tombstone` as closing the gap that *creates* the fork.
That plan has since shipped, as `control-revocation-reissuable-tombstone` +
`control-revocation-drain-on-growth` — and **it does not remove the fork.** What shipped
converges the *`Revocation` tombstone*: every guarded delete writes an owner-signed
tombstone row retiring the removed row's stamp, membership reads treat a retired stamp
as absent, and a tombstone that committed while the node was alone is re-issued (an
owner-signed monotonic `ReissuedAt` bump) on the next cohort-growth edge. But
`removePeer` still commits a local-only `CadrePeer` **delete** while alone — the shipped
work makes the *revocation* durable, it does not prevent the two-histories fork in the
`CadrePeer` collection itself. The sequence this ticket describes still constructs the
fork, and the livelock remains reachable. The only unblock is the upstream fix.

> **Scope note, 2026-07-31 (the sibling closed 2026-09-17; the point about scope still stands):**
> `tickets/complete/strand-unique-index-sync-stale-revision` recorded the *same* error class
> at the *same* throwing line (`Collection.syncInternal`, `collection.ts:341`) reached with
> **no fork at all**: a plain two-node closed strand doing ordinary membership writes —
> nothing partitioned, nothing restarted, no local-only commit anywhere. The revision pairs
> differ in kind too (here rev 9 / requested 9, the coordinator level with the request;
> there rev 2 / requested 1, a client context that never left zero), so the two may not
> share a single root cause. Even a hypothetical fix that stopped the fork forming would
> remove one trigger, not close out `Collection`'s sync loop.

## The failing test

**Status 2026-08-01:** the scratch experiment this section measured
(`zz-scratch-delete-alone.integration.ts`) has been deleted by its owning ticket and
replaced with the real scenario
`packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts`
(two tests: reconnect convergence, and restart durability of the tombstone sweep). The
successor **does not currently reach the fork this ticket is about**: both of its tests
die at ~15 s in Phase 1 setup (authorize a peer, converge it to the sibling — before any
delete happens) with the *other* class's fingerprint — `SyncRetryExhaustedError …
default/CadrePeer … at rev 3 (resp. 4), requested rev 1` — tracked under
`tickets/blocked/control-db-cross-node-convergence-halted`. Once that class clears, the
successor scenario is the repro for this ticket. The measurements below are from the
deleted scratch file (2026-07-31) and remain the only direct observation of the fork
livelock itself.

`zz-scratch-delete-alone.integration.ts` (deleted)
→ `SCRATCH delete-while-alone v2 > does a genuinely local-only removePeer reach a sibling that already has the row?`

```
→ sync for collection default/CadrePeer exhausted 10 retries:
  stale revision: block ynmjn06ACherBEb5GVvEEfxU3gI_F3VpiIbJZaI4Fhk at rev 9, requested rev 9
 ❯ Collection.syncInternal ../../../optimystic/packages/db-core/src/collection/collection.ts:341:12
 ❯ Collection.updateAndSync ../../../optimystic/packages/db-core/src/collection/collection.ts:377:4
 ❯ Tree.sync ../../../optimystic/packages/db-core/src/collections/tree/tree.ts:120:4
 ❯ TransactionBridge.commitDirtyTreesLegacy ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:402:9
```

**Load-dependent, not a code-change regression.** Reproduced 2026-07-31 at HEAD
(`44a24be`) against freshly-built siblings — the suite's own stale-build guard
passed, so this is not build drift:

- `yarn vitest run src/scenarios/zz-scratch-delete-alone.integration.ts` alone: **passes**
  (43.4 s), reaching phase 4 and printing `droppedOnReconnect=false` /
  `droppedAfterBroadcast=false`.
- `yarn workspace @serfab/integration-tests test` (whole suite, files in parallel):
  **fails** at 38.5 s with the error above. Whole-run result 2026-07-31:
  `Test Files 3 failed | 34 passed (37)`, `Tests 2 failed | 185 passed | 6 skipped (193)`,
  416 s. The other two failing files are the pair already tracked in
  `tickets/.pre-existing-known.md` under `transactor-key-network-ignores-network-scoping`
  (`control-cohort-three-node-isolation`, and `control-write-degraded-cohort-member`
  failing at suite level with its 6 tests skipped). An earlier session saw this same
  signature twice.

The console output pins where it dies: `[scratch] RESULT droppedOnReconnect=false` is
printed, `[scratch] Y converged on B=...` is not — so the throw is in phase 4's
fallback broadcast, `A.registerSelf()` or `A.authorizePeer(yPeerId)`, i.e. the first
`CadrePeer` write A attempts *after* the divergent sibling B has reconnected.

## What the scenario builds

The scratch file was a committed experiment owned by the delete-while-alone plan work
(shipped as `control-revocation-reissuable-tombstone` + `control-revocation-drain-on-growth`;
the experiment settled and the file was deleted per its own header). It deliberately
manufactured a fork — the successor scenario keeps the same phase structure:

1. A and B up, peer X authorized, X converged onto B.
2. B stopped; A restarted on the same `MemoryRawStorage`; A now has zero connections.
3. A `removePeer(X)` **while genuinely alone** — Optimystic commits it local-only.
   A's `CadrePeer` history now has a revision B has never seen.
4. B restarts and reconnects, still holding X. A then issues more `CadrePeer` writes.

So by step 4 the two nodes hold different content at the same revision height. The
experiment's own question (does the alone delete reach B?) was answered `false` on both
paths — that finding drove the now-shipped tombstone + drain work and is not what this
ticket is about.

## The upstream defect

The rejection is emitted by `CoordinatorRepo.classifyStaleRejection`
(`db-p2p/src/repo/coordinator-repo.ts:731`): the coordinator re-reads its *own* storage,
finds `latest.rev >= request.rev`, and returns a retryable `StaleFailure`. `latest.rev`
and `request.rev` are both **9** — the client is asking for a revision the coordinator
already has.

`Collection.syncInternal` (`db-core/src/collection/collection.ts:285-370`) handles that
by backing off and calling `updateInternal()`, then recomputing
`newRev = (this.source.actionContext?.rev ?? 0) + 1`. Ten attempts later the request is
still rev 9, so `actionContext.rev` was still 8 on every attempt — the update never
observed the revision the coordinator is rejecting against.

Hypothesis (consistent with the code, not yet confirmed by instrumented logs — `collection.ts`
has no debug logging and editing the sibling's `src` was out of scope for this triage):
`updateInternal`'s last statement is unconditional —

```ts
// Update our context to the latest
this.source.actionContext = latest?.context;
```

— where `latest` comes from `log.getFrom(actionContext?.rev ?? 0)` read through a fresh
`TransactorSource`. When that read is served by a replica on the *other* side of the fork
(B, which never saw A's local-only commit), the assignment moves the client's committed
revision **backwards**, from A's locally-committed 9 to B's 8. The next attempt therefore
re-requests 9, the coordinator (holding A's own rev 9) rejects it as stale again, and the
loop cannot converge: read path and validate path disagree about what "latest" is, and the
loop's only recovery is the read path. The 10-retry budget then converts a livelock into a
thrown `SyncRetryExhaustedError`, which is the observed failure.

Why load changes the outcome: which peer answers the read is a coordinator-selection race
(`Libp2pKeyPeerNetwork.findCoordinator`). Run alone, A keeps answering its own reads and
never sees B's older log; under whole-suite contention B wins the pick often enough to
trip it. The neighbouring failure in the same run
(`control-cohort-three-node-isolation`, already tracked in the ledger) is a different
symptom of the same selection race, root-caused upstream in
`../optimystic/tickets/fix/coordinator-cache-poisoned-by-boot-time-self-selection.md` —
but that ticket is about a *cached* self-pick, and would not by itself fix a client whose
context has been dragged backwards by a legitimately-selected stale peer.

## What the upstream fix has to do (for whoever files it in ../optimystic)

Design constraints, not a prescription:

- **`actionContext.rev` must never regress.** A client that has locally committed rev N
  cannot go back to advertising N-1; at minimum the assignment on `collection.ts:184`
  should be monotonic in `rev`. That alone stops the livelock but leaves the client
  wedged at "my rev is taken" — it needs a rebase path too.
- **A repeated same-rev stale rejection has to be actionable.** The loop currently treats
  every `StaleFailure` as "re-read and try again"; when the re-read is authoritative-but-forked
  there is nothing to learn. The coordinator already knows its `latest.rev` — the reject
  text carries it, but `coordinator-repo.ts`'s own comment is explicit that the reason
  string is free-form prose and must never become control flow, so the rev has to arrive
  as a structured field on `StaleFailure` if the client is to use it.
- **Forward progress on a fork is a policy decision, not a bug fix.** Two histories at rev
  9 with different content cannot both survive. Whatever the loop does — adopt the
  cluster's branch and replay pending actions on top, or fail fast with a named
  divergence error instead of ten pointless retries — is a semantics call for optimystic,
  and sereus's control database needs to know which it gets. A named, immediate
  `CollectionForkedError` would be a strictly better outcome than the current 21 s of
  backoff followed by a message that reads like ordinary contention.
- Note that `../optimystic` currently carries uncommitted in-flight edits from its own
  runner across exactly these files (`db-core/src/network/stale-failure.ts`,
  `coordinator-repo.ts`, `transaction/coordinator.ts`, `network-transactor.ts`). Whoever
  picks this up must coordinate with that work rather than land on top of it.

## Second trigger: a commit torn by a peer that stopped mid-commit (added 2026-09-18)

Found while working `fix/control-delete-while-alone-flakes-under-full-suite-load`. It is the same upstream shape (a node's revision view and its own storage disagree, and nothing it can do alone moves it forward), reached without any write committed alone.

**How it happens.** A two-node party, A (owner, storage profile) and B. A background control write on A (measured: its own `self-record-update`; in the 2026-09-18 `yarn check` failure the collection was `Revocation`, most likely the ledger-marker filing) has pended on both stores and is in its commit phase when B stops. The commit phase fails, and the cancel cannot discharge the pend because B is gone (`WARN: cancel after failed commit did not discharge actionId=…`). A then stops and restarts alone on the same storage. Its next write to that collection pends at the revision after the last one it can read (rev 5), and its own storage answers `stale conflict` on every attempt. The coordinator re-drives for about 14 s and then throws `CoordinatorStaleLossError: Multi-collection commit lost a stale race for [default/cadrecontrol/CadrePeer, …] — Pend failed for collection default/cadrecontrol/CadrePeer: stale conflict`.

**Measured.** 12 runs of `control-delete-while-alone-convergence` (6 in parallel, twice) with `DEBUG=sereus:cadre:*,optimystic:db-core:*,optimystic:db-p2p:storage-repo,optimystic:quereus-plugin:txn-bridge`: the 2 runs that failed this way both had A's `self-record-update` mid-commit at B's stop. One more run had a torn commit at stop and passed. Not measured: whether the write stays refused after the 14 s, or whether B returning clears it.

**Why sereus cannot fix it.** A retry in `control-write-retry.ts` would not help. The one failing attempt already exceeds that module's 10 s budget, and the refusal comes from A's own storage, which does not change while A is alone. To reproduce the ORIGINAL shape: stop the cohort sibling while the owner has a control write in its commit phase, then restart the owner alone and write to the same collection.

**Update 2026-09-18 (`control-delete-while-alone-quiesce-before-stop` implement pass) — the reorder closes the B-leaves-mid-commit path, but the same fingerprint still reproduced once via a different path; the "no live reproducer" claim above is corrected.** That ticket made `removeWhileAlone` stop A first (draining `ControlDatabase.close()`'s write queue while B can still answer) and only then stop B, plus wait for the peer-join catch-up to physically land before either stop — exactly what this section asked for. Post-fix validation: 2 rounds of 6-way-parallel `control-delete-while-alone-convergence` (12 runs) plus 5 isolated runs, 17 total. **16 of 17 passed** (versus the ~50% failure rate measured before the fix). The one failure was test 1 ("converges a removePeer committed while alone…"), at the same call — `A.removePeer(xPeerId)` in phase 3 — with the identical fingerprint: `CoordinatorStaleLossError: Multi-collection commit lost a stale race for [default/cadrecontrol/CadrePeer, default/cadrecontrol/CadrePeer/index/_uniq_7.stampid, default/cadrecontrol/Revocation] — Pend failed for collection default/cadrecontrol/CadrePeer: stale conflict`, taking ~21 s (consistent with the ~14 s internal re-drive plus overhead).

This run's log has no `DEBUG` output (none was set), so the exact interleaving was not captured directly — but B was fully stopped and gone well before A ever attempted the removal, which rules out THIS section's specific mechanism (a peer stopping while A's commit is in flight). The one candidate still live on a lone, freshly-restarted node: `CadreNode.start()` unconditionally arms a one-shot `setTimeout` (`scheduleSelfRegistration`, ~1000 ms, unrelated to connectivity) that calls `registerSelf()` — a self-signed `CadrePeer` UPDATE — regardless of whether the node is alone. `removeWhileAlone` restarts A and calls `A.removePeer(xPeerId)` within a few synchronous `await`s of `A.start()`; under the CPU contention of parallel test processes, the gap between them can exceed 1000 ms, giving the deferred self-registration write a chance to land at nearly the same moment as the foreground removal. Both go through `ControlDatabase.withWriteLock`, which should serialize them without staleness (the docstring's contract is that a queued body re-reads fresh state) — so if this hypothesis is right, the bug is in how a locally-committed write updates the state the NEXT queued body reads, not in the queue ordering itself. **Not confirmed**: 8 further isolated-with-load runs under the same `DEBUG` set named above did not reproduce it, so the window is narrow and no direct log has caught the two writes overlapping.

Net effect: the fix in `control-delete-while-alone-quiesce-before-stop` is real and large (roughly 50% → 6% observed), but does not close this ticket's underlying class — a lone node can still land in a state where its own storage refuses its own next write to a collection, reachable by at least two distinct paths now (a torn commit from a departed peer, and possibly a self-registration/foreground write race on a freshly restarted node). Whoever next re-measures this file should capture `DEBUG=sereus:cadre:node` across enough parallel load to catch this fingerprint again, specifically checking for a `registerSelf: refreshed own CadrePeer record` line landing within the same handful of milliseconds as the `removePeer` call.

## Cross-cutting obligations

None triggered on the sereus side: no schema, byte format, golden fixture, or determinism
edition is touched by anything proposed here. If the upstream fix changes
`StaleFailure`'s shape (adding the coordinator's rev), sereus consumes it only through
`@optimystic/db-core`'s public surface and needs a dependency-floor bump, tracked the same
way as `tickets/blocked/report-dependency-floor-bump-to-embedding-app.md`.

## Do not

- Do not skip, delete, or loosen `control-delete-while-alone-convergence.integration.ts`
  to make the suite green. (The old scratch file's deletion was its owning ticket's
  documented disposition once the experiment settled — not a triage pass hiding a
  failure; the successor scenario covers landed behaviour and stays.)
