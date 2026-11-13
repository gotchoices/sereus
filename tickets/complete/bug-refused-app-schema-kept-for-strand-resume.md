description: When an app claims a strand with a schema Sereus refuses, the node used to keep that schema for the strand, so every later wake failed and the node stopped serving the strand until a restart. The claim now fails cleanly (or, when the strand was asleep, its next wake falls back) and the strand keeps running as a plain storage replica.
architecture: docs/strands.md#a-schema-that-can-never-apply-here-is-not-retried
files: packages/cadre-core/src/strand-instance-manager.ts, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/README.md, packages/cadre-core/test/strand-replica-claim.spec.ts, docs/strands.md
----
# Complete: a refused app schema is no longer kept for strand resume

## What landed

A storage replica is a strand this node runs with no app schema. `StrandInstanceManager.attachSApp` is how an app on the same machine claims one. It used to write the claiming app's `sAppConfig` into the strand's retained launch config before applying it. A schema that Quereus or the plugin refuses (`AppSchemaRefusedError`) therefore stayed retained, and every later `resumeStrand` failed, leaving the instance in `'error'` with no database.

- **Plugin:** `checkAppSchema(schema)` (`packages/quereus-plugin-sereus/src/app-schema.ts`) declares the schema on a throwaway Quereus database. It raises the refusals the schema text alone decides: a `seed` item, an item the parser skipped, a syntax error.
- **`attachSApp`** runs that check before changing anything, then waits out any runtime build that started during the check and reads the instance and config again (`claimTarget`).
- **Live replica:** if the live apply is refused, `revertRefusedAttach` drops the sApp from the retained config and the error is rethrown.
- **Hibernating replica, or a joiner waiting for a seed peer:** the claim resolves `'attached'`. If the next build is then refused by the strand's rows, it reverts the claim and builds once more as the replica: `buildRuntimeOrReplica` for a resume, `buildJoinDatabaseOrReplica` for a deferred join. The private map `unappliedAttaches` records which claim that build may revert.
- **Docs:** `docs/strands.md` → "A refused claim leaves a storage replica as it was". The plugin README mentions `checkAppSchema`.

See the commit `ticket(implement): bug-refused-app-schema-kept-for-strand-resume` for the full diff and the implementer's notes on deviations.

## Review findings

**Checked:** the implement diff, read before the handoff. That covered:
- `attachSApp`, `claimTarget`, `applyClaimedSchema`, `revertRefusedAttach`, `forgetAppliedAttach`, `buildRuntimeOrReplica`, `buildJoinDatabaseOrReplica` and the `stopStrand` change;
- how they interact with `resumeStrand`, `quiesceStrand`, `retryUnreachableJoin`, `buildStrandRuntime`'s failure rollback (`releaseRuntime`) and `StrandDatabase.attachAppSchema` / `appSchemaState` / `close`;
- CadreNode's callers: `claimTrackedStrand`, the founder `needs-resume` wake, and `suppressIfAppSchemaRefused` on a failed `addStrand`;
- the plugin's `checkAppSchema`;
- the docs (`docs/strands.md`, `docs/architecture.md` → Strand Filtering, the plugin README).

**Validation:** I ran `yarn workspace @serfab/cadre-core test` after my fix: 197 files, 2629 passed, 1 skipped. `yarn lint` and `yarn workspace @serfab/cadre-core typecheck` pass. I rebuilt the cadre-core `dist`. I did not re-run the plugin's tests because I did not change plugin code; the implementer ran them.

**Fixed inline (minor).** The deferred-join fallback could leak a database past a stop. `stopStrand` does not wait for in-flight builds. `buildJoinDatabaseOrReplica` closes the failed attempt's database, and that close is an await. If a stop began during that await, its `releaseRuntime` found no gate to release, so the replica build that followed would register a gate and database on a stopped runtime, and nothing would close them. The same race could not happen before this change, because `buildStrandDatabase` registers its gate synchronously when it is called. The fallback now checks again after the discard (`isCurrentRuntime` and `status !== 'stopping'`) and returns `'released'` instead of building. No test: reproducing it needs a stop timed inside one close await, and the guard follows the "stopped mid-build" checks `buildStrandRuntime` and `buildStrandDatabase` already make.

**Correctness (no other defects found).**
- The runtime fallback is safe against a stop, because `stopStrand` deletes the unapplied-claim record before its first await, so `revertRefusedAttach` declines afterwards.
- Every rewrite of the retained config spreads the old one: resume overrides, the founder flip, the rekey and the founder withdrawal. So the identity check `config.sAppConfig !== refused` still holds across them.
- The founder path (claim a hibernating replica, then `foundExistingStrand` → `needs-resume` → wake) now ends with the wake falling back to the replica. `ensureFounderBootstrap` then refuses the sApp-less database, and `withdrawFounderRequest` runs, so `addStrand` rejects instead of leaving the strand in `'error'`.
- The implementer's open question, the refused `App` declaration left in a live replica's `declaredSchemaManager`: nothing reads it. The only `diff schema App` reader is the plugin's connect-time deferred retry, and cadre-core reads only the control schema's declaration.

**Considered, not changed.**
- `applyClaimedSchema` calls `appSchemaState()` after a live apply. That call throws if a concurrent quiesce finished closing the database in that instant. The result would be the same as the existing "other error" path: the claim stays retained and the next build retries it. Not worth a second helper.
- The fallback rebuilds the whole libp2p node once on a refused resume. It is a one-time cost on a rare path.

**Tests.** The two fix-stage cases and the two added cases each pin a distinct arm: claim-time refusal, live revert, and resume fallback, live and hibernating. None of them restates the implementation; keep them. The gaps the handoff names remain untested:
- the deferred-join fallback, which needs a second node;
- a transient live failure followed by a refused rebuild;
- a deferred apply keeping the record;
- the `latencyHint` restore.

The join fallback reuses the tested `revertRefusedAttach`. The rest is short branching I checked by reading. None meets the bar for new heavy multi-node tests.

**Docs:** accurate as they stand. `docs/architecture.md` → Strand Filtering's claim bullet does not mention refusal, but `docs/strands.md` owns that topic and is linked from the same section's launch-failure text, so I made no change.

**Tripwires / tickets:** none filed. The implementer's `NOTE: accepted gap` in `attachSApp` covers the one deliberate limitation: a hibernating claim refused later is reported only through the log and through `sAppInfo` going back to unset.
