----
description: Once a control-database write has been committed by a node that was alone, that node and its sibling hold two different histories of the same table. When they reconnect, every later write from the alone node fails instead of reconciling — the write layer keeps asking for a revision number the other side has already used, ten times, then gives up. The retry loop lives in the sibling optimystic repo, so it cannot be fixed here.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 285-370, updateInternal ~line 125-185 — the actionContext assignment on line 184), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection ~line 710-737), packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts (successor of the deleted zz-scratch experiment; currently dies EARLIER, in setup — see "The failing test"), packages/cadre-core/src/control-database.ts + packages/cadre-core/src/cadre-node.ts (the shipped Revocation tombstone + growth-edge drain — converges the revocation, does NOT remove the fork; see "Alternative unblock")
difficulty: medium
----

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

> **Scope note, 2026-07-31 (still stands):**
> `tickets/blocked/strand-unique-index-sync-stale-revision` records the *same* error class
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
