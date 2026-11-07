description: When an app's new schema can never apply to the tables a strand already holds (for example a required column added to a table that has rows), the node used to retry starting that strand forever, each try a full start-up (gotchoices/sereus#57). Such a refusal now carries its own error type and stops the automatic retries until the app registers the strand again.
architecture: docs/strands.md#a-schema-that-can-never-apply-here-is-not-retried
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts, packages/cadre-core/README.md, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----
# A refused app schema stops the strand's relaunch until the next claim

## What shipped

**Plugin (`packages/quereus-plugin-sereus/src/app-schema.ts`).** `AppSchemaRefusedError` and `appSchemaRefusalOf(err)` (walks `cause`), exported from the plugin and re-exported from cadre-core. `applyAppSchema` rethrows a refusal as `AppSchemaRefusedError` when every link of the error's `cause` chain is a `QuereusError` with a code in `SCHEMA_REFUSAL_CODES` (`ERROR`, `CONSTRAINT`, `MISMATCH`, `UNSUPPORTED`, `SYNTAX`, `SCHEMA`, `RANGE`). Any plain `Error` in the chain (Optimystic's `PromiseShortfallError`, `BlockUnavailableError`) or a `BUSY`/`MISUSE` code leaves it untyped. The seed-item and ignored-item refusals throw the typed error directly. A deferred retry that ends in a refusal settles `{ state: 'failed' }` with the typed error. The deferral path is unchanged: `deferralOf` walks into the wrapped chain.

**cadre-core (`packages/cadre-core/src/cadre-node.ts`).** `suppressIfAppSchemaRefused` suppresses the strand in the `StrandWatcher` instead of leaving it on the retry ladder, from both `handleStrandAdded`'s catch and `addStrand`'s catch. The next `addStrand` lifts it (it already calls `unsuppressStrand`).

**Docs.** `docs/strands.md` sub-section "A schema that can never apply here is not retried"; `docs/architecture.md`, both package READMEs and `.release-notes.pending.md` updated.

## Review findings

Read the diff of `ticket(implement): app-schema-refusal-stops-strand-relaunch` first, then the handoff.

**Correctness of the refusal test (checked, no change).** Read every Quereus and Optimystic error a schema apply can surface, in the sibling sources. `QueuedEntriesBlockSchemaChangeError`, `TransactionActiveError`, `OfflineCommitTimeoutError` and `ConcurrentModificationError` all carry `BUSY`, so none is typed as a refusal. `PromiseShortfallError`, `BlockUnavailableError` and `QueueDisposedError` are plain `Error`s, so a chain holding one stays untyped. Optimystic's catalog-record refusal (`classifyColumnChange`: "another machine's upgrade disagrees … Retrying will not help") is `ERROR` and is correctly typed. The one known transient `ERROR` without a cause (the committed-read refusal while storage is partially committed) is covered by the implementer's `NOTE:` on `isSchemaRefusal`. Optimystic's `ERROR` "could not find the pre-write row … engine and collection disagree" (row update path in `optimystic-module.ts`) also has no cause; an apply does not reach it today (Optimystic's add column is catalog-only), and the same `NOTE:` says what to do if a transient fault is ever seen typed, so no new tripwire.

**Fixed: a claim made during a refused launch could be left suppressed without ever being tried (minor, fixed inline).** If an app called `addStrand` with schema B while a launch with schema A was in flight (the watcher's, or an earlier `addStrand`'s), B's call only waited on A's launch and failed with the plain "the launch this one waited on failed" error. A's catch then suppressed the strand after B had lifted the suppression, so B's schema was never launched until yet another claim. `suppressIfAppSchemaRefused` now takes the config the launch used and suppresses only when it is still the registered one; otherwise the strand stays on the retry ladder, which then launches B. Pinned by the new test "leaves a refused strand on the retry ladder when a claim registered another schema during the launch".

**Fixed: a storage replica whose in-place claim was refused ran untracked by the watcher (minor, fixed inline).** The implementer flagged this. `addStrand` → `claimTrackedStrand` → `attachSApp` refused leaves the replica running, and the catch's `forgetStrand` dropped it from the watcher's known set. With the strand now suppressed, the watcher never re-recorded it, so a party-wide removal of the strand would never detach the replica. `addStrand`'s catch now skips `forgetStrand` when it suppressed a refusal and `strandManager.getInstance` still returns an instance, so the watcher's removed-strand loop still sees it (and that loop clears the suppression on removal). Pinned by "keeps a storage replica whose in-place claim was refused known to the watcher". `docs/strands.md` ("Nothing runs for the strand on this node meanwhile") and the `addStrand` JSDoc now state both exceptions.

**Not fixed, already tracked.** The replica's retained launch config keeps the refused schema after the failed attach, so a later hibernation resume fails: `backlog/bug-refused-app-schema-kept-for-strand-resume` (its prereq is this ticket; it already notes `appSchemaRefusalOf`).

**Known limitation, kept as documented.** When the app's claim and the watcher's launch overlap, only the call that started the launch carries the typed error; the other gets a plain error. The relaunch loop still stops, because the starting call suppresses. Documented in `docs/strands.md`. Carrying the build's rejection to the waiting call would need `StrandInstanceManager.whenRuntimeBuilt` to keep it, which a one-time difference in which channel carries the type does not justify.

**Tests.** Kept all of the implementer's tests: the plugin repro runs a real Quereus apply against rows (pins the issue's example), the extended dropped-column test pins the untyped-fault side, and the cadre-core tests pin the suppress/forget/unsuppress calls at both catch sites. Added the two tests above, one per defect fixed. No test for the declare-time typed throws (a constructor swap with no branching; `plugin.spec.ts` still matches their messages).

**Error handling, types, cleanup, hygiene.** No `any`; `isSchemaRefusal` is a type guard; nothing swallowed (every suppression logs its reason). No new resources to release. `cadre-node.ts` remains very large; its size is already tracked by `backlog/debt-cadre-node-single-file-size`, nothing new to file. Comments state reasons, not narration.

**Docs.** Read `docs/strands.md`, `docs/architecture.md`, both READMEs, the `strand:error` doc comment in `types.ts`, the `StrandWatcher` JSDoc and the release note; all match the code after the `strands.md` edit above.

**Tripwires added:** none. The one conditional concern found is covered by the existing `NOTE:` on `isSchemaRefusal`.

## Validation (review pass)

- `yarn workspace @serfab/cadre-core test`: 197 files, 2625 passed, 1 skipped.
- `yarn workspace @serfab/quereus-plugin-sereus test`: 14 files, 165 passed, 1 todo.
- `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn lint`: clean.
- Rebuilt `@serfab/cadre-core` so other workspaces' stale-build guards see current `dist`.
- Not run: the full root `yarn typecheck` and the integration tests.
