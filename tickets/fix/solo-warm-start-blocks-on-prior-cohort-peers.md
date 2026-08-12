----
description: A phone that was once part of a group and is now the only device left may freeze on startup, because starting a workspace first asks the shared directory who else is in the group — an unlimited wait, on the path every app waits for. Our only test of the alone-device case starts from a blank slate, so it cannot see this.
prereq:
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, scripts/lib/published-smoke-scenario.mjs, docs/STATUS.md
difficulty: medium
----

# Reproduce the solo hang the embedding app reports — warm start with prior-cohort peers

## Why this exists

An outside team embedding `@serfab/cadre-core` 0.10.0 in a React Native app has now reported
three times that a lone device freezes on its control database. Each round we have refuted
their proposed mechanism against our source and pointed at
`packages/cadre-core/test/control-database-solo.spec.ts`, which covers their exact node
configuration and passes in under a second. Their configuration really is ours — a review of
their checkout confirmed `transports: [webSockets()]`, `listenAddrs: []`,
`bootstrapNodes: []`, no relay, no persisted high-water mark, and `shouldAllowSelfCoordination`
granting self-coordination as `bootstrap-node`. Coordinator selection is not their problem.

What the review did find is that **our test and their app do not do the same thing at boot**,
in two ways our test cannot express. This ticket is about closing that gap in *our* repo. It
is not about their code.

## The two differences

**1 — They await an unbounded control read on the critical path, before genesis.**
Their boot calls `addStrand`, which reaches `CadreNode.resolveCohortSeed`
(`packages/cadre-core/src/cadre-node.ts` ~3500), whose first statement is
`await this.controlDatabase.queryCadrePeers()` (~3553) — two full control-table scans through
the network transactor. Our spec's order is the reverse: owner genesis, then seed bootstrap,
then peer queries. So on every cold boot their control database's *first* operation is a read
issued before an owner key exists and before seed bootstrap is wired — a sequence we never
exercise. Nothing bounds that read, and it is on a path embedders await during startup.

**2 — Our solo spec always starts from nothing.** It uses `MemoryRawStorage` and a fresh
database per run; its own comment at lines 118-121 already admits this
("proves the hydrate-before-apply path but not the storage backends embedders actually restart
on"). Their device uses persistent storage, and `CadrePeer` rows from an earlier multi-device
session survive in it. So their `resolveCohortSeed` runs with a **non-empty member list and
zero reachable peers** — a state a cold, memory-backed test cannot construct.

That combination is the most specific untested shape we know of that matches the report:
a control read, unbounded, first, against a member list naming peers that are all gone.

## What to do

**Reproduce first — this is a `fix/` ticket, and the reproduction is the deliverable.** Do not
change engine behaviour before there is a failing test.

Build a solo node on persistent (not memory) storage, write `CadrePeer` rows naming one or more
peers that do not exist, restart it alone, and call the boot sequence their app uses —
`start()` then `addStrand()` — with a per-operation deadline in the same style the existing
solo spec uses. Then answer plainly:

- Does it hang? If yes, where exactly — name the frame, with the debug namespaces enabled.
- If it does **not** hang, say so and stop. That is a real and publishable result: it means the
  remaining difference is theirs, and it narrows the reply we owe them. Do not keep inventing
  shapes until something breaks.

Whichever way it lands, extend the solo coverage to the warm-restart-with-stale-members case,
because we currently have none, and keep `scripts/lib/published-smoke-scenario.mjs` in step —
those two files are kept aligned only by comments pointing at each other.

## The design question this raises, if it does hang

Whether `resolveCohortSeed`'s control read gets a bound is a real decision, not an obvious fix,
and it should be made with the reproduction in hand rather than ahead of it. A timeout that
turns a stall into an error changes what `addStrand` promises callers; deferring the read
changes when cohort membership is known. Name both options and their consequences in the
implement ticket you emit, and pick one — do not leave the choice to the implementer.

## Edge cases & interactions

- **Revoked peers.** `queryCadrePeers` is paired with `queryRevokedStamps('CadrePeer')`. A prior
  cohort whose members were *revoked* before the device went solo is a different state from one
  whose members merely vanished. Cover both; they may not behave the same.
- **Open vs closed strands**, and a strand whose founder is the only remaining member.
- **Genesis ordering.** Test the embedder's order (peers read first, genesis second) as well as
  ours — the ordering difference is itself a hypothesis, and it is cheap to test both ways.
- **No user-reachable reset.** Once a device is in this state there is no documented way to clear
  the persisted member list short of reinstalling the app. If the state is reachable, the escape
  hatch is part of the answer, not a follow-up.
- **Restart durability.** The device does not merely start alone — it *restarts* alone, having
  previously been in a cohort. The high-water mark does not persist today (cadre-core passes no
  `persistence` to the node), so do not assume it participates; confirm rather than infer.

## What this ticket is not

Not a fix for the embedding app's own defects, which are theirs to fix and were reported to them
separately (polyfills installed after the module graph that needs them, a memoized start promise
that never clears on success, control errors swallowed by a bare `catch {}`). Do not model our
tests on their bugs — model them on the *state* their device is in.
