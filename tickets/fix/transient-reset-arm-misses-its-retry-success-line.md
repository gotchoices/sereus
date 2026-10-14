description: `control-write-degraded-cohort-member`'s transient-reset arm failed once in a full `yarn check` (1 of 5 runs) although the write it drives committed: the retry log had the attempt-1 failure but not the "committed on attempt 2/3" line the arm asserts. Find out why the line was missing and fix the arm or the logging.
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (transient-reset arm ~1240-1310, `captureControlRetryLogs`), packages/cadre-core/src/control-retry.ts (~168, the success line)
----

## What was seen

Full `yarn check` on 2026-10-14 (optimystic 1.14.0, FRET main 12b509a). The arm failed at its last retry-log assertion:

```
AssertionError: the refresh never committed on a retry attempt — the retry engaged but did not rescue the write: expected false to be true
 ❯ src/scenarios/control-write-degraded-cohort-member.integration.ts:1306
```

Everything before it held: both injected resets were consumed, `outcome.error` was null (441 ms), and the read-back carried the refreshed `updatedAt`. The captured log had:

- `Control write [self-record-update] failed transiently (attempt 1/3), retrying in 198 ms: Error: Some peers did not complete … cause: StreamStateError: Cannot write to a stream that is closed`, from `NetworkTransactor.get` under `enforceUpsertGuard` (the read inside the write, not the pend).
- `Self peer record updated: … (updatedAt=…)`, 100 ms later.
- No `committed on attempt` line.

`control-retry.ts` logs the success line synchronously after a later attempt resolves, so its absence means either the write finished by some path other than attempt 2 of that loop, or the capture lost the line. In the passing runs (3 isolated, 1 whole file) the failure was a `QuereusError` wrapping the same cause, and the success line was present.

The gate log was in a session scratchpad and is gone; reproduce by running the whole file under load.

## Expected

The arm passes whenever the write commits on a retry, and fails only when it does not.
