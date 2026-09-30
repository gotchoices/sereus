description: When an app claims a strand with a schema Sereus refuses, the node still remembers that schema for the strand, so every later wake of the strand fails and the node stops serving it until it restarts.
architecture: docs/schema-guide.md#seeds-local-quereus-databases-only
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-database.ts, packages/quereus-plugin-sereus/src/compose-strand.ts
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Only an app shipping a schema that can never apply triggers it, and that app sees the refusal on its first claim, so a maintainer may judge the replica outage an acceptable cost of a developer error that a restart clears.
----
# A refused app schema is kept for every later strand resume

`applyAppSchema` (quereus-plugin-sereus) refuses some schemas outright, whatever the node's state: a `seed` item (ticket `sapp-schema-refuses-seed-rows`), an item the Quereus parser skipped (`create table …`, `tabel`), or text that does not parse.

`StrandInstanceManager.attachSApp` stores the claiming app's `sAppConfig` into the strand's retained launch config **before** it applies the schema, so that a failed live apply can be retried by the next claim (its JSDoc says so). For a refusal that will always recur, that retention does harm:

- **Live replica:** `attachAppSchema` throws, `sAppInfo` stays unset, but the retained config now carries the refused schema. The next quiesce → `resumeStrand` rebuild calls `composeStrand`, which applies the same schema, throws, and leaves the instance in `error` with no database. The node stops serving that strand's blocks to other parties.
- **Quiesced replica:** no apply runs at claim time at all, so `attachSApp` returns `'attached'` for a schema that can never apply, and the next wake fails the same way.

Only a restart clears it, because the retained config lives in memory.

## Expected behavior

A schema the plugin refuses is never kept in a strand's retained launch config. A claim with such a schema fails at the claim, on a live or a quiesced replica alike, and the replica keeps running as it was. Failures that may succeed on retry (the database closed during the apply) keep today's retry-on-next-claim behavior.

## Evidence

Read from `attachSApp` (the `this.launchConfigs.set(strandId, { ...config, sAppConfig })` line before `database.attachAppSchema`) and `resumeStrand` (which rebuilds from the retained config). Confirming it needs a cadre-core test that claims a replica with a `seed` schema, quiesces it, and resumes it.

A likely shape: the plugin exports a check that parses the schema body and applies the item refusals without a database, and `attachSApp` runs it before retaining anything.
