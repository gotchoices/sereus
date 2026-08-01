----
description: When two or more machines share a cadre, a row written on one of them no longer reaches the others. Most writes now fail outright after about twenty seconds of retrying, and the ones that do succeed never show up on the second machine. This affects every multi-machine scenario in the integration suite. The defect is in the shared database library kept in the sibling `optimystic` checkout, so it cannot be fixed here.
prereq:
files: packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 340-410, updateInternal ~line 180-250, createOrOpen/open/probeHeader ~line 60-140), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection), ../optimystic/tickets/blocked/two-node-convergence-acceptance-cross-repo-build.md
difficulty: hard
----

# Blocked (b): cross-node control-DB convergence is broken at optimystic HEAD

**Category (b) — dependency outside this repo.** The throw comes from
`@optimystic/db-core`'s `Collection` sync loop in the sibling checkout `../optimystic`,
which sereus consumes as built `dist`. Nothing in this repository can make these
scenarios pass.

**Unblock condition:** an optimystic fix that lets a collection whose client-side
revision context is behind (or level with) the cluster's make forward progress instead of
re-requesting a revision the coordinator already holds — landed and rebuilt
(`cd ../optimystic && yarn build`). Then re-run the scenarios below and delete this
ticket's entries from `tickets/.pre-existing-known.md`.

## Measurement conditions — read before re-measuring

Everything below was measured on **2026-07-31** with:

- sereus at `87f5c26` (working tree carrying only the concurrent board promotions),
- `../optimystic` **clean at `bf7e3d2`** (`ticket(implement): repo-reports-unavailable-vs-absent`),
  freshly built with `yarn build`,
- `../quereus` freshly built (its tree carries in-flight `feat-filter-pushdown-through-join`
  planner edits, so it is the one remaining uncontrolled variable; the failures are storage-layer
  sync-retry exhaustion, not wrong query results, so it is an unlikely contributor).

The suite's own stale-build guard passed on every run quoted here, so these are **not** build
drift. That matters because the previous triage pass (`tickets/.pre-existing-known.md`, and the
report that opened this one) saw the same scenario list fail against an uncommitted,
mid-refactor `../optimystic` tree and concluded — reasonably at the time — that it was drift.
It is not drift: the sibling has since committed, and the failures survive.

Both siblings are under concurrent automation and go dirty repeatedly. Re-measure only when
`git status` in `../optimystic` is clean, and rebuild first.

## The failing tests

Run from `packages/integration-tests` as `npx vitest run --reporter=dot <name>`.

Confirmed failing against clean optimystic `bf7e3d2`:

| Scenario | Symptom |
| --- | --- |
| `control-db-two-node-convergence.integration.ts` — `replicates an owner-written CadrePeer row from node A to node B over the live control network` | `SyncRetryExhaustedError` — `default/CadrePeer`, **at rev 3, requested rev 1** |
| `control-cohort-cold-start-retry.integration.ts` — `B recovers from a refused seed dial and converges on a later reconcile pass` | `SyncRetryExhaustedError` — `default/CadrePeer`, **at rev 6, requested rev 1** |
| `strand-addr-seed-convergence.integration.ts` — `joins a second node into the founder's strand from the RPC-resolved seed alone` | `SyncRetryExhaustedError` — `default/CadrePeer`, **at rev 1, requested rev 1** |
| `control-write-while-alone-convergence.integration.ts` — both tests | `Timeout waiting for B observes the X CadrePeer row written on A while alone after 30000ms`, and `Timeout waiting for B resolves A DeviceToken re-replicated after cohort growth after 30000ms` |
| `websocket-chat.integration.ts` — `should replicate a chat message over WebSocket` | `Timeout waiting for message replicates to phone after 15000ms` |
| `convergence-stress.integration.ts` — `should retain converged data after disconnect and reconnect` | 1 failed / 2 passed in that file |

`control-cohort-auto-convergence.integration.ts` was on the incoming report's list and now
**passes** — that one really was drift. It is not tracked.

Not re-measured here because they are already tracked and their tickets say a green run proves
nothing: `control-cohort-three-node-isolation`, `control-cohort-edge-carries-data`,
`control-write-degraded-cohort-member`, `strand-membership-closed-strand-e2e`,
`zz-scratch-delete-alone`, `strand-formation-e2e` Phase 2. See "Relationship to the existing
tickets" below — they now look like the same defect.

## Error output

`control-db-two-node-convergence`, verbatim and reproducible on every run (the block id
changes, the revision pair does not):

```
SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10 retries: stale revision: block DCNRj_ikHhrpkDFJ1t84FWMGnH3P5upKqKta2MeAwxc at rev 3, requested rev 1
 ❯ Collection.syncInternal ../../../optimystic/packages/db-core/src/collection/collection.ts:407:12
 ❯ Collection.updateAndSync ../../../optimystic/packages/db-core/src/collection/collection.ts:443:4
 ❯ Tree.sync ../../../optimystic/packages/db-core/src/collections/tree/tree.ts:171:4
 ❯ TransactionBridge.commitDirtyTreesLegacy ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:402:9
 ❯ TransactionBridge.commitTransaction ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts:339:9
 ❯ OptimysticVirtualTableConnection.commit ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts:41:3
 ❯ TransactionManager.commitTransaction ../../../quereus/packages/quereus/src/core/database-transaction.ts:274:7
```

## What the instrumented run shows

`optimystic:db-core:collection` gained a `collection:invented` log in `bf7e3d2`'s parent
(`fb52c98`, `collection-open-vs-create-semantics`) — it fires whenever `Collection.createOrOpen`
finds no committed header and stages a fresh empty collection instead. Run the scenario with
`DEBUG='optimystic:db-core:collection'`:

```
cd packages/integration-tests
DEBUG='optimystic:db-core:collection' npx vitest run --reporter=dot control-db-two-node-convergence
```

Observed: **two bursts of seventeen `collection:invented` lines, ~220 ms apart** — node A's
bootstrap, then node B's — covering every control table including `default/CadrePeer`. There is
**no third burst**, so the write that later dies is *not* re-inventing the collection; it is using
an instance whose `actionContext` was set to `undefined` at invention time and never advanced.

That fits the observed constant: the request is `rev 1` on all ten attempts, i.e.
`newRev = (this.source.actionContext?.rev ?? 0) + 1` with a context that never left zero, while the
coordinator holds rev 1/3/6 depending on how much the other node wrote first.

**Hypothesis, not confirmed** (stated so whoever picks it up in `../optimystic` has a starting
point): both nodes invent the same collection during their own bootstrap, because at that instant
neither has committed a header. Each then holds a *staged, uncommitted* header in its own
`Tracker`. `Collection.updateInternal` refreshes context via `tracker.tryGet(this.id)` — which on
such a node returns **its own staged header**, not the cluster's — so the re-read can never observe
that the cluster has meanwhile committed a real header at rev N. The retry loop's only recovery is
that re-read, so it cannot converge, and the 10-retry budget turns a livelock into a thrown error
after ~20 s of backoff. `fb52c98` added `Collection.open` (returns `undefined` on an
authoritatively-absent header) precisely so read paths stop inventing — but the write path still
goes through `createOrOpen`, and a node that invents during bootstrap keeps that instance.

`fb52c98` and `bf7e3d2` are the two commits that most recently touched this surface
(`Collection.createOrOpen`/`open`/`probeHeader`, `TransactorSource`, `CoordinatorRepo`'s
absent-vs-unavailable classification, and `CollectionFactory` in `quereus-plugin-optimystic`).
That makes them the obvious suspects, **but no bisect was run** — checking out or reverting the
sibling repo was out of scope while its own automation was working in it. Do not treat the
attribution as established.

## Relationship to the existing tickets — they are probably one defect

Two blocked tickets already describe this error class at the same throwing line:

- `tickets/blocked/forked-control-collection-sync-livelocks` — `default/CadrePeer`,
  **rev 9 / requested 9**, trigger described as a manufactured fork (a local-only write while
  alone, then reconnect). It offers `tickets/plan/10-control-delete-while-alone-tombstone` as an
  in-repo mitigation, on the reasoning that removing the fork removes the failure.
- `tickets/blocked/strand-unique-index-sync-stale-revision` — `default/Member/index/_uniq_1`,
  **rev 2 / requested 1**, and states as an invariant that the collection which cannot sync is
  *"always a unique-index sub-collection, never the data tree."*

**Both of those scopings are now too narrow, and this ticket is the evidence:**

- `default/CadrePeer` is a **data tree**, so the unique-index invariant is falsified.
- `control-db-two-node-convergence` involves **no fork at all** — two nodes, one owner write, no
  partition, no restart, no local-only commit — so plan ticket 10 would not touch it.
- `strand-addr-seed-convergence` reproduces the **rev N / requested N** pair (1/1) that the fork
  ticket treats as its distinguishing fingerprint, on a plain strand join.

The revision pairs are not two fingerprints, they are one: *the client's context is at zero (or at
whatever it last saw) and the re-read cannot move it, while the coordinator is at whatever the
other node committed.* Whoever fixes this upstream should read all three tickets together and
expect one fix to close all three.

## Upstream already has a ticket waiting on exactly this run

`../optimystic/tickets/blocked/two-node-convergence-acceptance-cross-repo-build.md` asks a human
to rebuild the siblings and run
`packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts`, to
confirm three landed fixes (`d6a22d2`, `07cb230`, `d31be12`). Its stated outcomes:

> - **Passes** — the chain of three fixes is confirmed; close this and record it against them.
> - **Fails** — the mechanism fixed in this repo was necessary but still not sufficient, and the
>   next cause is somewhere else again. File the new failure as a fresh `fix/` ticket with the
>   scenario output attached; do not assume it is a fourth variation of the same quorum problem.

**That run has now been done, and it fails** — output above. Nothing was filed in `../optimystic`
from here: creating tickets in a sibling repo is outside this pass's scope, and its automation was
mid-ticket in those files at the time. A human relaying this result should note that the failure is
*not* a quorum/corroboration problem — it is a client-side revision-context problem, which is the
"somewhere else again" that ticket anticipated.

## Design constraints for the upstream fix (not a prescription)

- **A collection invented during bootstrap must be able to discover that the cluster committed a
  real header.** Refreshing context through a tracker that shadows the id with the node's own
  staged header makes the retry loop structurally unable to converge. Either the refresh must read
  past the local staging, or invention must be deferred until a write actually commits.
- **Two nodes must not both invent the same collection.** If bootstrap legitimately races, the
  loser needs a path to adopt the winner's header rather than carrying a permanently un-syncable
  instance.
- **A repeated *identical* stale rejection is not worth ten retries.** Ten attempts that all request
  rev 1 against a coordinator that keeps answering "rev 3" learn nothing, and burn ~20 s to produce
  a message that reads like ordinary contention. The coordinator's `latest.rev` would let the client
  rebase or fail fast — but `coordinator-repo.ts`'s own comment is explicit that the reject reason
  string is free-form prose and must never become control flow, so that number has to arrive as a
  structured field on `StaleFailure`.
- **Sereus needs to know which semantics it gets.** A named, immediate error (the fork ticket
  suggests `CollectionForkedError`) is strictly better for the control database than a generic
  retry-exhaustion after 20 s of backoff.

## Cross-cutting obligations

None on the sereus side: no schema, byte format, golden fixture, or determinism edition is touched
by anything proposed here. If the upstream fix changes `StaleFailure`'s shape (adding the
coordinator's revision as a structured field), sereus consumes it only through
`@optimystic/db-core`'s public surface and needs a dependency-floor bump, tracked the same way as
`tickets/blocked/report-dependency-floor-bump-to-embedding-app.md`.

## Do not

- Do not skip, `todo`, comment out, or loosen the assertions of any scenario listed above. They
  cover landed behaviour and they are failing on a real write defect, not a test bug.
- Do not edit or rebuild `../optimystic`'s or `../quereus`'s `src` to force a result. Rebuilding
  their `dist` is the guard's own prescribed remedy and is fine; editing their sources is not.
- Do not re-file this per scenario. One upstream defect, one ticket.
