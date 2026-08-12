---
description: Real three-machine coverage now proves the control-write retry rescues a write when a machine briefly drops the connection, and that a genuinely dead machine still fails no slower than before.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/control-write-retry.spec.ts, docs/architecture.md, docs/STATUS.md, tickets/.pre-existing-known.md
---

# Complete: real-network coverage for the control-write retry

Implemented 2026-08-12, reviewed the same day. The control-write retry
(`ControlDatabase.lockedWithRetry` → `control-write-retry.ts`) had never been observed
absorbing a real failure at a real call site; every prior proof drove a stub, and the two
messages that make a failure *retriable* only exist on a live multi-node cluster. That gap
is now closed by `control-write-degraded-cohort-member.integration.ts`.

## What shipped

**The classifier is asserted against LIVE errors.** Both never-answering cases (authorize
and DELETE) assert `isRetriableControlWriteFailure` is `true` on the real failure object,
and a shared guard asserts any live `Some peers did not complete:` aggregate carries the
`[block:` token the narrowed classifier requires. A reworded upstream message or a
reformatted per-batch detail now reddens the scenario instead of silently disabling the
retry.

**The retry's success path is observed at a real call site.** A new case re-registers the
coordinator's transactor repo-protocol handler so the first two inbound streams *from the
writing node* are aborted on arrival, then drives the write half of `registerSelf` and
asserts — via the retry funnel's own captured debug lines — that attempt 1 failed
transiently and a later attempt committed. Measured 5 times (3 implement, 3 review; one
review run skipped on the tracked boot gate): commits on attempt 2/3 in **587–687 ms**,
against the real aggregate `… [block:default/CadrePeer](in-flight) cause=Cannot write to a
stream that is closed`.

**A silent member is not slower.** The elapsed bounds stand (15 s floor / 90 s ceiling,
measured 20.3 s and 40.4–40.9 s), and the budget rationale is pinned directly: both
stalled cases assert their own write logged `failed after 1/3 attempt(s)` and never logged
a second attempt. Wall clock alone cannot detect a budget regression, which is why the log
is the assertion surface.

**Observability.** `ControlWriteRetryOptions.label` stamps an operation name into the
funnel's debug lines (`Control write [peer-insert] …`) — log-only, no behavioural change,
and unlabelled lines are byte-identical to before. Every `ControlDatabase` write call site
now supplies a label.

## Review findings

**Checked:** the whole implement diff read before the handoff summary; the retry funnel and
its call sites; every `execWrite`/`lockedWithRetry` site in `control-database.ts`; the
scenario's helpers for resource cleanup and cross-case leakage; test coverage against
happy path, error paths, anti-vacuity and interactions; `docs/architecture.md`,
`docs/STATUS.md`, `tickets/.pre-existing-known.md` and the unit spec's header prose against
the new reality. Validation: `yarn lint` 0, both packages' `typecheck` 0, full `cadre-core`
suite **1507 passed / 1 skipped** (the pre-existing win32 skip), `control-write-retry.spec.ts`
+ `control-formation-use-number-retry.spec.ts` **51/51**, and the scenario run **4 times**
(details under *Known-red arms*).

**Fixed in this pass (minor):**

- *The label convention was applied to 3 of 12 control-write call sites*, which undercuts
  its stated rationale (concurrent writes make an unlabelled line unattributable). Labelled
  the remaining ones — `device-token-update`, `device-token-insert`, `owner-key-insert`,
  `strand-insert`, `validation-key-insert`, `formation-invite-insert`, `strand-delete`,
  `validation-key-delete`, `device-token-delete`, `reap-<table>`, `revocation-reissue`,
  `formation-use-number` — and recorded the convention on `lockedWithRetry`/`execWrite`.
- *The new `label` option had no unit coverage*, leaving a pure-string surface guarded only
  by a three-node scenario that is intermittently red. Added a spec pinning both renderings
  (tagged, and byte-identical when unlabelled).
- *A capture leak in the new case*: the debug-sink capture was taken **before** the stream
  injection, so an injection that threw would leave debug's process-global sink hooked for
  the rest of the file. Injection now comes first (it issues no control write, so nothing
  is missed), matching every other case.
- *Weak anti-vacuity*: "the retry re-crossed the seam" was asserted with a stream count that
  also includes the third node's background dials. Now scoped to streams from the writing
  node (`fromPeerStreams`), which is the only count that can prove it.
- *Stale docs the implement pass should have swept*: `docs/STATUS.md`'s entry still said the
  scenario was "currently not running, all 6 cases skipped, blocked on
  `transactor-key-network-ignores-network-scoping`" — a ticket that has since completed and
  been re-attributed — and listed neither the new case nor the live-classifier assertions.
  The unit spec's header still said the scenario had not landed. Both corrected.
- *An overstated doc claim*: `architecture.md` said the retry "adds zero latency to the case
  it cannot help". True only for failures **slower** than the 10 s budget; a fast-failing
  shortfall is re-presented twice first, measured at ~11 s on a write that never commits.
  Corrected there, with the monotonic-starvation reading downgraded to one observation
  (see below).

**Filed (major):**

- `fix/control-write-hears-zero-approvals-from-healthy-trio` — a control write on a trio
  with **nothing degraded** is refused with `0/3 approvals, 0 rejections`; nobody votes
  either way, and all three retry attempts fail identically. Struck 3 of 5 runs in the
  implement pass and **3 of 3 completed runs** in this review. This class already existed
  as an arm on *this* ticket, which is now closing, so it needed its own owner; the ledger
  entry is re-pointed. The ticket carries both candidate mechanisms — the implement pass's
  abandoned-pend starvation and the concurrent-writers-on-one-block reading this review's
  capture supports — plus the experiments that separate them, and notes the root cause may
  be upstream in `../optimystic`.
- `backlog/bug-control-reads-not-retried-on-transient-failure` — control **reads** cross the
  network and have no retry funnel at all, so the transient class the write retry was built
  for still kills `registerSelf` through its read half (measured dying in 23–28 ms on the
  first injected reset). Filed as a class ticket (a read seam with its own policy), not a
  point fix, with the two design questions a plan pass must settle. Distinct from
  `blocked/control-reads-blocked-by-stalled-write`, which is about a read *waiting* behind a
  write.

**Tripwires (recorded at the code site, not filed):**

- `captureControlRetryLogs` hooks debug's **process-global** sink, so it assumes the cases
  run serially; marking any case `it.concurrent` would nest two captures and break the
  restore chain. `NOTE:` at the helper.

**Considered and not filed:**

- *The scenario re-implements `CadreNode.signSelfRecord`'s signing shape.* A real DRY smell,
  but a drift in the signed field set fails the case loudly (constraint refusal) rather than
  passing wrongly, and exporting the private signer to a test would be the worse trade.
- *The 988-line scenario file.* Measured against its siblings, two integration scenarios in
  the same directory are larger (1744 and 1350 lines); this is not an outlier and the file
  is one coherent subject.
- *The `expectAggregateCarriesBatchToken` guard is conditional* (silent when the live failure
  carries no transactor aggregate). Deliberate, and the unconditional
  `isRetriableControlWriteFailure` assertion beside it covers the shortfall path.

**Known-red arms (both pre-existing and tracked; neither re-filed):**

- The trio boot gate (`Timeout waiting for B resolves C's signed address record after
  45000ms`) skipped all 7 cases in 1 of 4 review runs →
  `fix/control-peer-row-refresh-invisible-to-third-node`.
- The `0/3 approvals` class reddened the healthy and delayed cases in all 3 runs that got
  past the gate → the new `fix/` ticket above. Every other case, including the new one,
  passed every run: `2 failed | 4 passed | 1 expected fail (7)`, ~90–110 s.
- A 5th run could not start: the sibling `../quereus` workspace was under active
  development during this session and its build went stale twice mid-review. One rebuild was
  run per the guard's own instruction; chasing it further was not worth colliding with
  another worker in that repo.

## How to re-validate

From `packages/integration-tests` (full file, not `-t` — isolated boots run the new case
during boot churn, where the `0/3` class contaminates it):

```
yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts 2>&1 | tee /tmp/degraded-cohort.log
```

Expected on a clean boot: `6 passed | 1 expected fail`, minus whichever tracked arm strikes.
The new case prints `[measured] injected reset …`, the real aggregate, and the funnel's
`committed on attempt 2/3` line. Unit side, from `packages/cadre-core`:
`npx vitest run test/control-write-retry.spec.ts test/control-formation-use-number-retry.spec.ts`
(51/51).
