---
description: One of the 57 integration scenarios fails twice in a row — a control-database read that runs while one of three nodes is deliberately isolated gives up with "the repo could not determine whether it exists" instead of answering from the two nodes that are still reachable. The scenario exists to prove a revision reaches an isolated node across a reconnect, so this failure hides whether that still works.
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-retry.ts
repro: verified
---

# Control read fails cohort-unreachable while one of three nodes is isolated

Measured 2026-09-15 23:12 and again 23:26, against optimystic `c56c2bd4` (its `yarn build` run
immediately before, both plugin packages, exit 0) and a green `yarn typecheck` across every sereus
workspace. **Failed both runs with the identical stack**, so it is not flake — see "Why load is not
the explanation" below.

Suite context: 57 integration files, 54 passed. The other two failures are a separate ticket
(`degraded-cohort-member-scenario-times-out-at-varying-steps`) and a fix already applied
(`control-bring-up-quiet-period`, per-op delay raised).

## What fails

`control-cohort-edge-carries-data.integration.ts` → "a revision authored on C while B is fully
isolated reaches B only across the reconcile-formed B→C connection". Three nodes, backbone severed,
B fully isolated by the harness.

```
QuereusError: Error during query on table 'Revocation':
  Query failed: Block default/Revocation is unavailable (cohort-unreachable):
  the repo could not determine whether it exists
```

Sereus's entry point is `ControlDatabase.readRowsOnce` (`control-database.ts:683`) under
`retryControlOperation` (`control-retry.ts:112`). Underneath:

```
BlockUnavailableError: Block default/Revocation is unavailable (cohort-unreachable)
 ❯ TransactorSource.tryGet   ../optimystic/packages/db-core/src/transactor/transactor-source.ts:56
 ❯ Tracker.tryGet            ../optimystic/packages/db-core/src/transform/tracker.ts:114
 ❯ Collection.updateInternal ../optimystic/packages/db-core/src/collection/collection.ts:545
 ❯ Collection.update         ../optimystic/packages/db-core/src/collection/collection.ts:478
 ❯ Tree.update               ../optimystic/packages/db-core/src/collections/tree/tree.ts:396
 ❯ OptimysticVirtualTable.runQuery ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts:1216
```

Serialized: `{ blockId: 'default/Revocation', reason: 'cohort-unreachable' }`.

## The thing to look at first

**A read reaches `Collection.update`.** Sereus asks for rows; three frames down the call is
`Tree.update` → `Collection.update` → `updateInternal` → `Tracker.tryGet`, and it is that `tryGet`
that raises. Worth establishing before anything else is changed:

1. Is that update expected on a read path at all (lazy tree maintenance, a cache fill, a fetch of a
   missing node), or is a read taking a write path it should not take?
2. `cohort-unreachable` is explicitly "could not determine whether it exists" — an *unknown*, not an
   absence. With one of three nodes isolated, two remain. Should a 3-node cohort with one node
   partitioned be able to answer this, and is the quorum rule here the one sereus expects?
3. The `Revocation` table is the one `every-membership-lookup-reads-an-empty-revocation-table`
   (in `plan/`) is about: a table that is empty in practice but read on every membership lookup. If
   an empty table's block has no committed revision, "cannot determine whether it exists" may be
   what an empty table looks like under partition — which would make this a real product defect on
   any partitioned party, not a test artifact.

That third possibility is why this is filed as a fix rather than a flaky-test ticket. **Rule it in
or out first**, because if it holds, the same read fails in the field whenever a party is
partitioned, and a phone on a flaky network is a partitioned party.

## The strongest lead, from upstream — try a committed read first

`optimystic-tend` read the plugin's source after receiving this stack (`../optimystic` commit
`cfbcdfea`, ticket `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`).
`OptimysticVirtualTable.runQuery` has **two arms**:

- a **committed** read pins a moment and deliberately never refreshes — its own comment says a
  mid-constraint pull would defeat the point of reading committed state;
- a **live** read calls `Tree.update()` first. That is the arm `readRowsOnce` takes, and it is the
  `Tree.update` in the stack above.

So the composed behaviour is that an isolated node cannot answer a live query **at all**, including
for rows already on its own disk, where the committed arm would have served them.

That makes the first experiment cheap and specific: **does the same read succeed as a committed
read while B is isolated?** If it does, the sereus-side question is which arm control-database reads
should take, and the answer may simply be "committed" — a read during a known partition can hardly
insist on a fresh view, and membership lookups tolerate a slightly stale one by design (they already
run under `retryControlOperation`). Establish that before building any workaround, and before
treating this as an upstream defect to wait on.

Upstream is treating it as a design question rather than a defect, with three candidate answers
recorded: it is intended and wants documentation plus a legible error; the refresh degrades and
reports that the answer is local (a read-side counterpart to the `WriteDurability` that 6.41 added
on the write side); or the error carries enough for a caller to retry as committed without
string-matching. Whichever lands, the sereus side of the decision is the same one above.

## What the sereus side probably is — read-only investigation, 2026-09-15 23:50

Established by reading only; nothing was run, because the device session holds the tree.

**1. Sereus already has the committed arm wired.** `readRowsOnce`
(`control-database.ts:674`) picks the arm today:

```ts
if (this.db!.getAutocommit()) {
  iterator = this.db!.eval(sql, params);                                  // live
} else {
  iterator = this.db!.eval(sql, params, { readConcurrency: 'committed' }); // committed
}
```

So the plumbing exists end to end and the question is not "can we ask for a committed read" but
**when we should**. Today the only trigger is "some writer's transaction is open" — a concurrency
concern. Partition is a second reason to prefer the committed arm, and nothing tests for it.

**2. The arms differ exactly as upstream described.** In `optimystic-module.ts:1204-1221`, the
committed arm builds both views in one synchronous block, pinning one moment and never refreshing;
the live arm does `await mainTree.update()` (and the same for the index tree) first. That
`Tree.update()` is the frame in the stack above, so the failure is the network refresh, not the
read of the rows.

**3. The error is structured, so a classifier needs no string-matching.**
`BlockUnavailableError` serializes as `{ blockId: 'default/Revocation', reason: 'cohort-unreachable' }`.
`reason` is a discriminable field. Upstream's third candidate answer — "the error carries enough
for a caller to retry as committed without string-matching" — may therefore already hold.

**4. Retrying live cannot converge, which is why this surfaces at all.** `retryControlOperation`
re-presents *the same attempt*, so every retry takes the live arm and refreshes against the same
unreachable cohort, until attempts or the budget run out and the last error is rethrown unchanged.
This is structurally the same trap as `control-db-bring-up-runs-before-first-connection`: retrying
cannot clear the condition that causes the failure. That ticket's fix was ordering; here the
candidate is arm selection.

**So the shape to try is:** an unlocked control read that fails with `reason === 'cohort-unreachable'`
falls back once to a committed read, rather than retrying live into the same wall.

**When running the experiment, assert WHICH revision came back, not that rows came back**
(upstream's warning, and it is a real trap here). The committed arm serves a pinned view, so if the
isolated node's last committed moment predates the revision authored on C, the read returns stale
but real rows — the experiment goes green while proving only that a committed read returns
something. This scenario exists to prove a specific revision crosses a reconnect, so the assertion
has to name it.

**The part that needs a decision, not just a patch.** A committed read answers from what this node
holds, which under partition may be stale or empty — and some callers of these reads are making
*authorization* decisions (`isAuthorizedMember`, and membership gates gated on it). A stale answer
that wrongly denies is an availability bug; a stale answer that wrongly admits is a security one.
Before wiring a fallback, enumerate which control reads can accept a local answer and which must
fail closed, and say so in the code. The `Revocation` table makes this sharper than usual: a
revocation that has not replicated to this node reads as "not revoked". **Do not give the whole
read funnel one blanket fallback.**

Related: `plan/every-membership-lookup-reads-an-empty-revocation-table` is about the same table and
the same read, from the cost side. Whoever takes either should read both — a change to when that
lookup runs at all may make this failure unreachable on the membership path.

## Why load is not the explanation

Both runs overlapped two SiteCAD ticket agents (`C:\projects\SiteCAD_branch` since 22:44,
`C:\projects\SiteCAD` a fresh ticket at 23:11). The machine was never quiet, so a passing run under
load was never available as a control. What rules load out is that the *same* error arrived at the
*same* frame twice, where the neighbouring timing-sensitive scenario failed at two different steps
on the same two runs. A contention failure moves; this one did not.

## Upstream

Reported to `optimystic-tend` with the full stack and node count; it will decide whether it belongs
in `../optimystic` as a db-core ticket. Do not wait on that to establish point 3, which is a sereus
question regardless of where the fix lands.

One correction recorded there, in case it reaches this ticket second-hand: this error was initially
described (by me) as being on the read path and therefore unrelated to optimystic's commit-path
changes in `6.41-write-durability-reaches-the-writer`. The stack shows it entering
`Collection.updateInternal`, so that reasoning does not hold. No claim that 6.41 caused it — there
is no before/after measurement — but the two have not been separated either.
