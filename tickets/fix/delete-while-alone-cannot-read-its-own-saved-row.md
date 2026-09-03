----
description: A machine that recorded a fact, was shut down, and started back up sometimes cannot see that fact in its own storage — the row it saved reads as absent. This used to be hidden behind an earlier failure in the same test, which has now cleared, exposing it.
prereq:
files: packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, tickets/.pre-existing-known.md
difficulty: medium
repro: verified
----

# A restarted node reads its own persisted row as absent

## What changed, and why this is a new ticket rather than an old one

`control-delete-while-alone-convergence` has been recorded since 2026-08-01 as failing this way:

> both die symmetrically at ~15 s in Phase 1 setup … with `SyncRetryExhaustedError … default/CadrePeer
> … at rev 3 (resp. 4), requested rev 1`, **before** the delete or any revocation-drain code runs —
> so the scenario currently proves nothing about the delete-while-alone feature either way.

**That is no longer what happens.** Measured 2026-09-03, five isolated rounds at
`@optimystic/db-p2p` 0.27.0: phases 1-3 now complete in about one second, no
`SyncRetryExhaustedError` anywhere, and the scenario reaches the assertion it was written for. It
now fails 2 rounds in 5 — and on a completely different thing.

## The failure

`packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts:154`,
the first line of `expectRemovalConverges`:

```
AssertionError: expected false to be true
  152| async function expectRemovalConverges(ctx: AloneRemoval, B: CadreNode)…
  153|  // B still holds the row it converged on before going down.
  154|  expect(await B.isMember(ctx.xPeerId)).toBe(true);
```

This is a **precondition**, not the thing under test. The sequence that precedes it, all of which
passed in the same run:

1. A and B are up and connected. A authorizes X. The test waits for B to converge X
   (`waitForCadrePeerConverged`, 30 s budget) and then asserts `B.isMember(X)` is **true**.
2. B stops. A restarts, removes X while genuinely alone, and both facts are asserted.
3. B starts again **on the same `MemoryRawStorage` instance** — the store object is carried in the
   context, so B's blocks are literally still there — and has no connections yet.
4. `B.isMember(X)` now reads **false**.

So B is a single node reading a row out of its own storage, moments after that same storage served
it, and getting "absent". Note the first test fails and the second (which restarts A one extra time
before B returns) passes — the ordering matters and is a clue, not noise.

## Leading hypothesis, and how to kill it

B is **alone** at step 4 — the reconnect is the next line of the helper. A block held by exactly one
node cannot meet optimystic's read-repair corroboration floor of two, and the recorded shape of that
is `cluster-fetch:no-quorum { responders: 1, required: 2 }` with no `peers-silent` line, answered as
absent rather than as an error. That is `blocked/block-held-by-only-one-machine-is-unreadable`, and
`push-wake-e2e` is already attributed to it.

**This is a hypothesis from timing and topology, not from evidence.** Nothing has been traced. The
first job of this ticket is a traced failing run, not a fix:

```
cd packages/integration-tests
DEBUG='optimystic:db-p2p:cluster-member,optimystic:db-p2p:block-storage,optimystic:db-p2p:coordinator-repo*,sereus:cadre:*' \
  yarn vitest run src/scenarios/control-delete-while-alone-convergence.integration.ts
```

It reproduces roughly 2 runs in 5 and each run takes seconds, so a short loop gets a failing trace
quickly. What the trace has to answer:

- Does B's read reach storage at all, and does storage hold the block?
- Is `cluster-fetch:no-quorum` present on that read? With what responder count?
- Does the answer come back as absent, or as unavailable-and-swallowed somewhere in this repo?
- Does the passing second test differ in *what B reads* or only in *when*?

If it is the corroboration floor, this is upstream and the ticket routes to `blocked/` behind
`block-held-by-only-one-machine-is-unreadable` with the evidence attached. If B's read never reaches
its own storage, or this repo swallows an unavailable answer into a false, that half is ours.

## What NOT to do

**Do not turn the precondition into a `waitUntil`.** It is tempting — the assertion is one line
before a reconnect that would probably make it pass — and it would bury the finding. A node that
cannot read its own committed, persisted data while alone is either a real defect or a
documented-and-accepted limitation; either way it gets written down, not waited out.

Do not relax `isMember`, and do not move the assertion after the reconnect.

## Edge cases & interactions

- **`control-write-while-alone-convergence`** is the sibling scenario in the same class and is
  recorded against `control-db-cross-node-convergence-halted`. Check whether its recorded fingerprint
  has moved too; if it has, say so in the handoff rather than assuming the old note still holds.
- **The pre-existing-failure record is now wrong for this file** and must be corrected as part of
  this ticket: `tickets/.pre-existing-known.md` still describes the Phase 1 `SyncRetryExhaustedError`
  as this scenario's failure mode.
- **`MemoryRawStorage` is not wrapped by the storage cache** (the cache deliberately declines
  in-memory stores), so nothing in `cached-storage.ts` is between B and its blocks here. Rule that in
  or out early rather than assuming it.
- **Intermittency is machine-state sensitive across this whole scenario family.** Rounds 1-2 failed
  and 3-5 passed in one series; the neighbouring `control-write-degraded-cohort-member` went from
  7/7 green to 5/5 red on byte-identical code within a day. Measure in series of five, and never
  conclude "fixed" from one green run.

## TODO

- [ ] Capture a traced failing run.
- [ ] Answer the four trace questions above.
- [ ] Route: upstream (`blocked/`, behind the one-holder read ticket) or a local fix, with evidence.
- [ ] Correct this scenario's entry in `tickets/.pre-existing-known.md` either way.
