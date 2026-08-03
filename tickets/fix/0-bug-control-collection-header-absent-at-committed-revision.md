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
