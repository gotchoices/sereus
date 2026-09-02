description: Reads from the shared party database now get the same bounded second chance writes already had when the network blips — with a shorter deadline and a narrower idea of which failures are worth repeating. Review the classifier's include/exclude calls, the locked-body opt-outs, and the two integration scenarios the implement pass could not finish re-running.
files: packages/cadre-core/src/control-retry.ts, packages/cadre-core/src/control-read-retry.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-read-retry.spec.ts
----

# Review: transient-failure retry for control-database reads

Implements `implement/2-control-read-transient-failure-retry` (read that ticket's body for
the full design rationale — it is archived with the fix ticket lineage; the design was
followed except where noted below).

## What landed

- **`control-retry.ts` (new)** — the retry loop extracted from `retryControlWrite`,
  parameterised by policy (attempts, delays, budget, classifier, log prefix). The write
  prefix defaults keep every existing `Control write …` log line byte-identical (the
  degraded-cohort scenario asserts on them; the pre-existing
  `control-write-retry.spec.ts` label cases also pin the rendering and still pass
  unchanged). Also hosts the shared `chainMessages` cause-chain walker.
- **`control-read-retry.ts` (new)** — the read policy: `CONTROL_READ_ATTEMPTS = 3`,
  `CONTROL_READ_RETRY_DELAYS_MS = [100, 400]`, `CONTROL_READ_RETRY_BUDGET_MS = 1_500`,
  `isRetriableControlReadFailure`, `retryControlRead`. Retriable: the transactor's
  read-phase aggregate (`isUncommittedTransactorAggregate`, now exported from
  `control-write-retry.ts` and reused verbatim) plus `Block … is unavailable
  (peers-unreachable|cohort-unreachable)`. Excluded with cited measurements:
  `claimed-elsewhere` (60 s of identical errors), `unmaterializable`, possibly-stale,
  everything unmatched. No commit-phase veto — a read commits nothing, and the `[blocks:`
  token is unreachable from a read anyway (documented at the classifier).
- **`control-database.ts`** — `readEval` replaced by `readRows` (retried, labelled,
  collecting) and `readRowsOnce` (unretried; carries the old committed-read doc comment,
  still the one place that opt-in is spelled, and the `getAutocommit()` check re-runs
  inside every attempt because each attempt is a fresh `readRowsOnce` call). All 15 read
  call sites converted, each with a label. New `controlReadRetryPacing` seam mirrors the
  write one. Locked-body opt-outs are per-call `retry: false` arguments:
  `deleteGuardedRow`'s stamp read, `insertCadrePeer`'s insert-if-absent guard, and both
  reads under `assertSeatRemains` (`queryFormationInvite` / `countFormationUsage`, which
  grew a public optional `retry = true` parameter — external callers all pass one arg, so
  nothing breaks). NOTEs at `queryStampId` and `assertSeatRemains` state the
  no-lock-during-backoff contract.
- **`index.ts`** — read constants, classifier, and `retryControlRead` exported alongside
  the write ones.
- **`test/control-read-retry.spec.ts` (new, 17 cases)** — classifier table over the exact
  upstream texts (bare AND `Error during query on table …: Query failed: …` wrapped);
  loop cases for attempt count, budget cut-off (checked before sleeping), jitter bounds,
  label rendering, last-error identity; the budget relationship
  `CONTROL_READ_RETRY_BUDGET_MS < ADMISSION_DECISION_TIMEOUT_MS` asserted as a test plus
  a worst-case-sleep-fits-budget bound; and a `ControlDatabase`-level block on a real
  `CadreNode` that inverts the ticket's repro — a read failing once mid-iteration now
  resolves with exactly 2 `eval` calls, a `claimed-elsewhere` failure surfaces after
  exactly 1, and a read inside `insertCadrePeer`'s locked body rigged to always fail
  produces exactly `CONTROL_WRITE_ATTEMPTS` eval calls with the read pacing seam never
  consulted (a read-side retry would have multiplied the count).

## Deviations from the implement ticket — check these first

1. **`reauthorizeCadrePeer` and `reapRevokedRow` stamp reads stay RETRIED.** The ticket's
   locked-callers table listed both, but in the code both reads run BEFORE their lock is
   taken (`reauthorizeCadrePeer` reads at the top of the method, then enters
   `mutateCadrePeer`; `reapRevokedRow` reads before `mutateCadrePeer`/`execWrite`). The
   ticket's stated principle — per-call, with locked call sites opting out by name —
   therefore puts them on the retried side, and retrying them is a win: the write funnel
   never re-runs pre-lock reads, so today a blip there kills the whole operation.
2. **The read classifier does not match the bare super-majority shortfall.** The ticket's
   retriable list did not include it; a read presents no transaction, and if the sentence
   ever reaches a read it arrives inside the transactor aggregate, which is already
   claimed. A negative spec case documents the choice.
3. **`queryFormationInvite` / `countFormationUsage` opt-outs are a public optional
   parameter**, not private twins — the ticket allowed either; the parameter keeps one
   body per query and is greppable (`, false)` at exactly the locked sites).

## Validation

- `yarn workspace @serfab/cadre-core test`: **1682 passed, 1 skipped** (105 files) —
  includes the pre-existing write-retry, write-lock, and storage-op-budget suites
  unchanged.
- `yarn lint`, `yarn typecheck`, `yarn build` (root, whole repo): all green.

## Integration scenarios — the honest gaps

- **`control-write-degraded-cohort-member.integration.ts` re-run once: 4 passed / 3
  failed.** Not attributed to this change, and not re-reported per the pre-existing-known
  rules: all three failures carry one fingerprint on ONE block (`mFR84…`) — `pending
  conflict: block … held by unresolved action(s) …` validator rejections cascading from
  the (passing) stalls-past-deadline case — which is the documented orphaned-pend
  mechanism owned by `blocked/control-write-hears-zero-approvals-from-healthy-trio`
  (listed for this exact file in `tickets/.pre-existing-known.md`; the ledger records this
  scenario failing 3 cases in prior runs). The captured retry log
  (`tickets/.logs/2-control-read-retry.degraded-cohort.log`) shows the funnel behaving
  correctly throughout: transient classification, per-attempt log lines in the exact
  pre-change format, rejections surfaced unretried. The third failure ("absorbs an
  injected transient stream reset") lost attempts 1–2 to that orphaned pend and attempt 3
  to the second injected reset — a budget-of-bad-luck composition, not a classifier or
  loop defect.
- **NOT done (budget cut-off):** a second degraded-cohort run to confirm the composition
  is the known intermittent, and the `relay-only-control-addr.integration.ts` re-run the
  ticket asked for. Both are single foreground commands
  (`yarn workspace @serfab/integration-tests test <name>`; ~3 min each). The ticket's
  follow-on question — whether `registerSelf` now survives the read half of the failure,
  letting the degraded-cohort note about driving `updateSelfPeerRecord` directly be
  revisited — is therefore also unanswered.

## What a reviewer should probe

- The classifier's regex (`/Block \S+ is unavailable \((?:peers-unreachable|cohort-unreachable)\)/`)
  against upstream's exact template — the spec transcribes it, but the transcription is
  the thing to double-check against `../optimystic/packages/db-core/src/network/struct.ts`.
- Whether any of the 15 labels collide confusingly in a real log (`stamp-<Table>` is
  dynamic; the rest are literals).
- The two-budget stacking on membership reads (`queryCadrePeers` = revoked-stamps read +
  row scan, each with its own 1.5 s budget) against the 2 s admission deadline — the
  prose argument is in `control-read-retry.ts`; the spec pins only the single-budget
  relationship.
- That no other read path reachable from inside a locked body was missed — the sweep was
  by reading every `readRows` caller against the lock structure; a fresh pair of eyes on
  `redeemInvitation` / `recordFormationUsage` / `deleteGuardedRow` call graphs is cheap
  insurance.
