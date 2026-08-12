----
description: Prove with a real three-machine test that the new retry rescues a change to a party's shared settings when one machine briefly drops the connection, and that a genuinely dead machine does not take longer to report failure than before.
prereq: control-write-retry-real-error-classifier, transactor-key-network-ignores-network-scoping, control-db-cross-node-convergence-halted
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/integration-tests/src/harness/forced-cluster.ts, packages/cadre-core/src/control-write-retry.ts
difficulty: hard
----

# Real-network coverage for the control-write retry

Split from `control-write-retry-real-error-coverage`. The sibling
`control-write-retry-real-error-classifier` carries the no-network half (the commit-phase
pattern narrowing and the real-engine constraint-error coverage — its header has the full
settled analysis). This ticket carries everything that needs the real three-node scenario.

## Why this ticket is gated on two blocked tickets

The scenario this ticket extends —
`control-write-degraded-cohort-member.integration.ts` — **does not boot at current
HEADs**. Measured 2026-08-01 (agent run 1): 0 of 2 runs; both died in `beforeAll`,
before `forceFullCohort`/`pinCoordinator`, at 45 s `waitUntil` gates ("B/C self-publishes
its CadrePeer record"). Every poll for the full 45 s threw the same persistent
`QuereusError: Error during query on table 'CadrePeer': Query failed: Missing block (…)`
alongside the documented `resolvePeerAddrs: signature verification failed … sig=(empty)`
fingerprint. Environment was verified sound first: `../optimystic` clean at HEAD
`c24e2fe`, all sibling dists rebuilt and fresh (`../quereus` carries in-flight planner
edits whose dist was rebuilt after them — note that in any measurement you record).

Two blocked tickets carry the suspect fingerprints, and it is not established which one
owns this boot failure:

- `transactor-key-network-ignores-network-scoping` — the entry
  `tickets/.pre-existing-known.md` maps this scenario to. Its stated unblock condition
  (an optimystic coordinator-cache fix landing) APPEARS met, yet the suite still cannot
  boot — so either the mapping is stale or the condition was insufficient.
- `control-db-cross-node-convergence-halted` — a stable, never-healing `Missing block` on
  every read of the same block id for 45 s matches this ticket's class, which was
  confirmed against a clean optimystic HEAD.

Gated on both so the runner does not burn further runs on an unbootable suite. Whoever
picks this up after they clear: if boot still fails, follow the pre-existing-failure
procedure — do not chase the boot defect inside this ticket.

## Standing context

The retry under test lives in `packages/cadre-core/src/control-write-retry.ts`
(`isRetriableControlWriteFailure`, `retryControlWrite`), sitting under every control
write via `ControlDatabase.lockedWithRetry`: 3 attempts, 10 s elapsed budget, backoffs
~250 ms / ~1 s. It classifies by error message text, which is exactly why this ticket
demands the messages come from the real engine.

The scenario already boots a real three-`CadreNode` party over localhost websockets,
forces a full 3-peer cohort and pins the coordinator (`harness/forced-cluster.ts` →
`forceFullCohort`, `pinCoordinator`), and injects degradation by re-registering the
degraded node's control-network cluster protocol handler (`degradeClusterHandler`, in the
scenario file). Everything below extends that scenario; do not build a new one.

## Three things to establish

### 1. The classifier matches the real super-majority message

The never-answering-member cases already assert on the real error text (currently
`…integration.ts:545` and `:646`):

```
Failed to get super-majority: \d+\/3 approvals \(needed 3, 0 rejections\)
```

Add, alongside those assertions, an assertion that
`isRetriableControlWriteFailure(outcome.error)` is `true` for that same live error
object. A reworded Optimystic message then fails this scenario instead of silently
disabling the retry.

Also verify the real transactor aggregate against the NARROWED pattern the classifier
ticket lands: the real pend-phase `Some peers did not complete:` message must carry the
`[block:` token the narrowed pattern requires. If the transient-reset case (below)
surfaces that aggregate and the classifier calls it non-retriable, the narrowing broke
the retry — this scenario is where that shows.

The negative half (a real constraint error classifies as NOT retriable) lands in the
classifier ticket via a runnable single-node spec; it does not need this scenario.

### 2. A transient stream reset is absorbed

The case the plan ticket actually observed — `registerSelf()` racing a connection still
forming, failing with `Some peers did not complete: … cause=The stream has been reset`.

Add a sibling of `degradeClusterHandler` — e.g.
`resetFirstClusterStreams(node, partyId, count)` — that aborts the first `count` inbound
cluster streams and then delegates to the captured original handler, exposing the
intercepted count the same way `DegradedHandle` does. (Likelier home: the scenario file —
it is a handler wrapper, not a cohort forcer.) Then:

- With the reset count high enough to kill the first attempt's cluster fan-out but low
  enough that the second attempt gets through, an `authorizePeer` **commits**, and the
  read-back sees the new member.
- Anti-vacuity: assert the wrapper actually intercepted streams (the
  `interceptedStreams()` / `forced.callCount()` style the existing cases use), so a
  self-only cohort cannot pass this case.
- Assert the commit landed inside the retry budget — an elapsed bound of a few seconds,
  sized off the measured ~1 s healthy commit plus the two backoffs. Log the measured wall
  clock with the same `[measured]` prefix the existing cases use, and size the bound off
  what the runs actually show, not off numbers in this ticket.

Tune the reset count against a real run; the ~27 inbound cluster RPCs per write
(`docs/architecture.md`) is a measurement, not a contract.

### 3. A permanently silent member does not get slower

The retry budget (10 s) is sized to expire before a degraded-member timeout, so the
never-answering case must fail in the SAME ~20-40 s it fails in today, not 2-3x that.
The existing case records elapsed time with bounds (`FAILURE_FLOOR_MS` 15 s /
`FAILURE_CEILING_MS` 90 s); tighten or re-assert them so a regression that lets the retry
fire on this branch fails the scenario. This assertion protects the budget's whole
rationale — do not drop it if the existing bounds turn out loose; state the measured
numbers in the scenario's header comment the way the current header does.

## Edge cases & interactions

- **The retry changes the existing cases' timings.** Re-measure every case after the
  runs and update the header comment's measured table; a stale header is worse than none
  because the bounds are sized off it. Update `docs/architecture.md` → "Replication
  cluster size" if any number moved.
- **The standing `it.fails` case** (control reads blocked behind a stalled write, ticket
  `control-reads-blocked-by-stalled-write`, currently in blocked/) must stay an expected
  failure and must not become an expected PASS by accident — a retry holding the write in
  flight longer could change its shape. If it flips, that is a finding to report, not a
  line to edit.
- **`interceptedStreams()` counts grow** once a write can run twice. Convert exact-count
  anti-vacuity assertions to lower bounds rather than deleting them.
- **`restore()` must abort the reset wrapper's streams too**, or the party will not shut
  down cleanly between cases; follow `degradeClusterHandler`'s teardown shape exactly.
- **Run-to-run variance.** Peer ids are randomized per run, which drives FRET positions.
  Run each new case several times before trusting a bound.
- **Pre-existing flake.** `tickets/.pre-existing-known.md` tracks
  `control-read-over-fresh-edge-stream-resets` (fix/), an intermittent stream-reset
  failure in a different scenario. If it surfaces here, follow the pre-existing-failure
  procedure and note the slug in the handoff — do not chase, skip, or loosen.

## TODO

- Add `resetFirstClusterStreams` beside `degradeClusterHandler`.
- Add the transient-reset case; tune the reset count against real runs.
- Add the positive `isRetriableControlWriteFailure` assertions to the never-answering
  cases, and the narrowed-aggregate verification (section 1).
- Re-assert the never-answering cases' elapsed bounds so a retry firing there fails the
  scenario.
- Re-measure every case; update the scenario header's measured table and
  `docs/architecture.md` if numbers moved.
- Validate from `packages/integration-tests`, streaming output so the runner's idle
  timer never expires:
  `yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts 2>&1 | tee /tmp/degraded-cohort.log`
  At least three runs before trusting new bounds. If the full scenario's wall clock
  approaches ~10 minutes, run the new cases with `-t` filters instead and say so in the
  handoff.

## Arm added by `verify-ddl-retry-engages` review (2026-08-03)

Two things learned while trying — and failing — to capture the retriable failure from a
real joining node. Both change what section 1 needs to record, so read them before
writing the assertions.

**The success path has never been observed at ANY real call site.** Every case proving
the retry absorbs a failure drives a stub. A debug line on the loop's decline branch
(`control-write-retry.ts`) did prove the wrapper is live on the schema-init path in the
shipped binary — a real `cadre-cli` child logged `attempt 1/3, not retried here` for its
DDL failure — but that is the *decline* branch. Section 2 is the only thing that would
close this, which makes it the highest-value half of this ticket, not the second half.

**The super-majority shortfall can arrive from EITHER phase, and the message text is
identical.** `ClusterCoordinator.executeClusterTransaction` raises it
(`db-p2p/src/repo/cluster-coordinator.ts:374`), and `CoordinatorRepo` calls that from
`pend` (line 774), `cancel` (882) *and* `commit` (916). So the sentence itself carries no
phase information at all — only the transactor aggregate wrapping it does, via
`[block:` vs `[blocks:`. When section 1 records the real message, **record the whole
aggregate, not the shortfall sentence**: a transcription that keeps only the sentence
(which is what happened in `29.3-third-node-join-ddl-init`) throws away the one segment
that decides whether the retry engages.

Related detail worth knowing when you read a real aggregate: a per-batch detail can only
carry a `cause=` segment if that batch's RPC rejected, and a rejected batch always renders
`(in-flight)` — `Pending.isError` implies `isResponse` is false
(`db-core/src/utility/pending.ts`). `(no-response)` means the batch had no request at all
and never prints a cause. So `(no-response) cause=…` in any transcription is a
transcription error, not a real shape.

Twelve runs of `provider-seed-accepted.integration.ts` on 2026-08-02/03 produced zero
super-majority failures — every DDL death was `Missing block`
(`0-bug-control-collection-header-absent-at-committed-revision`). That scenario is not a
reliable source for this capture; this ticket's own scenario remains the plan.

## A THIRD retriable class now exists, on schema init only

Landed by `control-write-retry-covers-self-coordination-blocked` (2026-08-03). Schema init
(`ControlDatabase.loadSchema`) no longer runs the default policy: it runs
`SCHEMA_INIT_RETRY_POLICY`, which is the same classifier plus one extra message —

```
Self-coordination blocked: grace-period-not-elapsed. No coordinator available for key.
```

— optimystic refusing to let a node elect ITSELF coordinator while its last connection dropped
less than 30 s ago. That policy also runs 5 attempts over `[250, 500, 1000, 2000]` ms instead of
3 over `[250, 1000]`.

Two consequences for this ticket:

- Section 2's "the retry absorbs a real failure" capture has a second, likely-easier target. This
  class needs only ONE node that has seen peers and then lost them mid-DDL — no cohort
  choreography — whereas the super-majority shortfall needs a real three-machine party.
- Any assertion here that hard-codes `CONTROL_WRITE_ATTEMPTS` for a schema-init failure is now
  wrong; use `SCHEMA_INIT_ATTEMPTS` for that path.

The unit-level proof is in `packages/cadre-core/test/control-write-retry.spec.ts`
(`isRetriableSchemaInitFailure`), against the message text captured verbatim from a real node-B
startup death — so this one is NOT a reconstruction, unlike the two the classifier already had.

## Arm added 2026-08-11: this scenario's forced trio currently fails 0/3 on the healthy path

Measured while validating `transactor-key-network-ignores-network-scoping`, with both sibling
repos clean and rebuilt (`../optimystic` at `f02be8e`) and the whole sereus workspace rebuilt.
Three consecutive runs of `control-write-degraded-cohort-member.integration.ts`:

- run 1 — boot gate passed, then **2 tests failed** with
  `Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)`
  (`commits with a healthy three-member cohort (authorize AND remove)` and
  `commits with a member delayed under the response deadline`). Final tally
  `2 failed | 3 passed | 1 expected fail (6)`.
- run 2 — `beforeAll` tripped the trio boot gate, all 6 reported skipped. That is
  `fix/control-peer-row-refresh-invisible-to-third-node`, not this arm.
- run 3 — fully green, `5 passed | 1 expected fail (6)`.

`0/3 approvals, 0 rejections` means nobody voted at all — not that the degraded member refused.
It lands on the **healthy** case too, which is the scenario's control, so when it strikes, the
suite proves nothing about the retry either way. This ticket already owns `forced-cluster.ts` and
this scenario, so it is recorded here rather than filed separately; the cause has not been
established, and it is intermittent (1 of the 2 runs that got past `beforeAll`).

Note that `forced-cluster.ts`'s header was rewritten in the same pass: a node now has exactly ONE
`Libp2pKeyPeerNetwork`, so the two-instances-per-node rationale the header used to carry is gone.
The prototype patch itself survives — see the rewritten header for why (it is now a simplicity
argument, not a necessity one).
