description: When an app claims a strand with a schema Sereus refuses, the node used to keep that schema for the strand, so every later wake failed and the node stopped serving the strand until a restart. The claim now fails cleanly (or, when the strand was asleep, its next wake falls back) and the strand keeps running as a plain storage replica.
architecture: docs/strands.md#a-schema-that-can-never-apply-here-is-not-retried
files: packages/cadre-core/src/strand-instance-manager.ts, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/test/strand-replica-claim.spec.ts, docs/strands.md
----
# Review: a refused app schema is no longer kept for strand resume

## What changed

A storage replica is a strand this node runs with no app schema. `StrandInstanceManager.attachSApp` is how an app on this machine claims one. It used to write the claiming app's `sAppConfig` into the strand's retained launch config before applying it, so a schema Quereus or the plugin refuses (`AppSchemaRefusedError`) stayed retained, and every later `resumeStrand` failed inside `composeStrand`, leaving the instance `'error'` with no database.

**Plugin: `checkAppSchema(schema)`** (`packages/quereus-plugin-sereus/src/app-schema.ts`, exported from `src/index.ts`, mentioned in the README). It declares the schema on a throwaway `new Database()` and maps errors through `asAppSchemaRefusal`, closing the database in a `finally`. It catches the refusals the schema text alone decides: a `seed` item, an item the parser skipped, a syntax error. I confirmed in Quereus 5.4.0 that `declare schema` only parses and records (`runtime/emit/schema-declarative.ts` → `emitDeclareSchema`, `planner/building/declare-schema.ts`) and resolves no names, so a schema that references `Strand.*` tables is not falsely refused.

**cadre-core (`strand-instance-manager.ts`):**

- `attachSApp`: after the `'already-attached'` test and the signature check, it awaits `checkAppSchema`. Because that await yields, it then runs `settleRuntimeBuilds` again and re-reads the instance and config through the new `claimTarget` helper, which also repeats the `'already-attached'` test. This keeps a resume landing in the gap from losing its fresh `bootstrapNodes`, and keeps the attach from acting on a database that is still being built.
- New private map `unappliedAttaches` holds, per strand, a claim the retained config carries but no apply has landed yet. Each entry stores the claim's `sAppConfig` and the instance's `latencyHint` from before the claim. `attachSApp` sets it every time it retains a claim. It is cleared:
  - by `forgetAppliedAttach`, when a database built with that `sAppConfig` initializes with `appSchemaState() === 'applied'` (in `buildStrandDatabase`), or when the live apply succeeds;
  - by the fallback below;
  - at the start of `stopStrand`, before the release awaits.
- Live arm (`applyClaimedSchema`): if the live apply is refused, `revertRefusedAttach` drops the sApp from the retained config and the error is rethrown. Any other error leaves the claim retained and recorded, as before.
- No-database arm, meaning a quiesced replica or a joiner waiting for a seed peer: the claim resolves `'attached'` as before. If the next build is then refused, it is retried once as the replica:
  - `runResume` uses `buildRuntimeOrReplica`;
  - `retryUnreachableJoin` uses `buildJoinDatabaseOrReplica`, which first closes the failed attempt's database, since a failed `buildStrandDatabase` leaves it registered with its first-sync gate.
  - In both, `revertRefusedAttach` drops the sApp from the retained config, clears `instance.sAppInfo`, restores `latencyHint` and logs the refusal. Both retries run inside the same tracked runtime build, so no attach or resume can slip in between the two builds.
- `revertRefusedAttach` undoes nothing unless all of these hold: the error is a refusal, the recorded claim is the one that was refused, the retained config still carries it (compared by identity), the instance is still the tracked one, and the manager is not stopping.
- A `NOTE: accepted gap` in `attachSApp`'s no-database branch says that the app learns of a refusal by the strand's rows only from the log and from `sAppInfo` going back to unset.

**Docs:** `docs/strands.md` has a new paragraph pair, "A refused claim leaves a storage replica as it was", in "A schema that can never apply here is not retried". The `attachAppSchema` sentence now says a refused claim is not applied on the next rebuild.

## Deviations from the implement ticket (reviewer: check these)

- **The unapplied-claim record covers more than the no-database arm.** It is also set before a live apply and kept when that apply fails for a reason that may pass. The case this covers: a claim's live apply fails because the database closed mid-apply, the claim stays retained, and the next resume is then refused by the strand's rows. That resume now falls back to the replica too. Without the record it would end in `'error'`, which is this ticket's outage.
- **The fallback drops `sAppConfig` instead of restoring "what it was before".** The two are the same thing. `attachSApp` only proceeds while `sAppInfo` is unset. `startStrand` sets `sAppInfo` whenever it launches with an sApp. So the instance was launched as a replica and its config had no sApp.
- **A deferred apply does not clear the record.** If the schema apply is deferred (`appSchemaState()` is `'waiting-for-queue'` or `'waiting-for-cohort'`), the record stays, because a later retry of the apply can still be refused by the rows. A build whose apply is still deferred therefore keeps the record until a later build applies the schema. After a successful deferred apply that later build's diff is empty, so it clears.
- `forgetAppliedAttach` checks the record before calling `appSchemaState()`. Many manager specs mock `StrandDatabase` without that method. Calling it unconditionally broke 102 tests, which is how I found this.

## Tests

- `strand-replica-claim.spec.ts` → "refuses a claim with a schema that can never apply on a live / quiesced replica, and the replica still resumes". These two cases were written in the fix stage and failed before this change; they pass now. They check the claim-time check on both arms.
- Added: `strand-replica-claim.spec.ts` → "runs the replica again when its rows refuse a claim's schema on a live / quiesced replica".
  - Setup: the strand is founded with `table Note (Id text primary key)`, a row is inserted and the strand is stopped. It is then relaunched as a replica over the same `MemoryRawStorage` and transport key, and claimed with `Note` plus `At text not null`. That schema passes the claim-time check, and Quereus refuses it against the existing row.
  - The live case pins the live-arm revert. The quiesced case pins the resume fallback: the claim resolves `'attached'`, and the resume still runs the replica with its `App.Note` row readable.
  - I confirmed both cases fail when `revertRefusedAttach` is disabled; they fail with Quereus's "NOT NULL constraint failed for column 'At'".
- No plugin test was added: `plugin.spec.ts` already pins the seed and skipped-item refusals that `checkAppSchema` shares with `applyAppSchema`, through the same `declareAppSchema`.

## Not tested (known gaps)

- **The deferred-join fallback** (`buildJoinDatabaseOrReplica`) has no test. It needs a joiner whose seed peer is unreachable at launch and answers later, with the strand's rows refusing the claimed schema. That takes a second node, and the cohort-unreachable setup in the existing tests is heavy. The arm reuses `revertRefusedAttach`, which is tested; the new part is closing the failed attempt's gate before the retry.
- **Two cases are not tested:** a live apply that fails for a reason that may pass followed by a refused rebuild, and a deferred apply keeping the record.
- **The `latencyHint` restore is not asserted.**
- **Leftover declaration after a live refusal (harmless as far as I can see).** A refused live apply leaves the refused `App` declaration recorded in that live database's `declaredSchemaManager`, because `declare schema` ran before the refused `apply`. Nothing on a replica's database applies or diffs `App` later, and a later claim declares again. A reviewer may want to confirm nothing reads it.

## Validation run

- `yarn workspace @serfab/quereus-plugin-sereus build`, then `test`: 165 passed, 1 todo.
- `yarn workspace @serfab/cadre-core test`: 197 files, 2629 passed, 1 skipped.
- `yarn workspace @serfab/cadre-core build` passed; I rebuilt `dist` so downstream stale-build guards stay quiet.
- `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/quereus-plugin-sereus typecheck` and root `yarn typecheck`: all exit 0.
