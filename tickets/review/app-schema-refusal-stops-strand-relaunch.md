description: When an app's new schema can never apply to the tables a strand already holds (for example a required column added to a table that has rows), the node used to retry starting that strand forever, each try a full start-up (gotchoices/sereus#57). Such a refusal now carries its own error type and stops the automatic retries until the app registers the strand again.
architecture: docs/strands.md#a-schema-that-can-never-apply-here-is-not-retried
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/app-schema-deferral.spec.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/cadre-node-strand-added-failure.spec.ts, packages/cadre-core/README.md, docs/strands.md, docs/architecture.md, .release-notes.pending.md
----
# A refused app schema stops the strand's relaunch until the next claim

## What changed

**Plugin (`packages/quereus-plugin-sereus/src/app-schema.ts`).**

- New exported `AppSchemaRefusedError` (`name = 'AppSchemaRefusedError'`, Quereus's error as `cause`) and `appSchemaRefusalOf(err)`, which walks the `cause` chain for one. Both are exported from the plugin's `index.ts` and re-exported from cadre-core's `index.ts`.
- `applyAppSchema` wraps its body in a try/catch and rethrows through `asAppSchemaRefusal`: wrapped when `isSchemaRefusal(err)` holds, unchanged otherwise. The wrapped message is `sApp schema cannot be applied to this strand's tables: <Quereus message>`.
- `isSchemaRefusal(err)` is true only when every link of the `cause` chain is a `QuereusError` whose code is in `SCHEMA_REFUSAL_CODES` (`ERROR`, `CONSTRAINT`, `MISMATCH`, `UNSUPPORTED`, `SYNTAX`, `SCHEMA`, `RANGE`). A `NOTE:` there names the one known transient `ERROR` with no cause (Optimystic's partially-committed committed-read refusal) and when to revisit.
- `assertNoIgnoredItems` and `assertNoSeedItems` throw `AppSchemaRefusedError` directly. Their messages are unchanged.
- The deferred retry's `{ state: 'failed', error }` passes its error through `asAppSchemaRefusal`, so the `strand:error` cadre-core emits for it is typed the same way.
- The deferral path is unchanged. A deferral's chain always holds a plain `Error` (`PromiseShortfallError`) or a non-refusal Quereus error, so it is never wrapped, and `deferralOf` still walks into the chain.

**cadre-core (`packages/cadre-core/src/cadre-node.ts`).**

- New private `suppressIfAppSchemaRefused(strandId, error)`: when `appSchemaRefusalOf` finds a refusal, it logs and calls `strandWatcher.suppressStrand`.
- Called in `handleStrandAdded`'s catch after the `strand:error` emit and before the rethrow. Called in `addStrand`'s catch before the existing `forgetStrand`.
- Lifting needs no new code: `addStrand` already calls `unsuppressStrand` before it launches.
- JSDoc updated on `addStrand`, `MAX_RETRY_BACKOFF_MS` and `suppressStrand`. The `suppressStrand` log line no longer says "deliberate local stop", and each caller logs its own reason.
- `strand:error` in `types.ts` gained a doc comment naming the typed error.

**Docs.** `docs/strands.md` has a new sub-section, "A schema that can never apply here is not retried". The parent section's "Any other connect-time apply error still fails the connect" now links to it. `docs/architecture.md` (the StrandWatcher paragraph) now lists the two cases that are suppressed instead of retried. `packages/cadre-core/README.md` (`strand:error` row), `packages/quereus-plugin-sereus/README.md` and `.release-notes.pending.md` are also updated.

## Tests (added or extended)

- `app-schema-deferral.spec.ts` → **new** "refuses a schema the rows in its tables can never take, typed so a host stops retrying it". This is the issue's repro on the local transactor: v1 `table T (Id integer primary key)`, one row, then v2 adds `At text not null`. `applyAppSchemaOrDefer` rejects with `AppSchemaRefusedError`, and its `cause` chain reaches a `CONSTRAINT` `QuereusError`.
- `app-schema-deferral.spec.ts` → **extended** "fails a refused apply that dropped a column…". This is a real storage fault (`PromiseShortfallError` in the chain) through a real apply. It now also asserts `appSchemaRefusalOf(failure)` is undefined, so the fault side stays untyped.
- `cadre-node-strand-added-failure.spec.ts` → **extended** "emits strand:error and rejects when the launch fails". A recording watcher is injected, and the test asserts that a plain fault makes no watcher call, so the fault stays on the ladder.
- `cadre-node-strand-added-failure.spec.ts` → **new** "suppresses a strand whose app schema its tables refuse, found through a wrapping error". `startStrand` rejects with `new Error('launch failed', { cause: refusal })`. The test asserts one `strand:error` and exactly `suppress <id>`, which pins the cause-chain walker at cadre-core's catch site too.
- `cadre-node-strand-added-failure.spec.ts` → **new** `CadreNode.addStrand app schema refusal`. The first `addStrand` (schema v2) is refused, and the watcher sees `unsuppress, suppress, forget`. A second `addStrand` (schema v3) gives `unsuppress` and launches with v3.

## Validation run

- `yarn workspace @serfab/quereus-plugin-sereus test`: 14 files, 165 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test`: 197 files, 2623 passed, 1 skipped.
- `yarn lint` (whole repo): clean.
- `yarn workspace @serfab/quereus-plugin-sereus typecheck` and `yarn workspace @serfab/cadre-core typecheck`: clean.
- The full root `yarn typecheck` (every workspace plus the coverage check scripts) and the integration tests were **not** run.
- Built both packages (`yarn workspace … build`), so other workspaces' stale-build guards see current `dist`.
- **The issue's Node script was run by hand** against the built packages (copied from the issue body into a temporary file, run with `WATCH_S=60` and without `--preserve-symlinks`, which breaks resolution through the sibling links; the file and its data directory were deleted afterwards).
  - Result: run 2 over 61 s made 2 launch attempts, 1 strand libp2p build and 1 `strand:error`.
  - Before the fix, the issue measured 5 attempts and 5 libp2p builds in 80 s.
  - No ladder attempt fired at the 5 s or 10 s steps.

## Known gaps and things for the reviewer to check

- **Only the call that started the launch carries the typed error when the app's claim and the watcher's launch overlap.** The repro hits this: the app's `foundStrand` registers the config, and the watcher's first run enters `handleStrandAdded` on the claimed branch. `claimTrackedStrand` waits on the in-flight launch, finds it failed, and throws a plain `Error` ("the launch this one waited on failed (reported by the call that started it)"). In that run the one `strand:error` carried the plain error, and the `foundStrand` rejection carried the `AppSchemaRefusedError`. In the reverse order, `addStrand` gets the plain error and `strand:error` gets the typed one. Either way the call that started the launch suppresses, so the loop stops. The app sees the typed error on one of the two channels, not necessarily `strand:error`. This is documented in `docs/strands.md`. Carrying the build's error to the waiter would need `StrandInstanceManager.whenRuntimeBuilt` to keep the rejection; I did not do that.
- **A storage replica claimed in place stays running but untracked by the watcher's removal loop.** The path is `claimTrackedStrand` → `attachSApp` → `attachAppSchema` → `applyAppSchema`. After a refused claim, the replica instance keeps running. `addStrand`'s catch suppresses the id and `forgetStrand` drops it from `knownStrands`, so if the strand's control row is removed, the watcher's removal loop will not detach this replica. That blindness is **not new**: `forgetStrand` already dropped the id after any failed claim, and ladder attempts re-recorded it only for the duration of each (always failing) attempt. So I left it as is, per the ticket's "if it does [make it worse], keep the id known". If the reviewer wants it closed, a small arm in `addStrand`'s catch could skip `forgetStrand` (keeping the id known and suppressed) when `strandManager.getInstance(id)` still returns an instance after a refusal.
- **A hibernation resume over a refused retained config** is `backlog/bug-refused-app-schema-kept-for-strand-resume` (its `prereq:` is this ticket). It can now use `appSchemaRefusalOf`. Not touched here.
- **No new test asserts that the declare-time refusals (seed item, ignored item) are typed.** The existing `plugin.spec.ts` cases still match their messages. The change is a constructor swap at the two throw sites, with no branching to pin.
- **`StatusCode.ERROR` is broad.** See the `NOTE:` on `isSchemaRefusal`. If the reviewer knows of another `QuereusError(ERROR)` with no `cause` that an apply can raise for a transient reason, the allowlist needs narrowing.
