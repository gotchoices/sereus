----
description: Reads of the shared settings hang while a settings change is stuck waiting on a slow machine, and the cause is in the separate database engine project rather than in this one — someone needs to decide whether to fix it there or work around it here.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, ../quereus/packages/quereus/src/core/database.ts
difficulty: hard
----

> **UNBLOCKED 2026-08-21 — both upstream halves have landed; moved out of `blocked/`.**
> This sat waiting on "the upstream opt-in landing" in `../quereus` and `../optimystic`. Verified
> directly in the sibling checkouts rather than from ticket text:
>
> - **Quereus** ships the engine side: `ConcurrentReadScope` and a `concurrentReads` registry in
>   `packages/quereus/src/core/database.ts`, and a per-module concurrency declaration in
>   `packages/quereus/src/vtab/module.ts` (`'reentrant-reads'`, plus an opt-in flag whose doc says
>   "Omit (default `false`) to decline the engine's concurrent committed-read" path).
> - **The optimystic vtab opts in**: `packages/quereus-plugin-optimystic/src/optimystic-module.ts`
>   declares `readonly concurrencyMode = 'reentrant-reads' as const` and implements
>   `initializeForCommittedRead()`.
> - **Sereus is already on versions carrying both** — `@quereus/quereus ^4.16.0` and
>   `@optimystic/* ^0.24.2` as of `3bf4b35`, and both resolve to published releases.
>
> So step 1 of this ticket's own plan ("adopt the new Quereus version") is done. What remains is
> entirely in this repository: opt `ControlDatabase`'s read methods into committed-read
> concurrency, then flip the reproducer. Routed to `fix/` rather than straight to `implement/`
> because the exact opt-in surface still has to be read out of the new Quereus API before the
> change can be specified — that is research, which is what the fix stage is for.
>
> **The acceptance test already exists and is still red-by-design.** `it.fails('a control read
> answers locally while a write is stalled')` at
> `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts:825`
> is the "1 expected fail" that shows up in every full-suite run. When this lands it becomes a
> plain `it`, and the count of expected failures in the suite goes to zero.
>
> Two upstream references in the body below are now dangling and should not be chased:
> `../quereus/tickets/plan/concurrent-committed-reads` was processed (`df53afdfc`) and has left
> that board, and no `feat-concurrent-committed-read-readiness` remains in `../optimystic`. Both
> repos prune completed tickets after 30 days, so the pointers outlived the work — the code above
> is the evidence that matters, not the tickets.
>
> **Caveat on the scenario itself:** `control-write-degraded-cohort-member` is intermittently red
> for an unrelated reason (measured 1 failure in 5 runs on 2026-08-21, at suite-setup level rather
> than in this ticket's case). Do not read a red file as this ticket's symptom without checking
> which case failed.

# Control reads block behind a stalled control write — cause is in Quereus, not Sereus

## Decision made (2026-08-04): option (A), fix upstream

Human chose (A). Upstream plan ticket filed: `concurrent-committed-reads` in
`../quereus/tickets/plan/` (opt-in concurrent committed reads — assessment found
the `_readCommitted` vtab contract already exists engine-side and in the
optimystic plugin, so the change is engine plumbing, not a new concurrency
model). A readiness ticket also filed in `../optimystic/tickets/backlog/`
(`feat-concurrent-committed-read-readiness`) covering the stalled-commit
regression test and concurrency-mode declaration. This ticket stays blocked on
those external repos shipping; when the upstream opt-in lands, the work here is:
adopt the new Quereus version, opt `ControlDatabase`'s read methods into
committed-read concurrency, and flip the reproducer case from `it.fails` to
plain `it` (see "Done means").

## Original decision request (resolved)

The defect is fully diagnosed and reproducible. It cannot be fixed inside this
repository: the blocking code lives in `../quereus`, a **separate git repo** that Sereus
consumes as the published dependency `@quereus/quereus` (linked locally for development
via the root `package.json` `resolutions`). A ticket run in this repo cannot land a
commit there.

Pick one (details in "Two ways forward" below):

- **(A) Fix upstream in Quereus** — promote a ticket in `../quereus/tickets/`. Correct
  layer, benefits every consumer, but it changes the engine's concurrency contract.
- **(B) Work around it in `cadre-core`** — keep a snapshot of the control tables and
  answer reads from it while a write is in flight. Stays in this repo, but it is a
  workaround that has to be maintained until (A) lands.

Recommendation: **(A)**, with (B) only if the Quereus change is judged too large to take
on now. (B) duplicates state and adds a staleness surface that (A) removes outright.

## What was measured (root cause is proven, not suspected)

The original ticket listed two suspects. A probe run against the real three-node
scenario settled it — **one is the whole cause, the other is ruled out.**

Probe: stand up the same trio as
`control-write-degraded-cohort-member.integration.ts` (node C's inbound cluster protocol
handler held open forever, coordinator pinned to A), start `A.authorizePeer(...)`
unawaited, wait 250 ms, then do the same read twice:

| read | result |
| --- | --- |
| `ControlDatabase.hasOwnerKey()` as-is | **hangs** — still unanswered at 8 s |
| same read with Quereus's per-`Database` execution mutex stubbed out | **answers `true`**, immediately |

At the moment of the read the inner Quereus database reported `_isExecuting=true` and
`getAutocommit()=false` — i.e. the write statement holds the engine and its implicit
transaction is open.

**Cause.** `@quereus/quereus`'s `Database` serializes *every* statement — reads
included — through a single promise-chained mutex (`execMutex`,
`../quereus/packages/quereus/src/core/database.ts`, `_acquireExecMutex` around line 516).
`Database.exec()` holds that mutex across `_commitTransaction()` (~line 757), and
`Database.eval()` acquires it before it even prepares the query (`_evalGenerator`,
~line 1832). Underneath, the control write's commit reaches
`../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`
→ `session.commit()`, which is the distributed pend/commit that stalls for ~20 s against
the silent cohort member. So the mutex is held for the whole network round, and every
read on that node queues behind it.

A standalone check confirms the mutex alone is sufficient to cause this: holding it for
3 s with no I/O at all makes a `select count(1)` take 2955 ms against a 7 ms baseline.

**Ruled out.** The optimystic read path does *not* block on the in-flight block. The
mutex-bypassing read above went all the way through the optimystic vtab, with the stalled
write's pend outstanding, and answered instantly. The original ticket's first suspect
("a repo-level read of a block with a pending version waits on the pend's outcome") is
wrong — drop it.

Also still true, and still not the cause: `ControlDatabase.withWriteLock`
(`packages/cadre-core/src/control-database.ts`, ~line 1134) deliberately does not lock
reads. The blockage is one layer below it.

## Two ways forward

### (A) Fix upstream in Quereus

Shape of the change: the engine currently equates "a statement is running" with "nobody
else may touch the database". That is SQLite's model, and it is fine when a commit is a
local fsync — but a Quereus vtab commit can be an arbitrarily long network round, and
during that window a read of the *pre-commit* state is both safe and exactly what callers
want. So: split the single mutex into something that lets read-only statements run while
a writer is in its substrate-commit phase, while still excluding a second writer.

Care needed on two points the probe deliberately papered over:

- The bypassing read saw the writer's *uncommitted* staged state. A real fix must serve
  the last committed state, not the in-flight one.
- `Database.eval()`'s cleanup calls `_finalizeImplicitTransaction()`, which commits or
  rolls back whatever implicit transaction is open — during a concurrent write that is
  the *writer's* transaction. A concurrent reader must not touch it. (The probe stubbed
  this out; production code cannot.)

Note `_isExecuting()` is already exported as consumable API for hosts that must defer
rather than re-enter, so the engine already acknowledges this seam exists.

There is no existing ticket for this anywhere in `../quereus/tickets/` — checked.

### (B) Work around it in `cadre-core`

Before a control write takes `withWriteLock`, refresh an in-memory snapshot of the
control read surface (owner key, `CadrePeer` rows, membership); while a write is in
flight, `ControlDatabase`'s read methods answer from that snapshot instead of issuing a
query. Because the snapshot is captured at a commit boundary, "answer from the snapshot"
and "serve the last committed local state" are the same thing, which is what the original
ticket asked for.

Costs, honestly: a second copy of the control state to keep correct; every write pays a
snapshot refresh (the control tables are small, so this is latency, not a scaling
problem); and the snapshot can miss changes that arrived from peers since the last
refresh, so it is "last committed state this node observed", not "latest known
anywhere". None of this goes away on its own — it has to be maintained until (A) lands
and then removed.

## Reproduce

```
cd packages/integration-tests
yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts --reporter=verbose
```

The case `a control read answers locally while a write is stalled` is currently marked
`it.fails` (a standing reproducer, not a skip — vitest still runs it and will fail the
suite the day it starts passing). Flip it to a plain `it` to watch it fail with
`degraded-cohort control op hasOwnerKey (during stall) timed out after 15000ms`.

Note the whole scenario file is slow (~5 min). The probe described above reached the same
conclusion in ~20 s by trimming the file to its `beforeAll` plus one case; it was a
throwaway and is not checked in.

## Done means (unchanged from the original ticket)

- Reads on a node with an in-flight (including stalled) control write answer from
  committed local state within the scenario's 15 s read deadline.
- That scenario case passes as a plain `it`, with the `it.fails` annotation and its
  explanatory comment removed (the file header's paragraph about the standing expected
  failure comes out too).
