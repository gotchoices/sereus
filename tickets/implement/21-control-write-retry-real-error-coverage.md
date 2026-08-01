----
description: Prove with a real three-machine test that the new retry actually rescues a change to a party's shared settings when one machine briefly drops the connection, and that it does not make a genuinely dead machine take twice as long to report failure.
prereq: control-write-transient-failure-retry
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/cadre-core/src/control-write-retry.ts
difficulty: hard
----

# Real-network coverage for the control-write retry

The retry that ticket `control-write-transient-failure-retry` adds is classified by error
**message text** produced by Optimystic, not by an error type. That is the same dependency
`isLostUseNumberRace` carries, and the codebase's answer to it is a test that produces the messages
from the **real** engine rather than from string literals
(`packages/cadre-core/test/control-formation-use-number-retry.spec.ts`, and the NOTE at
`packages/cadre-core/src/control-database.ts:172-176`). This ticket is that test for the control
path, plus the end-to-end proof that the retry rescues the failure the plan ticket observed.

It is split out from the retry itself because the scenario it extends runs for minutes per case
(one measured case is ~55 s of wall clock), and the unit-level work must not be gated behind it.

`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`
already boots a real three-`CadreNode` party over localhost websockets, forces a full 3-peer cohort
and pins the coordinator (`harness/forced-cluster.ts` → `forceFullCohort`, `pinCoordinator`), and
injects degradation by re-registering the degraded node's control-network cluster protocol handler
(`degradeClusterHandler`, same file). Everything below extends that scenario; do not build a new
one.

## Three things to establish

### 1. The classifier matches the real super-majority message

The scenario's never-answering-member case already asserts on the real error text at
`…integration.ts:545` and `:646`:

```
Failed to get super-majority: \d+\/3 approvals \(needed 3, 0 rejections\)
```

Add, alongside those assertions, an assertion that
`isRetriableControlWriteFailure(outcome.error)` is `true` for that same live error object. A
reworded Optimystic message then fails this scenario instead of silently disabling the retry.

Also assert the negative half against a real message: a write rejected by a constraint (any
existing owner-signature or authorization failure the harness can provoke cheaply) classifies as
**not** retriable. If provoking one inside this scenario is awkward, take it from a `cadre-core`
spec that already produces a real engine constraint error rather than inventing a literal.

### 2. A transient stream reset is absorbed

This is the case the plan ticket actually observed — `registerSelf()` racing a connection that was
still forming, failing with `Some peers did not complete: … cause=The stream has been reset`.

Add a sibling of `degradeClusterHandler` in the same file — e.g.
`resetFirstClusterStreams(node, partyId, count)` — that aborts the first `count` inbound cluster
streams and then delegates to the captured original handler, exposing the intercepted count the
same way `DegradedHandle` does. Then:

- With the reset count set high enough to kill the first attempt's cluster fan-out but low enough
  that the second attempt gets through, an `authorizePeer` **commits**, and the read-back sees the
  new member.
- Anti-vacuity: assert the wrapper actually intercepted streams (the same
  `interceptedStreams()` / `forced.callCount()` style the existing cases use), so a self-only
  cohort cannot pass this case.
- Assert the commit landed inside the retry budget — an elapsed bound of a few seconds, sized off
  the measured ~1 s healthy commit plus the two backoffs. Log the measured wall clock with the
  same `[measured]` prefix the existing cases use, and size the bound off what the runs actually
  show rather than off the numbers in this ticket.

Tune the reset count against a real run; the exact number of inbound cluster RPCs per write (~27,
per `docs/architecture.md`) is a measurement, not a contract.

### 3. A permanently silent member does not get slower

The retry is deliberately budgeted so it expires before a degraded-member timeout, so the
never-answering case must fail in the **same** ~20-40 s it fails in today, not 2-3x that. The
existing case already records elapsed time and has bounds; tighten or re-assert them so a
regression that lets the retry fire on this branch fails the scenario.

This is the assertion that protects the budget's whole rationale. Do not drop it if the existing
bounds turn out to be loose — state the measured numbers in the scenario's header comment the way
the current header already states them.

### 4. Is a commit-phase aggregate reachable, and is retrying it safe?

Added by the review of `control-write-transient-failure-retry`. Optimystic raises
`Some peers did not complete:` from **three** places in
`../optimystic/packages/db-core/src/transactor/network-transactor.ts`: the block `get` path
(~line 243), `pend` (~line 528) and `commitBlocks` (~line 718). The first two are safe to
re-present — a read failed, or phase 1 failed and nothing was committed. The third is not
obviously safe: `TransactorSource.transact` cancels the pend and rethrows, but peers that
already committed remain committed, so re-running the whole write body could issue its SQL
over a write that partly landed. The caller would then see a constraint failure (e.g.
`UNIQUE constraint failed: CadrePeer.PeerId`) for a write that actually succeeded, instead
of the transient error.

This is inferred from reading the transactor, not observed — it needs a commit-phase partial
failure to survive the transactor's own retry budget, which may not be reachable at all.
Establish which it is:

- Determine whether a commit-phase `Some peers did not complete:` can reach `ControlDatabase`
  at all (does `transact`'s cancel + the coordinator's own budget always convert it into
  something else first?).
- If it cannot, say so in `control-write-retry.ts`'s pattern comment and delete the NOTE that
  currently flags it as open.
- If it can, narrow the pattern (match only the pend/get shapes, or classify on the
  `cause` chain) so an already-committed write is never re-presented, and cover it.

The zero-rejection super-majority pattern does NOT carry this risk and needs no change: it is
raised while collecting promises, before any commit
(`db-p2p/src/repo/cluster-coordinator.ts:374`), and a decisive rejection is a different error
class (`ValidatorRejectionError`).

## Edge cases & interactions

- **The retry changes the existing cases' timings.** Re-measure every case in the scenario after
  the retry lands and update the header comment's measured table; a stale header is worse than no
  header here, because the bounds are sized off it.
- **The standing `it.fails` case** (control reads blocked behind a stalled write,
  `fix/control-reads-blocked-by-stalled-write`) must still be an expected failure and must not
  become an expected *pass* by accident — a retry that holds the write in flight longer could
  change its shape. If it flips, that is a finding to report, not a line to edit.
- **`interceptedStreams()` counts grow.** Existing anti-vacuity assertions that pin an exact count
  will break once a write can run twice. Convert them to lower bounds rather than deleting them.
- **`restore()` must abort the reset wrapper's streams too**, or the party will not shut down
  cleanly between cases; follow `degradeClusterHandler`'s teardown shape exactly.
- **Run-to-run variance.** Peer ids are randomized per run, which drives FRET positions. Run each
  new case several times before trusting a bound.
- **Pre-existing flake.** `tickets/.pre-existing-known.md` tracks
  `fix/control-read-over-fresh-edge-stream-resets`, an intermittent stream-reset failure in a
  *different* scenario. If it surfaces here, do not chase it inside this ticket and do not skip or
  loosen anything — follow the pre-existing-failure procedure and note the slug in the handoff.

## TODO

- Add `resetFirstClusterStreams` beside `degradeClusterHandler` in the scenario file (or in
  `harness/forced-cluster.ts` if it reads better there — it is a handler wrapper, not a cohort
  forcer, so the scenario file is the likelier home).
- Add the transient-reset case; tune the reset count against real runs.
- Add `isRetriableControlWriteFailure` assertions to the existing never-answering case, positive
  and negative.
- Settle the commit-phase question (section 4) and either delete or act on the NOTE in
  `control-write-retry.ts`.
- Re-assert the never-answering case's elapsed bounds so a retry firing there fails the scenario.
- Re-measure every case and update the scenario header's measured table and
  `docs/architecture.md` → "Replication cluster size" if any number moved.
- Validate from `packages/integration-tests`, streaming output so the runner's idle timer never
  expires:
  `yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts 2>&1 | tee /tmp/degraded-cohort.log`
  Run it at least three times before trusting the new bounds. If the full scenario's wall clock
  approaches ~10 minutes, run the new cases with `-t` filters instead and say so in the handoff.
