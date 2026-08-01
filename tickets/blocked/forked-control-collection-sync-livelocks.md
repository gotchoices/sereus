----
description: Once a control-database write has been committed by a node that was alone, that node and its sibling hold two different histories of the same table. When they reconnect, every later write from the alone node fails instead of reconciling — the write layer keeps asking for a revision number the other side has already used, ten times, then gives up. The retry loop lives in the sibling optimystic repo, so it cannot be fixed here.
prereq:
files: ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 285-370, updateInternal ~line 125-185 — the actionContext assignment on line 184), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection ~line 710-737), packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts (the scenario that provokes the fork), tickets/plan/10-control-delete-while-alone-tombstone.md (the sereus-side gap that creates the fork)
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

**Alternative unblock, entirely in this repo:** `tickets/plan/10-control-delete-while-alone-tombstone`
closes the gap that *creates* the fork. If a control write can no longer commit
local-only, the scenario below can no longer construct two histories, and the
failure goes away without the upstream fix. That is a mitigation of the trigger,
not of the livelock — a fork arriving by any other route (a partition, a restore
from an older snapshot) would hit the same wall.

> **Scope correction, 2026-07-31 — that alternative unblock is narrower than it reads.**
> `tickets/blocked/strand-unique-index-sync-stale-revision` records the *same* error class
> at the *same* throwing line (`Collection.syncInternal`, `collection.ts:341`) reached with
> **no fork at all**: a plain two-node closed strand doing ordinary membership writes —
> nothing partitioned, nothing restarted, no local-only commit anywhere. Removing this
> scenario's fork would therefore silence *this* file and leave that one failing. The
> revision pairs differ in kind too (here rev 9 / requested 9, the coordinator level with
> the request; there rev 2 / requested 1, a client context that never left zero), so the
> two may not share a single root cause. Treat plan ticket 10 as removing one trigger, not
> as closing out `Collection`'s sync loop.

## The failing test

`packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`
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

The file is a committed scratch experiment owned by
`tickets/plan/10-control-delete-while-alone-tombstone` (its header says so, and says to
delete it when the experiment settles). It deliberately manufactures a fork:

1. A and B up, peer X authorized, X converged onto B.
2. B stopped; A restarted on the same `MemoryRawStorage`; A now has zero connections.
3. A `removePeer(X)` **while genuinely alone** — Optimystic commits it local-only.
   A's `CadrePeer` history now has a revision B has never seen.
4. B restarts and reconnects, still holding X. A then issues more `CadrePeer` writes.

So by step 4 the two nodes hold different content at the same revision height. The
experiment's own question (does the alone delete reach B?) is answered `false` on both
paths — that finding belongs to plan ticket 10 and is not what this ticket is about.

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

- Do not skip, delete, or loosen the scratch test to make the suite green. It is scratch,
  and plan ticket 10 may legitimately delete it once the experiment settles — but that
  disposition belongs to that ticket with a human's sign-off, not to a triage pass hiding
  a reproducible failure.
