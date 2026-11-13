description: When an app claims a strand with a schema Sereus refuses, the node still remembers that schema for the strand, so every later wake of the strand fails and the node stops serving it until it restarts. Make the claim fail cleanly and leave the strand running as it was.
prereq:
architecture: docs/strands.md#a-schema-that-can-never-apply-here-is-not-retried
files: packages/cadre-core/src/strand-instance-manager.ts, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/index.ts, packages/cadre-core/test/strand-replica-claim.spec.ts, packages/cadre-core/test/signed-sapp.ts, docs/strands.md
repro: verified
----
# A refused app schema is kept for every later strand resume

## What happens

`StrandInstanceManager.attachSApp` (`packages/cadre-core/src/strand-instance-manager.ts`, around line 2156) is how an app on this machine claims a strand the node already runs as a storage replica (a strand with no app schema). It writes the claiming app's `sAppConfig` into the strand's retained launch config (`this.launchConfigs.set(strandId, { ...config, sAppConfig })`) **before** it applies the schema. `resumeStrand` rebuilds a quiesced strand from that retained config, and `composeStrand` applies its schema at every build.

`applyAppSchema` (`packages/quereus-plugin-sereus/src/app-schema.ts`) refuses some schemas permanently, as `AppSchemaRefusedError`. Two kinds:

- **Declare-time refusals**, decided by the schema text alone: a `seed` item, an item the parser skipped (`create table …`, `tabel`), or a syntax error.
- **Row-decided refusals**, decided by the schema against the tables and rows the strand holds: for example a `not null` column with no default added to a table that has rows. A replica can hit these, because `composeStrand` hydrates the strand's persisted catalog (step 5) before it applies the app schema.

Both reproduced by the two new cases in `packages/cadre-core/test/strand-replica-claim.spec.ts` ("refuses a claim with a schema that can never apply on a live / quiesced replica, and the replica still resumes"), which use a `seed` schema and currently fail:

- **Live replica:** the claim rejects with `AppSchemaRefusedError` (correct), but the refused schema stays retained, so the next `quiesceStrand` → `resumeStrand` fails inside `composeStrand` and leaves the instance `'error'` with no database.
- **Quiesced replica:** no apply runs, so the claim resolves `'attached'` (and sets `instance.sAppInfo`) for a schema that can never apply; the next resume fails the same way.

`signedSApp` in `packages/cadre-core/test/signed-sapp.ts` gained a `schema` option for these cases (fix stage). Run: `yarn workspace @serfab/cadre-core vitest run test/strand-replica-claim.spec.ts`.

## Expected behavior

A schema the plugin refuses is never kept in a strand's retained launch config. A claim with a declare-time refusal fails at the claim, on a live or quiesced replica alike, and the replica keeps running (or keeps hibernating) as it was. A live-apply failure that may pass on retry (the database closed mid-apply) keeps today's behavior: the config stays retained so the next claim retries.

## Design

**1. A database-free schema check in the plugin.** Export `checkAppSchema(schema: string): Promise<void>` from `app-schema.ts` (and `src/index.ts`; cadre-core imports it from `@serfab/quereus-plugin-sereus` like `appSchemaRefusalOf`). It runs `declareAppSchema` on a throwaway `new Database()` (no Optimystic, nothing written anywhere), maps errors through `asAppSchemaRefusal` exactly as `applyAppSchema` does, and closes the database in a `finally`. `declare schema` only parses and records, so a plain Quereus database is enough. This catches every declare-time refusal without the strand's database. It cannot catch row-decided refusals.

**2. `attachSApp` checks before retaining.** After the `sAppInfo` / `'already-attached'` test and the signature check, `await checkAppSchema(sAppConfig.schema)`. That await opens a gap after `settleRuntimeBuilds`, so re-read the retained config (and the database handle) after it rather than spreading the `config` read before it: a resume landing in the gap rewrites the retained config with fresh `bootstrapNodes`.

**3. Live arm: undo the retention on a refusal.** Wrap `database.attachAppSchema(sAppConfig)` in a try/catch. When `appSchemaRefusalOf(error)` finds a refusal, put the retained config's `sAppConfig` back to what it was before this attach — only if the retained config still carries this attach's `sAppConfig` (compare by identity), so a concurrent rewrite is not clobbered — then rethrow. Any other error rethrows with the config left retained, as today (update the JSDoc `@throws` accordingly). A replica holds no `App` schema, so a refused apply has nothing to drop, and Quereus unwinds the rest.

**4. No-database arm: fall back to the replica on a row-decided refusal.** When `attachSApp` retains without applying (no live database: quiesced, or a joiner whose database build is waiting for a seed peer, `deferUnreachableJoin`), record that this attach has not applied yet: a private per-strand map holding the pre-attach `sAppConfig` and `latencyHint`. Clear the entry on any successful build of the strand's database and on `stopStrand`. Then, where a build of that strand fails with `appSchemaRefusalOf(error)` and the entry is present:

- `runResume`'s catch: restore the pre-attach `sAppConfig` into the retained config, clear `instance.sAppInfo`, restore `instance.latencyHint`, drop the entry, log the refusal, and rebuild once more with the restored config (`buildStrandRuntime` rolls back both handles on failure, so a second build is safe). The resume then resolves with the replica running. If that second build also fails, fail as today.
- `retryUnreachableJoin`'s catch: the same restore, then retry the database phase with the restored config instead of releasing the runtime and marking `'error'`.

Without step 4, a row-decided refusal on a quiesced replica is the same outage as this ticket, only rarer.

**Accepted gap — say so in a `NOTE:` at the step-4 site:** in the no-database arm the claim has already resolved `'attached'`, so the app learns of a row-decided refusal only from the log and from `instance.sAppInfo` going back to unset; `CadreNode.sAppConfigs` still registers the claim, so a restart's launch with it is refused and suppressed through the existing `suppressIfAppSchemaRefused` path. Making the claim itself fail would mean waking a quiesced replica at claim time (the `foundExistingStrand` → `'needs-resume'` → `CadreNode.wakeStrand` pattern) and still would not cover the seed-peer-wait state, so it was not chosen.

## Rejected alternatives

- **Only the resume fallback (no database-free check):** a quiesced claim with a `seed` schema would still resolve `'attached'`, which is the developer error this ticket is mostly about; the check makes it fail where the developer sees it.
- **Wake the replica at claim time and apply live:** uniform reporting, but it wakes hibernating strands on every claim and does not help a joiner waiting for a seed peer.

## Docs

`docs/strands.md` → "A schema that can never apply here is not retried": the paragraph ending "except a storage replica the claim tried to give the schema in place: it keeps running as a replica…" — state that a refused claim on a replica leaves the replica's retained launch config unchanged (live or quiesced), and the row-decided fallback at its next build. Also the `attachAppSchema` sentence near line 449 ("The replica's next rebuild applies the schema through the connect path above") should say that holds only for a claim that was not refused.

## TODO

- Add and export `checkAppSchema` in `packages/quereus-plugin-sereus/src/app-schema.ts` / `src/index.ts`; one plugin test only if `plugin.spec.ts` does not already pin the refusals it shares with `applyAppSchema` (it does pin the seed one — prefer no new plugin test).
- `attachSApp`: run the check after the `'already-attached'` test, re-read retained config after the await, restore on a live-apply refusal (step 3), record unapplied no-database attaches (step 4).
- `runResume` and `retryUnreachableJoin`: the replica fallback on a refusal of an unapplied attach; clear the record on successful builds and in `stopStrand`; `NOTE:` for the accepted reporting gap.
- Make both new cases in `packages/cadre-core/test/strand-replica-claim.spec.ts` pass; keep the existing case green. A row-decided fallback test needs a replica whose hydrated catalog has a table with rows — add one only if it can be built without a second node (e.g. found the strand with one schema, stop, relaunch as a replica, quiesce, claim with an added `not null` column); otherwise record the untested arm in the review handoff.
- Update `docs/strands.md` as above.
- Run `yarn workspace @serfab/quereus-plugin-sereus test`, `yarn workspace @serfab/cadre-core test`, `yarn lint`, and the type check.
