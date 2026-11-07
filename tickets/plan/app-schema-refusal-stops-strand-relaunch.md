description: A strand whose app schema can never apply against its stored tables is relaunched forever, each attempt a full strand bring-up; on a phone that cost 32% of CPU for 6 minutes after start (gotchoices/sereus#57).
architecture: docs/architecture.md
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-watcher.ts, packages/cadre-core/src/strand-instance-manager.ts
repro: issue
----
# A refused app schema stops the strand's relaunch until the schema changes

Reported in gotchoices/sereus#57 (kjeib), with a Node repro script in the issue body and a narrowing in its one comment. Measured there on 1.20.0 with Optimystic 1.24 and Quereus 4.24.

## What happens

`applyAppSchemaOrDefer` (`quereus-plugin-sereus/src/app-schema.ts`) turns two failures into deferrals: `QueuedEntriesBlockSchemaChangeError` and a `cohort-unreachable` commit failure (`deferralOf`, reached through `retryableRefusalOf`). Every other apply error is rethrown. `CadreNode.handleStrandAdded` emits `strand:error` and rethrows without looking at the kind, and `StrandWatcher` schedules the next launch on its 5 s doubling ladder capped at 5 min (`MAX_RETRY_BACKOFF_MS`, "attempts are never abandoned"). Each attempt builds a new libp2p node and composes the database before failing at the same DDL.

The issue's repro: schema v2 adds `At text not null` with no default to a table that has rows. `ALTER TABLE App.T ADD COLUMN At text not null` fails on every attempt. A type change or a primary-key change fails the same way. On a laptop an attempt costs about 50 ms of CPU; on a Galaxy S7 behind a relay, 9 to 11 s at 60 to 100% CPU.

## Expected behaviour

- A refusal decided by the DDL against the local catalog and rows (a constraint existing rows cannot meet, an unsupported alter, an incompatible key or type change) emits one `strand:error` and stops relaunching that strand while its registered `sAppConfig` is unchanged.
- A failure whose cause chain holds a storage or network fault (`classifyCommitFailure`, `BlockUnavailableError`, and the like) keeps today's ladder. The issue's comment makes this point: treating every non-deferral error as permanent could suppress a strand that would have recovered.
- A later `addStrand` / `foundStrand` / claim with a different schema (id, version or schema hash) lifts the stop. `unsuppressStrand` exists already.

## Points for the plan

- **How a refusal is recognised.** The plugin is the place that knows a DDL refusal from a storage fault. Prefer a typed error from the plugin (the issue suggests `AppSchemaApplyRefusedError`) over matching message text. Decide what Quereus 5.0.0 exposes to tell them apart (error class, `StatusCode`), and read `../quereus` rather than guessing.
- **Where the stop lives.** Either `handleStrandAdded` treats the typed error like `InvalidStrandIdError` (suppress), keyed on the schema so a new one lifts it, or the instance manager remembers the failing (strand id, schema hash) and refuses a relaunch before `buildStrandRuntime` creates a node. The second also saves the first attempt's bring-up on every later process start; weigh whether that memory should survive a restart.
- **Related backlog ticket:** `bug-refused-app-schema-kept-for-strand-resume` is the same class from another side: a schema the plugin refuses outright (a `seed` item, an unparsed item) is kept in the retained launch config, so every later resume fails. The same typed refusal answers both. Fold it in if the design covers it, or chain it with `prereq:`.
- **Who sees it.** The app needs to know the strand is stopped on its schema, not retrying. Check what `appSchemaState()` and `strand:error` report today and whether the reference apps show it.

## Test

A cadre-core test following the issue's repro: found with v1, write a row, restart with v2 adding a `not null` column without a default, and assert one launch attempt over a window that would otherwise see several, then a relaunch once a v3 that applies is registered. A second case with a storage fault in the cause chain keeps retrying.
