----
description: When two or more machines share a cadre, a row written on one of them no longer reaches the others. Most writes now fail outright after about twenty seconds of retrying, and the ones that do succeed never show up on the second machine. This affects every multi-machine scenario in the integration suite. The defect is in the shared database library kept in the sibling `optimystic` checkout, so it cannot be fixed here.
prereq:
files: packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, packages/integration-tests/src/scenarios/strand-addr-seed-convergence.integration.ts, packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/websocket-chat.integration.ts, packages/integration-tests/src/scenarios/convergence-stress.integration.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (scenario 2, circuit-relay), ../optimystic/packages/db-core/src/collection/collection.ts (syncInternal ~line 340-410, updateInternal ~line 180-250, createOrOpen/open/probeHeader ~line 60-140), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (classifyStaleRejection), ../optimystic/tickets/blocked/two-node-convergence-acceptance-cross-repo-build.md
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
| `control-delete-while-alone-convergence.integration.ts` — both tests | `SyncRetryExhaustedError` — `default/CadrePeer`, **at rev 3 (resp. 4), requested rev 1**. Both die symmetrically at ~15 s in Phase 1 setup (authorize X / converge on B — the same machinery as the write-while-alone entry above), **before** the delete or any revocation-drain code runs, so the scenario proves nothing about the delete-while-alone feature either way. Measured 2026-08-01 solo run (added later than the rest of this table: sereus at the `control-revocation-drain-on-growth` working tree, `../quereus` v4.6.0 `f620aade`) |
| `websocket-chat.integration.ts` — `should replicate a chat message over WebSocket` | `Timeout waiting for message replicates to phone after 15000ms` |
| `convergence-stress.integration.ts` — `should retain converged data after disconnect and reconnect` | 1 failed / 2 passed in that file |
| `push-wake-e2e.integration.ts` — `delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial` | intermittent; both class signatures — see "Folded in 2026-08-01" below |

`control-cohort-auto-convergence.integration.ts` was on the incoming report's list and now
**passes** — that one really was drift. It is not tracked.

Not re-measured here because they are already tracked and their tickets say a green run proves
nothing: `control-cohort-three-node-isolation`, `control-cohort-edge-carries-data`,
`control-write-degraded-cohort-member`, `strand-membership-closed-strand-e2e`,
`strand-formation-e2e` Phase 2. See "Relationship to the existing tickets" below — they now
look like the same defect. (`zz-scratch-delete-alone`, formerly on this list, was a scratch
experiment deleted 2026-08-01; its successor `control-delete-while-alone-convergence` is
measured in the table above and dies in this class, earlier than the fork it was built to
provoke.)

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
  alone, then reconnect). It once offered the delete-while-alone plan work as an in-repo
  mitigation; that work has since shipped (the revocation tombstone + growth-edge drain) and
  does NOT remove the fork, so that ticket now records the upstream fix as its only unblock.
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

## Validation 2026-08-01 — re-measured against optimystic v0.18.0

The tickets in this class were all filed on 07-31, while `../optimystic` was mid-flight landing
`collection-open-vs-create-semantics` (19:56) and `repo-reports-unavailable-vs-absent` (20:44).
Because sereus resolves `@optimystic/*` to that checkout's **source**, those measurements were
taken against a moving tree and could not be trusted either way. Optimystic has since cut
**v0.18.0** (`9a06f1b`, 08-01 20:11) and sereus's declared ranges are already `^0.18.0`.

Re-measured at sereus HEAD with a full `yarn build` first (so the freshness guard passes and the
`dist/` the integration suite actually loads is current):

- `yarn build` — clean.
- `packages/integration-tests` full suite — **12 files failed / 28 passed (40); 16 tests failed /
  198 passed / 6 skipped (220)**, 655 s.

Every one of the 16 is already catalogued in `tickets/.pre-existing-known.md` against this ticket
or its siblings. Nothing new appeared, and nothing in this class cleared. **The class is real at
v0.18.0 — it was not an artifact of measuring against a moving checkout.**

Failure signatures observed, grouped:

- `SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10 retries: stale
  revision: block … at rev 3, requested rev 1` — the fork livelock, exactly as described above.
- `PartialCommitError: Legacy multi-tree commit was not atomic` — row tree `default/CadrePeer`
  durably committed, index tree `default/CadrePeer/index/_uniq_5` not. This is
  `strand-unique-index-sync-stale-revision`, and the partial commit is now *reported* rather than
  silent.
- `Missing block (…)` raised from `create table CadreControl.OwnerKey` and from ordinary reads.
- `Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.`

## A hypothesis the next session should test first

The last two signatures did not exist before v0.18.0, and both are the *intended* effect of the
two changes that landed on 07-31: `open` no longer invents a collection it could not fetch, and the
repo layer now distinguishes "unavailable" from "absent". That suggests these are not new breakage
but **newly visible breakage** — a node that previously read an invented-empty collection and
reported "no rows" now says `Missing block` instead.

If that is right, part of the earlier green on this suite was false, and the underlying
replication fault has been present the whole time. That would be good news about v0.18.0 and bad
news about how much of this suite ever proved what it claimed.

It is a hypothesis, not a finding. What would settle it: run the same scenarios against published
`@optimystic/*` **0.17.0** (drop the `resolutions` link, install from the registry) and compare.
If they pass there and fail here, the semantics change is the trigger and the sereus-side work is
to handle the honest error. If they fail on both, v0.18.0 is incidental and the write path was
already broken.

## Folded in 2026-08-01 — `push-wake-e2e` scenario 2 (circuit-relay)

`packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts` →
`E2E push-wake over the control network > delivers a wake to a NAT'd receiver over a
circuit-relay (signaling-first) dial` belongs to this class. It arrived as a separate
pre-existing-failure report during `debt-membership-gate-coalescing-refresh-tests`, and is
folded here rather than filed anew per the "one upstream defect, one ticket" rule above.

Measured at sereus `c1043b5`, `../optimystic` clean at `9a06f1b` (v0.18.0), `../quereus` clean
at `f620aade` (v4.6.0), suite stale-build guard green on every run:

| Run | Result |
| --- | --- |
| whole file (`push-wake-e2e.integration.ts`) | 4/4 pass, 36 s |
| solo (`-t "circuit-relay"`), 4 runs | **3 fail / 1 pass** |

Two signatures across the three failures, both already listed in this ticket:

1. Rx's own control-DB schema load dies bringing up the table the party already has —
   the rev-N/requested-N pair, on the *schema* collection rather than a data tree:

   ```
   QuereusError: Failed to execute DDL: create table CadreControl.OwnerKey (…)
   Error: Module 'optimystic' create failed for table 'OwnerKey': Failed to initialize
     Optimystic table: sync for collection optimystic/schema exhausted 10 retries:
     stale revision: block optimystic/schema at rev 1, requested rev 1
    ❯ OptimysticVirtualTable.doInitialize
      ../../../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:316:13
    ❯ ControlDatabase.loadSchema ../cadre-core/src/control-database.ts:534:5
   ```

   The incoming report saw `Missing block (…)` at this same line instead; that is the other
   v0.18.0 face of the same thing, already noted under "Validation 2026-08-01".

2. The plain convergence timeout, identical in shape to `control-write-while-alone-convergence`:

   ```
   Error: Timeout waiting for Rx observes S's CadrePeer membership row written on L after 30000ms
    ❯ waitForCadrePeerConverged src/harness/test-network.ts:322:3
   ```

**Why it is this defect and not the membership gate.** Scenario 2's own comments warn that a
stale per-stream gate snapshot kills exactly this bring-up, so that was ruled out first: under
`DEBUG='sereus:cadre:*'` the reporting session recorded **zero**
`authorizeInboundControlStream: DENYING` lines, and the write-driven
`refreshAuthorizedControlPeers(peer-insert)` fired promptly (1 then 2 authorized peers). The
throw is upstream of any sereus gate, at `Collection.syncInternal`'s retry exhaustion.

**Why solo fails and whole-file passes.** Not evidence of test pollution — every scenario in
the file mints its own `partyId`/`strandId` from `Date.now()` and tears its nodes down in a
`finally`. Solo simply starts cold (first-fork import + JIT), which widens the window in which
L has committed the party's schema/`CadrePeer` header while the joining node's collection
instance is still contextless. So **a green whole-file run proves nothing here**, the same
caveat this ticket's other entries carry. Re-measure with `-t "circuit-relay"`, several runs.

Scenario 2 is the most exposed member of this file because it is the only one where a node
joins a party whose control collections were **already committed by another node** (relay L
genesises alone, S and Rx join after). Scenarios 1/3/4 either write from the node that
invented the collection or never form the cohort at that instant.

Note for whoever re-measures: `tickets/.pre-existing-known.md` lists this same test under
**"Resolved in place"** for `UnsupportedListenAddressesError` in the circuit-relay reservation
store, fixed by `strand-delegate-peer-relay-admission` (2026-07-29). That fix stands — the
relay reservation now materialises correctly, and none of the failures above mention it. Same
test, different defect.

## For the optimystic side

`../optimystic/tickets/blocked/two-node-convergence-acceptance-cross-repo-build.md` is waiting on
exactly this measurement — three convergence fixes shipped there without ever being confirmed
against the real end-to-end test, because that test lives here and the agent could not do the
cross-repo rebuild. **The rebuild has now been done and the answer is: still failing.**
`control-db-two-node-convergence` ("replicates an owner-written CadrePeer row from node A to node B
over the live control network") fails at 19.5 s against v0.18.0.

## Validation 2026-08-02 — re-measured after `stale-failure-carries-coordinator-revision`

Optimystic has since landed `cluster-read-consult-cannot-report-unreachable` and
`stale-failure-carries-coordinator-revision` (the structured coordinator revision on `StaleFailure`
that the "What upstream needs to change" section above asked for). Rebuilt both checkouts
(`../optimystic` `yarn build`, then sereus `yarn build`) and re-ran the anchor scenario.

`control-db-two-node-convergence` — **still failing**, but the failure has changed shape in a way
worth acting on:

```
Query failed: collection default/CadrePeer holds committed revision 3, but its header block read
as absent — storage reported that nothing was ever committed under this id
  at OptimysticVirtualTable.runQuery (../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:552)
  at ControlDatabase.queryStampId (packages/cadre-core/src/control-database.ts:747)
```

Two things changed:

1. **It fails in 619 ms of test time, not 19.5 s.** No retry storm, no timeout — the read reports a
   specific inconsistency immediately.
2. **The claim is now local and checkable**, and it is not a networking claim. The collection's own
   metadata says committed revision 3 exists; the header block under that same collection id reads
   as *absent* — and, per the new absent-vs-unavailable distinction, absent means storage
   affirmatively reported nothing was ever committed there, not that a fetch failed.

That is the strongest support yet for the unmasking hypothesis recorded in the 08-01 section: a
node in this state previously fell through to an invented empty collection and answered "no rows".
The fault was always there; three rounds of upstream retry/quorum fixes could not have cleared it
because it is not a retry or quorum problem.

## Folded in 2026-08-02 — `strand-formation-e2e` Phase 2 (re-measured against a clean sibling)

`packages/integration-tests/src/scenarios/strand-formation-e2e.integration.ts` →
`E2E Strand Formation > Phase 2: Strand instance lifecycle > should form strand, start instances,
and replicate data` → `Timeout waiting for data replicates from Alice to Bob after 15000ms`.

It sat in the "not re-measured" list above, and `tickets/.pre-existing-known.md` carried it as a
caution note attributed to build drift from `../optimystic`'s then-uncommitted cluster-policy work,
with an explicit instruction to re-measure against a clean sibling before concluding drift again.
**That re-measurement has now been done and the drift attribution is dead.** Measured during
`debt-approval-gated-redemption-e2e-validate` (validation ticket, then its review pass), with
`../optimystic` **clean at `092f33f`** (`ticket(review): stale-failure-carries-coordinator-revision`)
and `../quereus` freshly built so the suite's stale-build guard passed on every run:

| Runs (`yarn workspace @serfab/integration-tests test strand-formation-e2e`) | Result |
| --- | --- |
| 5 whole-file runs across the two passes | this test **failed 4, passed 1**; each failure ~15.6-15.9 s, the other 21 tests in the file pass every run |

The single pass was the first run of the validation pass, before two forced clean rebuilds of
`../quereus`; the four runs after it all failed the same way. So it is **predominantly failing and
not drift** — the sibling was clean and freshly built for every run, including the failures. Same
standing class as every other entry here: a cross-node replication that never completes. Treat it
as reproducible-but-not-certain: budget several runs, and **a single green run proves nothing**,
the caveat this ticket's other entries already carry. Folded here per this ticket's
"one upstream defect, one ticket" rule rather than filed anew. It is a cheaper reproduction than
`strand-membership-closed-strand-e2e` (one test in a file that is otherwise green, ~16 s to the
failure) and does not require the closed-strand membership machinery, so it is worth trying first
when instrumenting the header-block question below.

Knock-on for `tickets/blocked/strand-unique-index-sync-stale-revision`: its unblock condition 1
says to wait for the sibling to settle and "confirm `strand-formation-e2e` Phase 2 is green again
before judging anything here". The sibling has settled and Phase 2 is **not** green, so that gate
is not met by waiting — it is met only by fixing this class.

## Where to look next

A collection holding revision 3 with no header block under its id is either a write that recorded
metadata without durably placing the header, or a header written under a different id than the one
the read derives. The header block id is the collection URI path (`default/CadrePeer`) and is
rewritten only when the BTree root node id changes, so a revision that advanced without a
corresponding header rewrite would produce exactly this. Worth one focused session, and it is
cheap to instrument now that the error names the collection and the revision.

Which side of the repo boundary the bug sits on is no longer obvious, so do not assume upstream:
the write path runs through sereus's `ControlDatabase` and the quereus-plugin-optimystic bridge as
well as `db-core`. Confirm where the header goes missing before filing anywhere.

## Reclassified 2026-08-02 (partial)

The header-absent defect described in the 08-02 measurement above is now tracked as an active
ticket, `fix/bug-control-collection-header-absent-at-committed-revision`, because nothing
establishes it as out-of-repo. **Do not investigate it from here** — that ticket carries the repro
and the constraints.

This ticket stays in `blocked/` as the record for the class and for the siblings that still look
genuinely upstream (`forked-control-collection-sync-livelocks`,
`strand-unique-index-sync-stale-revision`, `control-reads-blocked-by-stalled-write`). If the fix
ticket's trace lands upstream after all, fold its findings back in here.
