description: Each shared workspace now records the highest version of the app's tables any member has applied, and refuses to open for an app older than that with an error telling it to update, so an older app can no longer remove a column a newer one added.
prereq: app-schema-version-declared-and-signed
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/offline-controllers.ts (new), packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/parse-config.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/package.json, packages/quereus-plugin-sereus/README.md, packages/quereus-plugin-sereus/test/e2e/app-schema-version.e2e.spec.ts (new), packages/quereus-plugin-sereus/test/helpers/strand-schema.ts (new), packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/strand-solo-write-budget.spec.ts, docs/strands.md, docs/schema-guide.md, docs/architecture.md, docs/testing.md, .release-notes.pending.md, packages/cadre-core/test/control-founding-consult-budget.spec.ts
----

# The strand's recorded app schema version gates opening it (gotchoices/sereus#59)

Second of three tickets. `app-schema-version-declared-and-signed` gave `SAppConfig` a signed `schemaVersion`; this one records the highest applied version in the strand and refuses a lower one. `app-schema-version-stops-a-running-member` (in `implement/`) handles a member already open when a higher version is recorded.

## What was built

- **`Strand.AppSchemaVersion`**: a singleton table (`Version integer not null check (Version >= 1)`, `Rises` on update, `NoDelete`), tagged `'network'` and `network_watch`, in `schemas/strand.qsql` and `STRAND_SCHEMA` (placed after `Header`).
- **The gate** (`gateAppSchemaVersion` in `app-schema.ts`), run by `applyAppSchema` and by every deferred retry, after the declare (so a schema refused by its text never writes a record) and before `apply schema App`:
  - live read of `Version`;
  - absent or lower: record (`insert` or `update`, one `{ transaction: true }` batch, waiting out another caller's open transaction), then apply;
  - equal: apply, unchanged behaviour;
  - higher: throw `AppSchemaOutdatedError` (subclass of `AppSchemaRefusedError`, with `appSchemaVersion` and `strandSchemaVersion`), nothing written.
- **Record conflicts** (`isRecordConflict`): a `CONSTRAINT`-coded `QuereusError` or Optimystic's `ConcurrentModificationError` anywhere on the cause chain re-runs the gate from the read; after 3 rounds it throws a plain `Error` wrapping the last one, so it is not typed as a refusal.
- **Deferral of the gate**: an internal `AppSchemaVersionDeferredError` carries a `Deferral`. Thrown when the read fails with `BlockUnavailableError` (any reason) or `BlockPossiblyStaleError` on its cause chain (cohort); when `offlineControllerOf(db).entries()` is non-empty at record time (queue, without trying); when the record's commit is `cohort-unreachable` (cohort, via `deferralOf`). `retryableRefusalOf` returns its deferral **without** the `diff schema App` pending-changes check, because the gate runs before any apply. Without that skip, a pre-existing strand whose schema is unchanged would fail its connect instead of deferring.
- **Retries re-gate**: `retryDeferredAppSchema` runs declare + gate + atomic apply as one attempt (`gateAndApplyAtomically`), re-run whole after any wait for an open transaction. A retry that finds a higher record settles `{ state: 'failed', error: AppSchemaOutdatedError }`.
- **`checkAppSchema(app)`** validates the number (safe integer ≥ 1, else `AppSchemaRefusedError`) with the text checks.
- **Threading**: `StrandConnectionOptions = StrandConnectionBaseOptions & StrandAppSchemaOptions`, where the latter is `{ schema: string; schemaVersion: number } | { schema?: undefined; schemaVersion?: undefined }`. `StrandDatabase.initialize` passes the pair only when it has an `sAppConfig`; `attachAppSchema` and `attachSApp` pass the `SAppConfig` itself (it is structurally a `VersionedAppSchema`). `AppSchemaOutdatedError` is exported from the plugin and re-exported by cadre-core.
- **Not in the ticket, forced by the paired type**: the SQL plugin setting `schema_version` (positive integer). It is required with `schema` and refused without it (`schemaPairProblems` in parse-config), and is listed in `package.json`'s `quereus.settings` and the README. Reviewer: check the name and that requiring it is right for Quoomb users.
- **`offlineControllerOf` moved** to `src/offline-controllers.ts` (re-exported unchanged) so `app-schema.ts` can read the queue without an import cycle with `compose-strand.ts`.
- **Founder `createEmptyCollections` question, settled by inspection**: `syncInventedCollections` only commits a collection whose `committedRevision()` is undefined and has unsynced changes. The record's commit leaves `AppSchemaVersion`'s collection committed, so the step skips it with no `except` entry. The budget numbers below agree: no extra empty commit appears.
- **Contract change**: `applyAppSchema` now throws a plain `Error` when `Strand.AppSchemaVersion` is not declared, meaning the database is not a composed strand. The schema-guide spec and the deferral spec now apply the `Strand` schema first, through the new `test/helpers/strand-schema.ts`.

## Tests

- **Added** `test/e2e/app-schema-version.e2e.spec.ts`: the reproduction from the ticket (v1 insert, v2 adds a column and sets it, a v1 connect is refused with `AppSchemaOutdatedError` 1/2 and `appSchemaRefusalOf` finds it, and a v2 connect still reads `('a', 'b')`). Verified to fail with the gate call commented out ("expected undefined to be an instance of AppSchemaOutdatedError"), then restored.
- **Added** `plugin.spec.ts` › "should refuse schema and schema_version given one without the other": the new parse-config rule.
- **Changed**: `strand-schema.e2e.spec.ts` lists `AppSchemaVersion` in `STRAND_TABLES` and expects its one row after a connect with a schema. Every plugin test call site that passes `schema` now adds `schemaVersion: 1`. In the deferral spec the versions are kept equal, so each test still exercises the path it was written for.
- **Re-baselined** `cadre-core/test/strand-solo-write-budget.spec.ts`: launch rose from 366 ops over 39 blocks to 393 over 42, in three identical runs. Insert (78/2) and select (0) are unchanged. The baseline moved to optimystic `087bfc11` / 2026-11-13, keeping the old slack (budget 407 / 45). The +27 is attributed by arithmetic: 3 new blocks × 9 operations per pend, the per-block cost of every other pend in that launch. HEAD was not re-measured at `087bfc11` without this change.

## Validation run

- `yarn workspace @serfab/quereus-plugin-sereus test`: 15 files, 167 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test`: 197 files, 2631 passed; the one failure was the budget above, fixed and re-run alone. The full suite was not re-run after that fix; only the budget spec and doc comments changed after it.
- `@serfab/reference-app-rn` (180 passed) and `@serfab/cadre-rn` (174 passed), against freshly built plugin and cadre-core `dist`.
- Integration scenarios: `strand-app-schema-change-while-partner-offline` (both arms pass; B claims v2 with A offline, so the gate defers and later records with A still down) and `strand-formation-e2e` (22 passed). The rest of `integration-tests` was not run.
- `yarn lint` exit 0; plugin and cadre-core typecheck; `check:vitest-typecheck-coverage`, `check:test-file-typecheck-coverage`, `check:stale-build-guard-wiring` pass.

## Known gaps, for the reviewer

- **Concurrent-record path untested** (by inspection only). Optimystic's `TransactionBridge.mapRefusal` maps a concurrent duplicate insert (`TreeKeyTakenError`) to `ConstraintError`/`CONSTRAINT`, and a lost update (`TreeEntryChangedError`) to `ConcurrentModificationError`/`BUSY`. Conflict replay works at the tree level and does not re-evaluate `Rises`, so a racing update surfaces as `ConcurrentModificationError`, not `CONSTRAINT`. The ticket expected `CONSTRAINT`; the gate recognises both.
- **Queue deferral of the record untested** (by inspection). It reads `offlineControllerOf(db)`, which is set only for compositions with `offline`; equal-version connects keep today's queue behaviour.
- **Which path deferred in the partner-offline scenario was not checked**: the version read, or the record. Both lead to `waiting-for-cohort`. `DEBUG=sereus:plugin:strand` would show which.
- **`applyAppSchema`'s record waits on `NEVER_RELEASED`**: on `attachAppSchema`, a transaction another caller holds open forever stalls the claim. The deferred retry already has the same property.
- **A record deferral thrown from `attachAppSchema`** (queue or cohort) reaches the claim as an untyped error: the claim fails and the retained config keeps the sApp, as for any non-refusal failure of the live apply.
- The edge cases the ticket marked "by inspection" remain by inspection: pre-existing strands' first record and the fork risk, members on Sereus ≤ 1.23.0 dropping the table, offline-mode reads served locally, a joiner's record reading first. All are documented in docs/strands.md → "Until then" and in the release notes.

## Review findings

Read the `ticket(implement): app-schema-version-gates-strand-open` diff first, then the handoff. Checked: the gate's ordering (declare → gate → apply) on the connect, attach and deferred-retry paths; record conflicts against `Rises` and the singleton key; deferral routing through `retryableRefusalOf`; error typing through `asAppSchemaRefusal`; the paired `schema`/`schemaVersion` type and the `schema_version` plugin setting; every caller of `connectToStrand` / `applyAppSchema` / `checkAppSchema`; the docs and release notes the change touches; budget specs that measure a strand founding.

**Fixed in this pass**

- **A transient fault reading or writing the version record could be typed as a permanent refusal** (`app-schema.ts`, repro static). The gate runs inside `applyAppSchema`'s `asAppSchemaRefusal` wrap, and the retry's `failed` outcome goes through it too. `isSchemaRefusal` types any chain of `ERROR`-coded `QuereusError`s as a refusal, and its own NOTE names one transient fault of exactly that shape (Optimystic's "Committed read refused: storage is in a partially-committed state"), excused only because "an apply makes no committed reads". The gate's `select` is a committed read, so such a fault would have become `AppSchemaRefusedError` and cadre-core would stop relaunching the strand until the next `addStrand`. Read and record faults now go behind a plain `Error` (`versionRecordFault`); `isRecordConflict` and `deferralOf` still walk the cause chain, so conflicts and deferrals are recognised as before. The NOTE on `isSchemaRefusal` says so. No test added: injecting an `ERROR`-coded fault into the read needs a storage double for a two-line wrapper whose behaviour is plain from the code.
- **`gateAndApplyAtomically`'s comment was wrong**: it said the gate's decision is never older than an open-transaction wait, but the record's own `execOutsideOpenTransaction` waits and re-sends the record alone over the version read before the wait. The behaviour is safe (a member that recorded meanwhile makes the key or `Rises` refuse it, and the gate reads again), so the comment now says that.
- **`control-founding-consult-budget.spec.ts` was not re-baselined**: `foundStrand`'s strand side measured 33 consults over 17 blocks with 15 commits against a recorded 29/15/14, and sat at its commit budget (15) and one under its consult budget (34). Re-measured three runs identical at optimystic `087bfc11`; every other figure equals its `fe7069f0` record. Figures, budgets (38/20/16, same slack as before), date and provenance updated; the per-table attribution of the three `AppSchemaVersion` consults is marked as inferred, not traced.
- **Undocumented limit for strands founded before this release**: step 6 of `composeStrand` (the `Strand` schema apply) is not deferred for the cohort, and on such a strand it adds `AppSchemaVersion` to the catalog, a write that needs the cohort, so a member alone fails its connect until a peer is reachable (the previous ticket's `Header.sAppSchemaVersion` column has the same effect). Added to docs/strands.md → "Until then" (the pre-existing-strands bullet) and the release notes; tripwire `NOTE:` at step 6 in `compose-strand.ts` naming the remedy (step 7's cohort deferral) if such strands must open alone. Not a ticket: the project carries no backwards compatibility yet.

**Tripwires recorded**

- `app-schema.ts` grew to 636 lines with the gate; `NOTE:` on `gateAppSchemaVersion` to move the gate to its own module if `app-schema-version-stops-a-running-member` adds more version logic.
- Step 6 cohort deferral, above (`compose-strand.ts`).

**Checked, nothing to change**

- `schema_version` plugin setting (the implementer asked): the name follows the other snake_case settings, and requiring it with `schema` matches `connectToStrand`'s paired type and cadre-core's required `SAppConfig.schemaVersion`; a Quoomb user who sets `schema` gets a named problem rather than an unversioned strand.
- Callers: every TypeScript caller typechecks; no `.mjs` fixture calls `connectToStrand` with a schema.
- Concurrent-record path and queue deferral of the record remain untested, as the handoff says; reading them confirms the handoff's analysis. A test would need two members racing a record, or a strand composed with `offline` and queued entries, at a cost out of proportion to two small branches.
- `retryableRefusalOf` skipping the `diff schema App` check for a deferred gate is correct: nothing was applied, so the diff check would only misclassify an unchanged schema.
- Tests: the e2e reproduction and the parse-config test meet the bar; the edited call sites only add `schemaVersion`. None cut.
- Docs: plugin README, cadre-core README and types, architecture.md, schema-guide.md, testing.md and strands.md match the code.

**Validation**: `yarn workspace @serfab/quereus-plugin-sereus test` 15 files, 167 passed, 1 todo; plugin rebuilt, then `yarn workspace @serfab/cadre-core test` 197 files, 2632 passed, 1 skipped; plugin and cadre-core typecheck; `yarn lint` exit 0. Integration scenarios were not re-run (the code change only re-wraps errors on a fault path they do not reach).
