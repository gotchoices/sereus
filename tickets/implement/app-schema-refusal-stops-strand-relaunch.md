description: When an app's new schema can never apply to the tables a strand already holds (for example a required column added to a table that has rows), the node retries starting that strand forever, each try a full start-up; on a phone that cost a third of the CPU for minutes (gotchoices/sereus#57). Make such a refusal stop the automatic retries until the app registers a different schema.
architecture: docs/strands.md#an-app-schema-upgrade-waits-for-the-queue-or-the-cohort
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/quereus-plugin-sereus/test/plugin.spec.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts, docs/strands.md, .release-notes.pending.md
----
# A refused app schema stops the strand's relaunch until the schema changes

Reported in gotchoices/sereus#57 (Node repro script in the issue body; the one comment narrows it). Measured on 1.20.0: a laptop spends about 50 ms of CPU per attempt, a Galaxy S7 behind a relay 9 to 11 s at 60 to 100% CPU.

## The loop today

- `applyAppSchemaOrDefer` (`packages/quereus-plugin-sereus/src/app-schema.ts`) defers two failures (queued offline transactions, an unreachable cohort) and rethrows every other one.
- `composeStrand` throws, so `StrandInstanceManager.startStrand` drops the instance and rethrows.
- `CadreNode.addStrand` (also reached by `foundStrand` through `attachFoundingRow`) catches, calls `StrandWatcher.forgetStrand`, and rethrows. `CadreNode.handleStrandAdded` (the watcher's callback) emits `strand:error` and rethrows, and the watcher's own catch calls `forgetStrand`.
- `forgetStrand` records a failure on the 5 s doubling ladder capped at 5 minutes (`MAX_RETRY_BACKOFF_MS`, "attempts are never abandoned"), so the watcher relaunches the strand, building a new libp2p node and composing the database before failing at the same DDL, for the life of the process.

The issue's repro: schema v1 `table T (Id integer primary key)`, a row written, then v2 adds `At text not null` with no default. Quereus refuses `alter table App.T add column At text not null` because existing rows cannot be backfilled, on every attempt.

## Design

### 1. The plugin types a refusal: `AppSchemaRefusedError`

A new exported class in `app-schema.ts`, `AppSchemaRefusedError extends Error` (`name = 'AppSchemaRefusedError'`), carrying the original error as `cause` and a message that starts with the reason and includes the cause's message (the web reference app shows `error.message` as is). One name covers both kinds of refusal; the issue's suggested `AppSchemaApplyRefusedError` is not used, because the declare-time refusals below are not apply failures.

Thrown in these cases:

- **The plugin's own declare-time refusals.** `assertNoIgnoredItems` and `assertNoSeedItems` throw it directly instead of a plain `Error`.
- **A refusal Quereus decides from the schema and this node's catalog and rows.** `applyAppSchema` catches the error from `declareAppSchema` / `apply schema App` and rethrows it wrapped when `isSchemaRefusal(err)` (below) holds, else rethrows it unchanged.
- **A deferred retry that ends in such a refusal.** `retryDeferredAppSchema`'s `{ state: 'failed', error }` carries the wrapped error under the same test, so the `strand:error` cadre-core emits for it is typed too. This path relaunches nothing (the strand is already up on its earlier schema); it is only for consistency of what the app sees.

`isSchemaRefusal(err)`: true when every link of `err`'s `cause` chain is a `QuereusError` (from `@quereus/quereus`, which `ConstraintError` and `ParseError` extend) whose `code` is one of `StatusCode.ERROR`, `CONSTRAINT`, `MISMATCH`, `UNSUPPORTED`, `SYNTAX`, `SCHEMA`, `RANGE`. Any other link makes it false. Why this test, read from Quereus 5.0.0 and Optimystic 1.26 (`../quereus`, `../optimystic`):

- A failed migration step is `QuereusError(ERROR, "Failed to execute DDL: …")` with the step's own error as `cause` (`executeMigrationStep` in `quereus/src/runtime/emit/schema-declarative.ts`); the repro's inner error is `QuereusError(CONSTRAINT, "NOT NULL constraint failed …")` (`validateNotNullBackfill` in `alter-table.ts`). Key and type change refusals are `ERROR`, `CONSTRAINT` or `UNSUPPORTED` `QuereusError`s from `alter-table.ts` and from Optimystic's `alterTable` / `catalog-only-change.ts`.
- Storage and network faults are not in that set. Optimystic's `PromiseShortfallError` and `BlockUnavailableError` are plain `Error`s; `QueuedEntriesBlockSchemaChangeError`, `ConcurrentModificationError` and Quereus's `TransactionActiveError` carry `BUSY`; a closed database is `MisuseError` (`MISUSE`). A plain `Error`, a non-`Error`, or a fault code anywhere in the chain keeps the error untyped, so it keeps today's retry ladder. This is the point the issue's comment makes: treating every non-deferred error as permanent could stop a strand that would have recovered.
- Matching message text was rejected. An allowlist of codes was chosen over a denylist of fault codes so a code Quereus adds later stays on the ladder.

`StatusCode.ERROR` is broad, and one known `ERROR` with no `cause` is transient: Optimystic's "Committed read refused: storage is in a partially-committed state" (`optimystic-module.ts`). The apply does not make committed reads (Quereus refuses them while a schema migrates), so it cannot reach this test. Leave a `NOTE:` at `isSchemaRefusal` naming it, with the revisit condition: if a transient fault is ever seen typed as a refusal, have Optimystic give it a fault code or a `cause`.

Export from `packages/quereus-plugin-sereus/src/index.ts`: `AppSchemaRefusedError` and `appSchemaRefusalOf(err): AppSchemaRefusedError | undefined`, which walks `err`'s `cause` chain for one. cadre-core uses the walker rather than `instanceof` at its catch sites, so a later wrapper between `composeStrand` and `CadreNode` cannot hide the refusal. Re-export both from `packages/cadre-core/src/index.ts` so an app can recognise the error on `strand:error` without importing the plugin.

### 2. cadre-core stops the automatic relaunch: watcher suppression

The stop is `StrandWatcher.suppressStrand`, the mechanism `InvalidStrandIdError` already uses in `handleStrandAdded`:

- **`handleStrandAdded`'s catch:** when `appSchemaRefusalOf(error)` finds a refusal, call `this.strandWatcher?.suppressStrand(strand.Id)` after the `strand:error` emit and before the rethrow. The watcher's catch still runs `forgetStrand` (it drops the id from `knownStrands`), and its next runs skip the suppressed id.
- **`addStrand`'s catch:** the same, `suppressStrand` before the existing `forgetStrand`. Without it, a restart whose app calls `addStrand` with v2 (the issue's path) hands the strand to the ladder.
- **Lifting:** `addStrand` already calls `unsuppressStrand` on every claim, before it launches. A claim is the only way the registered `sAppConfig` changes, so "suppressed while the registered config is unchanged" holds without keying on the schema: a claim with v3 lifts the stop and launches; a claim repeating v2 makes one more attempt (one start-up, which the app asked for) and is suppressed again.

Also update the docs on `MAX_RETRY_BACKOFF_MS`, `suppressStrand` (its log line says "deliberate local stop"; make it name the reason, or log the reason at the caller) and `addStrand`'s JSDoc so they list the schema refusal as the second "the ladder cannot help" case.

Rejected alternative: `StrandInstanceManager` remembers the failing (strand id, schema) and refuses a matching `startStrand` before `buildStrandRuntime` creates a node. It would save the one start-up an explicit repeat claim costs, but it adds per-strand state that needs its own invalidation (a stop, the row's removal, rows another member deleted that would let the schema apply), and the loop the issue measured is automatic, which suppression ends. Persisting the refusal across restarts was rejected for the same reason: a schema refused on rows can apply once other members delete those rows, and each process start costs only one attempt.

What happens to a refused strand meanwhile: nothing runs for it on this node (the failed launch left nothing tracked), exactly as during today's failing retries. The app learns from the rejected `addStrand` and from one `strand:error` whose `error` is an `AppSchemaRefusedError`. No `appSchemaState()` applies, since there is no database. The reference apps already log `strand:error` (RN and NativeScript with `console.warn`, web shows `error.message`), so no app change is needed.

### Related backlog ticket

`backlog/bug-refused-app-schema-kept-for-strand-resume` (a refused schema kept in a storage replica's retained launch config, so a later resume fails) is a different code path (`StrandInstanceManager.attachSApp` and `resumeStrand`) and stays separate. It now names this ticket as `prereq:` and can use `appSchemaRefusalOf` to tell a permanent refusal from a retryable one.

## Edge cases & interactions

- **Storage or network fault during the apply** (cause chain holds a plain `Error` or a `BUSY` / `MISUSE` code): untyped, ladder as today. Verified by a plugin test (below).
- **An apply refused after a `drop table` / `drop column` that Quereus could not unwind** (`retryableRefusalOf` returns undefined, the error is the cohort refusal wrapped by `throwFailedApply`): the chain holds `PromiseShortfallError`, so it stays untyped and a restart replans it from the store. Verified by the same plugin test.
- **Wrapping order inside `applyAppSchemaOrDefer`:** the wrap happens in `applyAppSchema`, before `retryableRefusalOf` runs. A deferral's chain always holds a non-refusal link, so it is never wrapped and `deferralOf` still finds it. Verified by inspection; the existing deferral tests must still pass.
- **Founder path** (`foundStrand` → `attachFoundingRow` → `addStrand`): covered by `addStrand`'s catch; the published row stays, as today for any failed attach. By inspection.
- **A storage replica claimed in place** (`claimTrackedStrand` → `attachSApp` → `attachAppSchema` → `applyAppSchema`): the live apply now throws the typed error, so `addStrand` suppresses the watcher instead of handing it to the ladder; the replica instance keeps running, and the watcher's removal loop still sees it only while it is in `knownStrands`. Check that suppressing a running replica does not leave it untracked by the removal loop in a way it was not already (the `unsuppressStrand` JSDoc describes this hazard); if it does, keep the id known. By inspection.
- **Watcher stop / control row removed:** both already clear suppression, so a restarted watcher or a re-published row gets a fresh attempt. By inspection.
- **Concurrent claim and watcher run:** a watcher launch in flight when `addStrand` lifts the suppression is guarded by the existing `knownStrands` in-flight rule; nothing new. By inspection.

## Tests

- **Plugin, the repro (new, in `app-schema-deferral.spec.ts` or `plugin.spec.ts`):** on the local transactor, apply v1 `table T (Id integer primary key)`, insert a row, then `applyAppSchemaOrDefer` with v1 plus `At text not null` rejects with an `AppSchemaRefusedError` whose `cause` chain reaches the `CONSTRAINT` error.
- **Plugin, the fault side (extend the existing "fails a refused apply that dropped a column" test):** additionally assert the rejection is not an `AppSchemaRefusedError` and `appSchemaRefusalOf` returns undefined for it. This is a real storage fault through a real apply.
- **cadre-core (extend `cadre-node-strand-added-failure.spec.ts`, which drives `CadreNode` against a fake strand manager):** a `startStrand` rejecting with an `AppSchemaRefusedError` makes `handleStrandAdded` emit one `strand:error` and call `suppressStrand`; through `addStrand`, the same rejection suppresses, and a following `addStrand` with a different schema calls `unsuppressStrand` and launches. A plain `Error` already has a case there (no suppression); keep it.
- The issue's real-node repro (one launch over a window that would see several) is not written as a cadre-core test: it would boot libp2p nodes and wait out ladder steps, and the branches it pins are covered above. Run the issue's Node script by hand if it is cheap to adapt, and say in the handoff whether you did.

## TODO

- Add `AppSchemaRefusedError`, `isSchemaRefusal` (with the `NOTE:`), and `appSchemaRefusalOf` to `app-schema.ts`; make the seed / ignored-item refusals throw it; wrap in `applyAppSchema` and in the deferred retry's `failed` outcome.
- Export both from the plugin's `index.ts`; re-export from cadre-core's `index.ts`.
- `CadreNode.handleStrandAdded` and `CadreNode.addStrand` catches: suppress on a refusal.
- Update the JSDoc on `MAX_RETRY_BACKOFF_MS`, `suppressStrand`, `addStrand`, and the `strand:error` doc in `types.ts` (name the typed error).
- Tests above.
- `docs/strands.md` → "An app schema upgrade waits for the queue or the cohort": add a short paragraph (or a sub-heading) saying a refusal decided by the schema against this node's tables fails the connect with `AppSchemaRefusedError`, and on a cadre node stops automatic relaunches until the next claim; replace the sentence "Any other connect-time apply error still fails the connect" accordingly. Mention it in the plugin `README.md` where `applyAppSchema` refusals are described, if they are.
- Add a line to `.release-notes.pending.md` (gotchoices/sereus#57).
- `yarn workspace @serfab/quereus-plugin-sereus test`, `yarn workspace @serfab/cadre-core test`, `yarn lint`, and the type check.
