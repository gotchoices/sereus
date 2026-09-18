description: The control-write retry now re-submits a failed write only when the database library says that write can never be stored, and never after a failure that says part of it may be stored. A fresh five-run check of the degraded three-machine scenario lost no control writes, so the upstream "dead pending record" failure is marked closed. Review fixed a browser-build break the change introduced.
files:
  - packages/cadre-core/src/control-write-retry.ts
  - packages/cadre-core/src/control-retry.ts
  - packages/cadre-core/src/control-read-retry.ts
  - packages/cadre-core/test/control-write-retry.spec.ts
  - packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts
  - eslint.config.mjs
  - docs/architecture.md
  - docs/testing.md
  - tickets/.pre-existing-known.md
----

# Complete: control-write retry classifies torn writes by `final`; degraded-cohort re-run

## What landed

Every local control-database write goes through `retryControlWrite`, which re-runs the whole write body only when its classifier says nothing can have been stored. The shared classifier body (`matchesRetriableFailure` in `control-write-retry.ts`, used by both `isRetriableControlWriteFailure` and `isRetriableSchemaInitFailure`) now checks error objects on the `cause` chain as well as message text, in this order:

1. not an `Error` → not retriable;
2. typed veto `reportsPossiblyStoredWrite`: `SyncRetryExhaustedError` (and `SyncRevisionStalledError`), a `TornActionError` whose `final` is not `true`, `CoordinatorPartialCommitError`, or an error named `PartialCommitError` → not retriable;
3. the existing text veto for a commit-phase `[blocks:` batch → not retriable;
4. typed matcher `isFinalTornWrite`: a `TornActionError` with `final === true` → retriable;
5. the existing text matchers.

`causeChain` moved into `control-retry.ts`, next to `chainMessages`. The veto matters because every vetoed class embeds text from elsewhere in its message, and when that text is a pend-phase aggregate the old text matcher claimed the whole error. Upstream semantics were checked against `db-core/src/collection/struct.ts` (`TornActionError.final`: true means "not saved and never will be; submitting again stores it once") and `db-core/src/transaction/errors.ts` (a partial commit "MUST NOT blindly retry the whole transaction").

Degraded-cohort confirmation: five isolated runs of `control-write-degraded-cohort-member.integration.ts` on optimystic `13586033` / `2fdb3b97`, 7/7 each, with no `pending conflict` / `Pend blocks held` lines. `.pre-existing-known.md` has a new "Delta 2026-09-17 (closing)" that marks the missed-commit wedge closed. The implement handoff's caveats still apply: run 4 started on an uncommitted build that matched `2fdb3b97`; the newest optimystic fix `8a0ad39b` was not exercised; the final-torn-write retry was never triggered live and is covered only by unit tests.

## Review findings

**Checked:** the implement diff (`c4cdfab5`) read in full; the upstream error classes and their documented contracts; the plugin's package `exports` and dist layout; whether cadre-core's main entry still loads in a browser; the docs that mention the classifier (`docs/architecture.md` is the only one); both retry specs; the full cadre-core suite (not run by the implement pass); `yarn lint`; cadre-core typecheck and build; `vite build` of `reference-app-web`.

**Major, fixed in this pass: the change broke the browser build.** `control-write-retry.ts` imported `PartialCommitError` from the ROOT entry of `@optimystic/quereus-plugin-optimystic`. That entry imports `fs`, `url` and `path` and calls `resolveQuereusVersion()` when the module loads. cadre-core's main graph deliberately keeps Node built-ins out ("so node:fs never lands in this graph" in `index.ts`) because the RN and web apps load it. Before the fix, running `vite build` in `packages/reference-app-web` failed with `"dirname" is not exported by "__vite-browser-external"`, imported by the plugin's `dist/index.js`. After the fix it built cleanly, with no externalized-module warnings. RN (Metro) was not built; it depends on the same import graph and should be fixed by the same change. Fix: the plugin's error is now matched by `name` (`LEGACY_PARTIAL_COMMIT_ERROR_NAME`), with a comment saying why. Unit tests still construct the real class, so an upstream rename makes the spec fail. The only other cadre-core use of the plugin is `/plugin`, which was already safe.

**Guard added (the invariant rung):** `eslint.config.mjs` now has a `no-restricted-imports` rule that stops `packages/cadre-core/src` from importing the plugin's root entry. I added a temporary import to check that it fires, and it did; `yarn lint` is clean now. `docs/testing.md` → "Lint coverage" documents the rule and names the `reference-app-web` `vite build` as the check over the whole import graph. That build was never part of the implement pass's validation, and that gap is how this break got through.

**Minor, fixed:** the test "lets the partial-commit veto beat a final torn write on the same chain" covered only `CoordinatorPartialCommitError`. It now also covers the plugin's `PartialCommitError`, which pins the name-based match against the final-torn-write claim.

**Tripwire (`NOTE:` added at `isFinalTornWrite`):** db-core's `CoordinatorStaleLossError` is documented as safe to re-drive but is not claimed by type. It escapes only after the coordinator's own retry budget runs out, so declining it is the safe choice. Claim it if control writes are seen abandoned on it.

**Agreed with the implementer's judgement calls:**
- C's in-window `[self-record-update]` loss (`Conflict race lost … 2/3 approvals`) is not the wedge. The wording is different, the rival write commits, and it happens only inside the deliberately degraded delayed-member case. It is recorded as a non-failing line. The ticket's literal "zero `SyncRetryExhausted`" bar was not met, and I accept closing the wedge anyway on that reasoning.
- A final torn write whose `detail` contains `[blocks:` is declined because the text veto runs first. That is conservative and acceptable.
- The instanceof asymmetry (with a second loaded copy of db-core, the veto misses and falls back to the text behavior that existed before the change) is documented at the site. Nothing further to do.

**Checked, nothing found:** `causeChain` hoist (identical code, both callers updated); type safety (no `any`, `final` compared strictly); resource cleanup (not applicable, the classifier is pure); the scenario comment and `.pre-existing-known.md` edits (consistent with each other and with the logs they cite); the `docs/architecture.md` sentence (accurate).

**Validation:** `control-write-retry.spec.ts` + `control-read-retry.spec.ts` passed 81/81. The full cadre-core suite had 1 failure and 2212 passes. The failure is `control-founding-consult-budget.spec.ts` "stays within its consult and commit budgets…": its anti-vacuity floor for the genesis phase tripped at 3 consults, below the floor. It reproduces when the spec runs alone. It is unrelated: that phase had no failed or retried writes, and a retry could only add consults. Its listed owner in `.pre-existing-known.md` is already complete, so it is reported in `tickets/.pre-existing-error.md` for triage. Log: `tickets/.logs/control-write-retry-torn-final-and-degraded-rerun.review-core.log`. `yarn lint` passed, cadre-core typecheck passed, the cadre-core dist was rebuilt after the last source edit, and `vite build` of `reference-app-web` passed.
