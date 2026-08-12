----
description: Review the real three-machine coverage that now proves the control-write retry rescues a write when a machine briefly drops the connection, and that a genuinely dead machine fails no slower than before.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, docs/architecture.md, tickets/.pre-existing-known.md
----

# Review: real-network coverage for the control-write retry

Implement pass 2026-08-12. All three of the ticket's goals landed, one by a measured
deviation from the prescribed injection point (below). Build, lint, `cadre-core` full
suite (1506/1507, 1 pre-existing win32 skip), and both packages' typecheck are green.

## What landed

**1. The classifier is asserted against LIVE errors.** Both never-answering cases
(authorize and DELETE) now assert `isRetriableControlWriteFailure(outcome.error)` is
`true` on the real failure object, and a shared guard
(`expectAggregateCarriesBatchToken`) asserts that any live `Some peers did not
complete:` aggregate carries the `[block:` token the narrowed classifier requires. A
reworded upstream message or a reformatted per-batch detail now reddens the scenario
instead of silently disabling the retry.

**2. The retry's success path is observed at a real call site — first time ever.** New
case `absorbs an injected transient stream reset`. A wrapper
(`resetFirstProtocolStreams`) aborts the first N inbound streams of a named protocol,
optionally only from a named peer. The case resets the first 2 streams FROM B on the
coordinator's repo protocol (the transactor batch seam — the seam the observed wild
`registerSelf` failure died on), drives the write half of `registerSelf`
(`updateSelfPeerRecord` with a record the case signs itself using B's key), and asserts
via the funnel's own captured log that attempt 1 failed transiently and a later attempt
committed. Measured twice (full-file runs): commit on **attempt 2/3 in 670 / 687 ms**,
against the real aggregate `Error during query on table 'CadrePeer': Query failed: Some
peers did not complete: <peer>[block:default/CadrePeer](in-flight) cause=Cannot write to
a stream that is closed`.

**3. A silent member is not slower.** The existing elapsed bounds (15 s floor / 90 s
ceiling) stand, and the budget rationale is now pinned directly: the funnel's log lines
are captured per case and scoped by a new per-operation label, and both stalled cases
assert their own write logged `failed after 1/3 attempt(s)` and never logged a second
attempt. Wall clock alone cannot detect a budget regression (one-round-retried ≈
two-round-legitimate), which is why the log is the assertion surface.

**4. cadre-core observability change (log-only).** `ControlWriteRetryOptions.label` —
threaded from `mutateCadrePeer`'s existing `reason` strings, a new optional third
parameter on `execWrite`, and `loadSchema` (`schema-init`). Lines render `Control write
[peer-insert] failed …`; unlabeled lines are byte-identical to before. No behavioural
change; unit suite untouched and green.

**5. Instrumentation the next red run will want.** `captureControlRetryLogs()` hooks
debug's process-global sink for the `sereus:cadre:control-db` namespace;
`printRetryDecisions` prints the funnel's decisions under `[retry-log <case>]` in every
case including healthy/delayed — so the next time the intermittent `0/3 approvals`
failure strikes, the run itself records whether the funnel declined, retried, or
exhausted.

## Deviations from the ticket — both measured, not chosen

- **The prescribed injection point does not produce an absorbable failure.** The ticket
  asked for `resetFirstClusterStreams` on C's cluster protocol. Run 1 measured what that
  injection actually does: the promise RPC dies AFTER A and B pended, and the abandoned
  pend starves every subsequent attempt on the same hot block — approvals degraded
  **2/3 → 1/3 → 0/3** across the three attempts, and the write exhausted. The retry's
  shipped backoffs (250 ms / 1 s) are shorter than pend-cancel latency, so re-presenting
  into that state cannot succeed. The injection moved to the repo-protocol batch seam,
  which is where the observed wild failure actually died (nothing pends, so the re-present
  is clean). The wrapper header and the stalled case's NOTE carry the full record.
- **The driven write is B's self-record update, not `A.authorizePeer`.** Two measured
  reasons: A is the pinned coordinator and its own batches are handled locally — an
  A-scoped reset budget matches zero streams (run 4); and driving whole
  `B.registerSelf()` dies in ~25 ms on its funnel-UNPROTECTED pre-write read (runs 3, 5
  — see findings). The case therefore drives the write half directly, which is the same
  SQL, funnel, and label the wild call commits through.

## Findings for this review

1. **Control reads are outside the retry funnel, and they dial.** `registerSelf`'s
   pre-write read (`queryPeerRecord` → the `Revocation`/`CadrePeer` gets) crosses the
   network on every call — a prior successful read does not keep it local — and a
   transient stream failure there kills the whole call in ~25 ms with zero retries,
   before the write funnel is ever consulted. The wild `registerSelf` race the retry was
   built for can therefore still recur through its READ half. One code site:
   `CadreNode.publishSelfRecord`'s read phase / control read paths generally. Related but
   distinct: `blocked/control-reads-blocked-by-stalled-write` (that ticket is about reads
   BLOCKING behind a write, not read transients). Reviewer should weigh a ticket; nothing
   filed from implement.
2. **The `0/3 approvals` arm now has mechanism evidence** (ledger entry updated, stage
   re-pointed to review): struck 3 of 5 full boots today; the captured funnel log shows
   the monotonic approval starvation above, interleaved with ORGANIC
   `The stream has been reset` failures on B/C's `[self-record-update]` writes — i.e. the
   wild transient class occurs naturally during/after boot churn and its abandoned pends
   poison the hot block. Likely upstream (optimystic pend/cancel conflict handling); not
   established. The scenario self-documents when it strikes.
3. **The trio boot gate tripped 3 of 8 runs today** (`Timeout waiting for B resolves C's
   signed address record after 45000ms`) — already tracked by
   `fix/control-peer-row-refresh-invisible-to-third-node`; noted per the pre-existing
   procedure, not re-filed.
4. **The standing `it.fails` case stayed an expected failure in every run** — no change
   to its shape.

## Honest gaps

- The new case has **two** green full-file passes (runs 8, 10). Both committed on
  attempt 2; the assertions accept attempts 2–9 and either stream-reset error wording.
  Not exercised in `-t` isolation — isolated boots run the case during boot churn where
  the pre-existing starvation class contaminates it (run 4); validate full-file.
- The healthy and delayed cases still red intermittently on the pre-existing `0/3` arm
  (finding 2) — a red run on that fingerprint is the tracked class, not a regression of
  this work. The scenario header says so.
- The `label` option is asserted only through the integration scenario; no unit spec
  pins the label rendering (log-only surface).
- `TRANSIENT_RESET_COMMIT_CEILING_MS` is 15 s against a ~0.7 s measurement — sized to
  stay below the ~20 s response-deadline floor it must catch while giving a slow box
  ~20× headroom.

## How to validate

From `packages/integration-tests` (stream output; full file, not `-t`):

```
yarn vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts 2>&1 | tee /tmp/degraded-cohort.log
```

Expected on a clean boot: `6 passed | 1 expected fail`. Known interference: the tracked
boot-gate skip (all 7 skipped), and the tracked `0/3` fingerprint on the healthy/delayed
cases. The new case prints `[measured] injected reset …`, the real aggregate, and the
funnel's `committed on attempt 2/3` line.

Unit side: `npx vitest run test/control-write-retry.spec.ts
test/control-formation-use-number-retry.spec.ts` from `packages/cadre-core` (50/50).
