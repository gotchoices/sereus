description: The library fix for the write that could block every later write to the shared party records has landed. Confirm the degraded-cohort scenario now passes and loses no writes. Also teach the control-write retry which "torn" failures are safe to retry, now that the library says whether the write might still land.
files:
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
  - packages/cadre-core/src/control-write-retry.ts (`isUncommittedTransactorAggregate`, classifier matchers)
  - packages/cadre-core/src/control-retry.ts
  - tickets/.pre-existing-known.md (the `SyncRetryExhaustedError … Pend blocks held` entries owned by optimystic `a-member-that-missed-a-commit-refuses-every-later-write`)
  - docs/architecture.md (control-write retry section)
repro: verified
----

# Re-run the degraded cohort on optimystic 98fd2ab1, and classify TornActionError by `final`

## What landed upstream (optimystic-87, 2026-09-17)

- **Dead pend fixed** (implement `9cbc7427`, review `98fd2ab1`; dist rebuilt at `98fd2ab1`). A member promised a write, then missed its commit. It kept that write's pending record and voted `held` against every later write to the block. The block was the collection's log tail, so nothing could be written from any machine. That was the five-minute hold on `P6DsRqE3Mj2-escNG0gTvw` in run 1 of `complete/control-write-refused-when-a-rival-write-holds-the-block`. A pending record now stores the revision it claims, and a record whose revision the incoming write has already passed no longer blocks. Their three-machine reproducer went from failing after ~17 s to passing in ~1.2 s. Optimystic measured a genuinely slow live holder being absorbed in two retries, so the 10-retry budget is fine and `SyncRetryExhaustedError` here was a symptom.
- **`TornActionError.final`** (`bbecaf28`). `final: true` means the write did not land and will not, so re-presenting it is safe. `final: false` means it may yet land, so re-presenting could duplicate the row. The `Tree.replace` docs now say resubmitting is **not** safe after `SyncRetryExhaustedError`.
- **Staging leak fixed.** A failed write's actions stayed staged and rode along with the next write. That is how rows "reported torn" reappeared a repetition later in `complete/relay-round-trips-remeasure-optimystic-012573a2`.
- **Residual (inferred, not reproduced):** from four members up, the fix opens a narrow lost-update window. Three-member cohorts are not exposed. It is tracked on optimystic's backlog as `bug-a-pended-transform-does-not-carry-its-base`.

## To do

1. Check `../optimystic` HEAD is at or after `98fd2ab1` with dist built, and record it. Do not build there.
2. Run `control-write-degraded-cohort-member.integration.ts` 5 times in isolation. Pass means 7/7 each run, no `Pend blocks held` or `pending conflict` failures, and no abandoned-write report from the `afterEach` loss check added by `complete/an-abandoned-control-write-is-silent`.
3. If it is green, remove the `.pre-existing-known.md` entries owned by the upstream dead-pend ticket, with a closing delta.
4. Classifier: decide how `retryControlWrite` treats `TornActionError`. Re-present only when `final === true`. Never re-present on `final === false` or on `SyncRetryExhaustedError`, and check whether anything today would. Add unit tests for both. Record the rule where the existing `NOTE:` on `isUncommittedTransactorAggregate` lives.
5. Strand writes: check whether any sereus or reference-app code retries a strand insert automatically after a failure. If one does, apply the same `final` rule.
