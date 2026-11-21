description: On a strand with three machines, a machine that stores none of a watched table's newest data is sometimes not woken by another machine's change notification and only catches the change on its next 30-second check. It was rare on earlier Optimystic releases and fails about half the time on 1.29.0.
architecture: docs/strands/app-schema.md#what-a-watcher-sees
files: packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts (assertRound ~357, awaitSchemaTagWatches), packages/cadre-core/src/strand-reactivity.ts, schemas/strand.qsql (AppSchemaVersion's network_watch tag), ../Optimystic/packages/db-p2p/src/reactivity/collection-watch.ts, ../Optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts (wantedNetworkWatches, applyNetworkWatch), ../Optimystic/docs/reactivity.md
repro: verified
----

# A push notification misses the watcher outside the tail group

## Observed

`yarn vitest run src/scenarios/strand-reactivity-wakes-watchers.integration.ts` in `packages/integration-tests`, alone, on Optimystic 1.29.0 (linked at `e81f33e3`) and Quereus 5.6.1, 2026-11-20. It failed 2 of 4 runs with:

```
AssertionError: round 1 (p[0] commits), watcher p[1] outside the tail group: a notification reached its subscribers and woke the watch: expected undefined to be defined
```

The other two passed. Logs: `tickets/.logs/optimystic-1-29-0.reactivity-2.log` (failed), `…reactivity.log` and `…reactivity-1.log` (passed). The run before those failed at about 150 s with no captured message.

The same assertion failed once in the 2026-10-21 gate on Optimystic 1.18.0 and then passed 3 of 3 (`tickets/.pre-existing-known.md`, now marked in-flight on this ticket).

## What changed on 1.29.0

Each machine now holds two network watches, not one: `App.Data` (the scenario's tagged table) and `Strand.AppSchemaVersion`, which `schemas/strand.qsql` tags `"optimystic.network_watch" = true` on purpose (docs/strands/app-schema.md → "App schema versions across a strand's members"). Before 1.29.0 the scenario counted one watch per machine, so the `AppSchemaVersion` watch did not open in this scenario then. 1.29.0 also opens one watch per collection of a tagged table (upstream GitHub #47), which reconciles watches in a new step queue in the plugin. The scenario's expected count is now 2 (`SCHEMA_TAG_WATCHES`).

Hypothesis, not confirmed: three machines now register two collections each on the same renewal tick after the first commit, and the out-of-group machine's registration for `App.Data`, or the push to it, is lost or late in that burst. docs/strands/app-schema.md → "What a watcher sees" promises that machines registering together are all admitted.

## Next step

Rerun with `DEBUG=optimystic:*reactivity*,optimystic:*cohort-topic*` until it fails, and check, for p[1] in round 1: whether its `default/app/Data` subscription was attached (`isAttached`) when p[0] committed, whether p[0]'s commit originated a notification, and whether the push to p[1] was sent. Then decide whether the cause is in Sereus (for example, the scenario must wait for registration of both watches, or `AppSchemaVersion` should not hold a network watch on every machine) or upstream (report to Optimystic through `blocked/` with the log).

## Edge cases

- The watcher in the tail group wakes from its own storage, not the push. The assertion checks only the out-of-group watcher; keep it that way.
- If the cause is registration timing, the fix belongs in the code or in docs/strands/app-schema.md, not in a longer wait in the scenario. A longer wait would hide a broken promise in "What a watcher sees".
