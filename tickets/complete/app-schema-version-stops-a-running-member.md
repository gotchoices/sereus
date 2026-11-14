description: When a newer app version is applied to a shared workspace while an older app is still open on it, the older app's side now notices and closes the workspace with the "update the app" error, because its later edits would otherwise erase what the newer version added.
prereq: app-schema-version-gates-strand-open
architecture: docs/strands.md#a-running-member-stops
files: packages/quereus-plugin-sereus/src/app-schema-version.ts, packages/quereus-plugin-sereus/src/app-schema-errors.ts, packages/quereus-plugin-sereus/src/app-schema-waits.ts, packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/cadre-core/src/strand-app-schema-report.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, docs/strands.md, packages/quereus-plugin-sereus/README.md, packages/cadre-core/README.md, .release-notes.pending.md
----

# A running member stops when a higher app schema version is recorded

Third of three tickets on app schema versions (gotchoices/sereus#59). The gate from `app-schema-version-gates-strand-open` refuses a lower app at connect. This ticket covers a member that was already open when another member recorded a higher number: its writes on the old catalog would clear the newer columns.

## What was built

The implementation landed in `ticket(implement): app-schema-version-stops-a-running-member`.

- **Plugin.** `AppSchemaVersionCheck` (`app-schema-version.ts`) re-reads `Strand.AppSchemaVersion` while the connection runs: on a `Database.watch` wake of that table (after a 50 ms coalesce), 2 s after each strand-node `peer:connect`, and at least every 30 s. One read runs at a time. It reports once through the new `SereusPluginResult.onAppSchemaSuperseded(listener)` with an `AppSchemaOutdatedError`, and the report is kept so a listener added later is called at once. A deferred connect-time apply whose retry finds the strand ahead reports the same way. `SereusPluginResult.applyAppSchema(app)` applies a schema to the live connection and starts the check for that version.
- **Module split.** The gate moved to `app-schema-version.ts`, the errors to `app-schema-errors.ts`, and the shared waits to `app-schema-waits.ts`, as the `NOTE:` in `app-schema.ts` asked.
- **cadre-core.** `StrandAppSchemaReport` forwards the report as `onAppSchemaSuperseded`. `CadreNode.stopAppSchemaRefusedStrand` stops the strand through the manager (storage, network state, control rows and the registered sApp config stay), suppresses it in the watcher until the next `addStrand`, then emits `strand:stopped` and `strand:error`. A hibernation wake or check-in whose rebuild was refused the `App` schema now stops the strand the same way, instead of re-hibernating it to be refused again at every wake. `StrandDatabase.attachAppSchema` goes through the result's `applyAppSchema`, so a claimed replica is checked too.
- **Test.** `networked.e2e.spec.ts` → "tells a running member when another member records a higher App schema version".

## Review findings

**Read first:** the implement diff, then the handoff. Checked the plugin's check and wake logic, the cadre-core stop and hibernation paths, the replica-claim path, the docs, and the test.

- **Wake and single-flight logic (`AppSchemaVersionWatch`)**: correct. I traced these cases:
  - A wake while a timer is armed earlier is skipped, because of the `due` comparison.
  - A timer that fires during a read sets `again`, and the read then ends with `wake(0)`.
  - A wake during a read that has not fired by the read's end keeps its earlier timer, and the floor re-arms after that read.
  - `stop()` during a read prevents the report and the re-arm.
  - A read that never settles blocks further reads. That is acceptable, since it holds the same statement lock an app read would.

  No change.
- **`AppSchemaVersionCheck.stop()` dropping a pending connect-time apply**: dropping it is needed. Without that, a deferred apply landing during a live apply would start a check of the old version, and the live apply's own record would report it superseded. The one gap: a live apply that *fails* during a deferral leaves no check running, even once the deferral lands. cadre-core cannot reach this, because it applies live only to a replica composed without a schema. Parked as a `NOTE:` tripwire on `stop()` in `app-schema-version.ts`.
- **`stopIfRebuildRefusedAppSchema` gating on `status === 'error'`**: correct for both join orders.
  - The first failure stops the strand.
  - A second failure while that stop runs joins it through `appSchemaStops`.
  - A second failure after the stop finds the status `'stopped'` and falls through to `rehibernateIfResumeFailed`, which leaves a non-`'error'` strand alone.

  The hibernation manager's settle (`rearmAfterWake`) and `runCheckIn` (its `runningCheckIns` entry is removed by `untrackStrand`) do not re-arm a stopped strand. No change.
- **Replica claim, then superseded**: `attachSApp` writes the claimed `sAppConfig` into the launch config before applying (`strand-instance-manager.ts`, `launchConfigs.set(strandId, { ...config, sAppConfig })`). So `launchedSAppConfig` names the claim, and the stop suppresses rather than forgets. Correct.
- **Re-entrancy**: a report the plugin already holds would be delivered inside `new StrandAppSchemaReport`, mid-`StrandDatabase.initialize`, and start the stop synchronously. I did not change this. In practice no report can be latched by then: the floor is 30 s, and a deferred retry cannot settle within the microtask gap. The stop-during-build path is the one the implementer listed as a gap.
- **`strand:stopped` before `strand:error`**: wanted. An app tracking running strands from `strand:started` and `strand:stopped` would otherwise show the strand running forever. Kept.
- **Single report path (deferred outdated → `onAppSchemaSuperseded`, not `onAppSchemaFailed`)**: sound. It avoids a duplicate `strand:error`, and the `appSchema` promise still settles `failed`. Kept.
- **`applyToLiveConnection` uses the standalone `applyAppSchema`, whose version gate never aborts**: this was already true when `StrandDatabase` called the plugin's `applyAppSchema` directly. A wait on an open transaction ends once the database closes, because `exec` then throws a different error. No change.
- **Docs**: I read docs/strands.md → "A running member stops" and the two edited bullets above it, the cadre-core README event table, and the release notes. They match the code.
  - **Fixed:** the plugin README had appended the superseded report and `applyAppSchema` to the "Offline mode" paragraph, which they do not belong to. I moved the App-schema refusal and version sentences into a new section, "App schema refusals and versions". "Offline mode" keeps the queue deferral and where the queue is saved. No other doc links into that README section.
  - The reference apps do not branch on `AppSchemaOutdatedError`. That is out of scope here; they see a generic `strand:error`.
- **Tests**: the one e2e test pins the contract: a running member is told, through a wake and not the 30 s floor. No test restates the implementation or verifies a mock. None added and none cut.
  - The implementer's two gaps remain untested: cadre-core's stop, and the wake/check-in stop. Both need a hibernation fixture that wakes into a strand ahead of its schema, which no spec has. I checked both by reading the code (above).
- **Resource cleanup**:
  - The watch subscription, the `peer:connect` listener and the timer are released on `stop()`.
  - `released` aborting stops the check and clears the listeners.
  - `StrandAppSchemaReport.release()` unsubscribes.
  - Timers are `unref`'d.

  No finding.
- **Tripwires already parked by the implementer** (`APP_SCHEMA_VERSION_CHECK_MS` detection window, `AppSchemaVersionWatch` floor read on a lone member): reviewed and left as they are.
- **No tickets filed.** No finding was major. The offline-queue limit is already in `backlog/feat-offline-queue-waits-for-a-current-app-schema-version`.

## Validation

- `yarn lint` (repo root) passes. `yarn typecheck` passes in quereus-plugin-sereus and cadre-core.
- Plugin `yarn test`: 15 files, 168 passed, 1 todo.
- Plugin rebuilt (`yarn build`) after the comment edit, so the stale-build guard passes.
- cadre-core specs touching app-schema refusal, replica claim and hibernation (`cadre-node-strand-added-failure`, `strand-replica-claim`, `hibernation-manager`, `strand-instance-manager-hibernation`): 4 files, 65 passed.
- I did not rerun the full cadre-core suite: this pass changed no cadre-core code, only a comment in the plugin and the plugin README. The implementer's full run showed 3 failures in `control-database-solo-warm-start.spec.ts`, which triage has since recorded in `tickets/.pre-existing-known.md`.
