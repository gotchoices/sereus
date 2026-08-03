----
description: A shared-settings table reports that it has saved changes, while the record that says where its data lives reads as never having been written at all. Reads of that table then fail outright. This is the defect behind every failing multi-machine test.
prereq:
files: packages/cadre-core/src/control-database.ts (queryStampId ~line 747, and the write path that precedes it), packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (runQuery ~line 552 — raises the error), ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (commitDirtyTreesLegacy ~line 400), ../optimystic/packages/db-core/src/collection/collection.ts (createOrOpen/open/probeHeader ~line 60-140, syncInternal, updateInternal)
difficulty: hard
----

# A control collection holds a committed revision with no header block under its id

Reproduces deterministically and fast. From sereus root:

```
yarn build
cd packages/integration-tests
npx vitest run src/scenarios/control-db-two-node-convergence.integration.ts --reporter=verbose
```

```
Query failed: collection default/CadrePeer holds committed revision 3, but its header block read
as absent — storage reported that nothing was ever committed under this id
  at OptimysticVirtualTable.runQuery (../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:552)
  at ControlDatabase.queryStampId (packages/cadre-core/src/control-database.ts:747)
```

Measured 2026-08-02 against `../optimystic` at `092f33f`. Fails in ~600 ms of test time — there is
no retry storm and no timeout, so this is not a contention, quorum, or reachability problem.

## Why this ticket exists now

This defect spent several days in `tickets/blocked/control-db-cross-node-convergence-halted.md`,
classified as an out-of-repo dependency. That classification rested on the old symptom — a 20 s
retry storm ending in `SyncRetryExhaustedError` — which genuinely did point at upstream retry
logic. Three rounds of upstream retry and quorum fixes have since landed and none of them cleared
it, which is itself evidence that the retry layer was never the cause.

Optimystic's newer absent-vs-unavailable reporting has now replaced that symptom with a specific,
local claim, and **nothing in it establishes which side of the repo boundary is at fault**. The
write path runs through sereus's `ControlDatabase` and the quereus-plugin-optimystic bridge as well
as `db-core`. So it comes back into the active pipeline until someone actually traces it.

Read the `## Validation` sections of the blocked ticket first — they carry the measurement history
and the retracted hypotheses, and are worth more than re-deriving them.

## The question to answer

`default/CadrePeer` reports committed revision 3. The header block under that same id reports
absent — and per the new distinction, *absent* means storage affirmatively reported nothing was
ever committed there, not that a fetch failed.

Both cannot be true. Find which one is lying, and where.

The header block id is the collection URI path (`default/CadrePeer`) and is rewritten only when the
BTree root node id changes. A revision that advanced without a corresponding header rewrite would
produce exactly this state, so that is the first hypothesis to test — but test it, do not assume it.
Candidate shapes worth distinguishing:

- the header was never durably placed, while metadata recording the revision was;
- the header was written under a different id than the read derives;
- the header was placed and then lost or overwritten by a later commit;
- the revision number itself is being reported from a source that outlives the header.

Instrument rather than reason from the code alone. The scenario is deterministic and cheap to run,
so log the header id and revision at every write and read on both nodes, and say which node is in
the inconsistent state — writer, reader, or both.

## Constraints

- **You may read `../optimystic` and `../quereus` freely. You may not edit their sources.** They are
  active workspaces belonging to someone else. Rebuilding their `dist` (`yarn build`) is fine and is
  sometimes required for the freshness guard.
- If the trace lands on a sereus defect, fix it here and hand off to `implement/` as normal.
- If it lands upstream, move this ticket to `blocked/` with the trace, the exact file and line, and
  what the upstream change needs to be — not a hypothesis. Precision is the whole deliverable in
  that case, because three upstream fixes have already been spent on this class.
- Do not skip, `todo`, or loosen any scenario in `tickets/.pre-existing-known.md`. They cover landed
  behaviour and are failing on a real defect.

## Why it is worth the effort

Twelve integration files and sixteen tests fail on this class, all of them multi-machine. It is the
only thing holding the next release. It is also likely that some earlier green on this suite was
false — a node in this state used to fall through to an invented empty collection and answer
"no rows" instead of failing.

## Re-measured 2026-08-02, after the corroboration-floor fix (`42cd12c`)

The quorum stall that used to mask this is gone. `CONTROL_CLUSTER_POLICY` now declares
`assumedClusterSize: 2`, which stops Optimystic's repair corroboration floor from falling back to
`clusterSize` (16) and demanding two non-self corroborators a two-node party can never field. Full
integration suite went from **12 files / 16 tests** red to **8 files / 17 tests** red; the
convergence class specifically went from all-red to 6 of 8 green. See the blocked class ticket for
the mechanism.

What that leaves is this defect, standing alone and no longer competing with a retry storm. Three
things sharpen the target:

**It is not one collection.** Observed on `default/CadrePeer` at revision 3 and on
`default/OwnerKey` at revision 1, in the same suite. Whichever the scenario reads first is the one
that throws. So do not chase `CadrePeer` specifically — any control collection can be in this state,
and revision 1 means it can happen on the *first* commit, which rules out "a later commit
overwrote the header" as the general explanation.

**It is not only the collection tree.** `provider-seed-accepted` fails with

```
Module 'optimystic' create failed for table 'Revocation': Failed to initialize Optimystic table:
Cannot add to non-existent chain
```

which is `Chain.add()` at `../optimystic/packages/db-core/src/chain/chain.ts:102`, thrown when
`getTail()` finds no path — i.e. the chain's header block is absent at a point where the chain is
believed to exist. Same shape, different structure. Whatever is failing to durably place or
correctly address a header is doing it for chains as well as collection BTrees, which argues for a
cause below both: the block-placement or id-derivation layer, not `Collection`'s own logic.

**It now accounts for the newly-failing scenarios too.** `provider-seed-accepted` (4 tests) and
`strand-unpublish-sibling-convergence` (1 test) were not in `.pre-existing-known.md` before today.
Both fail in isolation, so neither is contention; both carry a fingerprint above. They are not
regressions from `42cd12c` — they are this defect becoming reachable now that writes are no longer
dying earlier in the quorum path.

Current failing set carrying this fingerprint:

- `control-db-two-node-convergence` — `default/CadrePeer` rev 3 (intermittent in whole-suite runs,
  deterministic when the class runs alone; it passed in the 08-02 full run and failed in the class
  run, so do not treat a single green as a fix)
- `strand-unpublish-sibling-convergence` — `default/OwnerKey` rev 1
- `provider-seed-accepted` steps 2-5 — chain variant, cascading into
  `Timeout waiting for node A peer identity` and `Cannot read properties of undefined (reading 'peerId')`
- `push-wake-e2e` (2 tests) — `default/OwnerKey` rev 1

Two failures in the current set do **not** carry it and are not this ticket:

- `convergence-stress` disconnect/reconnect — `Self-coordination blocked: grace-period-not-elapsed.
  No coordinator available for key.` A rejoining node cannot self-coordinate and does not wait out
  its own grace period. New shape, previously masked, needs its own ticket.
- `control-cohort-edge-carries-data` carry step — already tracked as
  `fix/control-read-over-fresh-edge-stream-resets`.

Caveat on attribution: `../quereus` was rebuilt in the same window (its runner had committed but not
built), so two variables moved between the last full measurement and this one. The chain error is an
Optimystic message and the header-absent errors predate the quereus rebuild, so neither new failure
is plausibly quereus's — but if something here refuses to reproduce, that rebuild is the other thing
that changed.

## Sharper fingerprint from `provider-seed-accepted` (measured 2026-08-03, 4 runs)

This scenario's entry above (line "chain variant, cascading into `Timeout waiting for node A peer
identity`") is now out of date, and the replacement is a *better* probe than the old one.

The chain/DDL half is gone — `29.4-verify-ddl-retry-engages` landed the schema-init retry, so all
three real nodes now start cleanly every run. What is left is this defect, and it surfaces
**directly on a write** rather than as a startup cascade:

```
insert failed: collection default/CadrePeer/index/_uniq_5 holds committed revision 2,
but its header block read as absent — storage reported that nothing was ever committed under this id
```

Three things this adds:

- **It is a unique-index sub-collection, not a table collection.** Every fingerprint recorded above
  is a top-level collection (`default/CadrePeer`, `default/OwnerKey`). `default/CadrePeer/index/_uniq_5`
  is the index tree beneath one. Same message, same absent-vs-unavailable distinction, one level
  down — which strengthens the "cause is below `Collection`, in block placement or id derivation"
  reading already in this ticket, since index trees and table trees share that layer and little else.
- **It is on the writer, at insert time.** The throw comes out of the owner node's `addDrone`
  (`OwnerNodeClient.addDrone` → the owner's own `insert` into `CadrePeer`), not out of a reader
  querying a collection someone else wrote. Every earlier fingerprint here was a read
  (`ControlDatabase.queryStampId`). So the inconsistent state is observable by the process that owns
  the write path, which should make instrumenting it much cheaper than the two-node read cases.
- **Revision 2, with a known concurrent writer.** Node A self-publishes its own `CadrePeer` record
  during enrollment while the owner is inserting the drone row for that same node. Two writers, one
  index tree, second commit.

Frequency: 3 of 4 runs at HEAD on 2026-08-03 (run 1 green end to end; runs 2-4 red, identical
fingerprint, failing step 3 and step 5 — both of which are `addDrone` inserts). So the scenario is
**not** deterministic for this defect, but it is majority-red and it is cheap: the failure is a poll
timeout at 60 s, and the underlying insert throws in milliseconds.

Repro (from sereus root; needs `../quereus` buildable — see caveat below):

```
yarn workspace @serfab/integration-tests test src/scenarios/provider-seed-accepted.integration.ts
```

The scenario now prints the mint error, the last delivery result and the child's `node.log` on a
poll timeout, so a red run states this fingerprint outright instead of reporting a bare timeout.

Caveat on the 2026-08-03 measurement: after those four runs, `../quereus` acquired uncommitted
in-flight edits from its own owner that do not compile
(`rule-cte-optimization.ts(89,12): error TS2339: Property 'tableDescriptor' does not exist on type
'CTECapable'`), so its `dist` cannot be refreshed and the integration suite's stale-build guard
refuses to start. That is transient and belongs to that workspace, but anyone re-measuring this
class today will hit it before they hit this defect.

## Repro update

The command in the header still reproduces, but not on every run of the whole suite. Deterministic
form:

```
cd packages/integration-tests
npx vitest run --reporter=verbose control-db-two-node-convergence control-cohort-cold-start-retry \
  strand-addr-seed-convergence control-write-while-alone-convergence convergence-stress
```

`strand-unpublish-sibling-convergence` alone is the cheapest single repro at ~900 ms.
