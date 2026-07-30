----
description: When two machines write to the party's control database at the same instant, the loser used to die with a hard error and could leave a row half-written. The fix (make the loser quietly retry) is now fully coded and unit-tested; what remains is finishing the validation runs and writing the review handoff.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts, ../optimystic/packages/db-core/test/network-transactor.spec.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
difficulty: easy
----

# Finish validation + handoff for the stale-revision retryability fix

The defect: a concurrent-write conflict (two nodes pending the same block revision) surfaced as a
**thrown error** instead of the `StaleFailure` **return value** that `Collection.sync`'s bounded
retry loop keys on, so the loser never retried and the per-tree SQL commit sweep could split a
write across trees (`PartialCommitError`). Full analysis, verified chain, and design constraints
are in this ticket's prior revision — see git history of this file (commit `66cde66`). Do not
re-derive; everything below is current state.

## DONE — implementation (uncommitted, in `../optimystic` working tree)

All code changes are complete, built, and unit-tested. **Do not redo any of this.**

- `db-p2p/src/repo/cluster-coordinator.ts` — exported `ValidatorRejectionError extends Error`
  (typed, coordinator-local, never serialized; carries `rejectReasons: Record<string,string>` per
  peer). The `rejectionCount > maxAllowedRejections` branch in `executeTransaction` now throws it
  instead of a bare `Error`; the message string is byte-identical to before.
- `db-p2p/src/repo/coordinator-repo.ts` — `pend`'s catch now calls a new private
  `classifyStaleRejection(error, request, allBlockIds)` before rethrowing. It returns a
  reason-only `StaleFailure` **only** when the error is a `ValidatorRejectionError`, the request
  carried a `rev`, and a local `storageRepo.get` re-read confirms some affected block's
  `state.latest.rev >= request.rev`. Read errors and unconfirmed rejections rethrow (fail-fast
  preserved). A `NOTE:` tripwire at the site records the conservative choice: when only remote
  members saw the newer rev, the rejection still throws.
- Specs, all passing:
  - `db-p2p/test/coordinator-repo-stale-classification.spec.ts` — 4 cases: confirmed stale →
    returned `StaleFailure`, then retry at next rev succeeds; unconfirmed → throws typed error;
    no-rev request → throws without re-read; re-read failure → throws.
  - `db-core/test/network-transactor.spec.ts`, new describe "pend mixed stale + transport
    failure" — one batch responds stale while another throws a transport error → `pend`
    **returns** `success: false` (pins the stale-preemption branch,
    `network-transactor.ts:511-518`).
- Builds clean: `yarn workspace @optimystic/db-core build`, `yarn workspace @optimystic/db-p2p build`.
- Full suites green: db-core **1267 passing**, db-p2p **1436 passing / 41 pending**.
- Sereus consumers rebuilt: `@serfab/cadre-core`, `@serfab/cadre-host`.

## DONE — scenario evidence so far (14 of 20 runs)

From `packages/integration-tests`, scenario run **alone**:

```
yarn vitest run src/scenarios/push-wake-e2e.integration.ts -t 'learned by control-DB replication'
```

14 runs: **9 pass, 5 fail. Zero `PartialCommitError`, zero `Transaction rejected by validators`
in every run** — the ticket's success criterion holds so far. Failure shapes observed:

- 2× `Timeout waiting …` (30 s replication timeout) — the known Shape B, tracked by
  `bug-control-db-rx-record-never-converges-on-sender`. Expected to remain.
- 2× **new shape**: `SyncRetryExhaustedError: sync for collection default/CadrePeer exhausted 10
  retries` (`lastReason: undefined`), thrown from the FIRST tree in `commitDirtyTreesLegacy` —
  so nothing was durably committed; atomicity held. Meaning: the loser's retry loop now RUNS
  (the fix is working) but its re-read never observes the winner's committed revision within 10
  attempts, so it keeps recomputing the same rev and losing. Plausibly the same replication
  read-path non-convergence as Shape B wearing a new symptom. `lastReason` is undefined because
  the transactor's stale aggregation drops the `reason` string (known, pre-existing).
- 1× failure whose shape was **not inspected** (exit 1 with none of the above markers in its
  log); the log lived in the session scratchpad and is gone. Re-runs will re-encounter it if
  it is real.

## Remaining TODO

- [ ] 6 more scenario runs (to reach 20). Per run, grep the log for `PartialCommitError`,
      `rejected by validators`, `SyncRetryExhaustedError`, `Timeout waiting` and tally shapes.
      Success criterion: zero of the first two. Do NOT expect a green suite.
- [ ] Inspect any failure matching none of the known shapes (the 1 uninspected failure above).
- [ ] Full `packages/integration-tests` suite once; confirm no regression outside this scenario.
- [ ] Update `tickets/.pre-existing-known.md`: this slug's entry drops off; the
      `bug-control-db-rx-record-never-converges-on-sender` entry stays.
- [ ] Review handoff into `tickets/review/` (then delete this ticket). Must cover, honestly:
      - what changed and where (the two src files + two spec files in `files:` above);
      - the constraint set honored (no string-matching signed reject reasons; no protocol/wire
        change; `PartialCommitError` contract untouched; retry stays bounded; no serializing
        writes in cadre-core);
      - the new `SyncRetryExhaustedError` shape: state the evidence and pose the question for
        review — is it the Shape-B root cause resurfacing (fold into
        `bug-control-db-rx-record-never-converges-on-sender`) or a distinct defect needing its
        own ticket? Do not silently drop it.
      - the tripwire NOTE in `classifyStaleRejection` (remote-only-confirmation rethrow).
- [ ] Runner commits; do not commit from the ticket.
