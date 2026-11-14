description: When a newer app version is applied to a shared workspace while an older app is still open on it, the older app's side now notices and closes the workspace with the "update the app" error, because its later edits would otherwise erase what the newer version added.
prereq: app-schema-version-gates-strand-open
architecture: docs/strands.md#a-running-member-stops
files: packages/quereus-plugin-sereus/src/app-schema-version.ts (new: version gate, moved, plus the running check `AppSchemaVersionCheck`), packages/quereus-plugin-sereus/src/app-schema-errors.ts (new: the two error classes and `appSchemaRefusalOf`, moved), packages/quereus-plugin-sereus/src/app-schema-waits.ts (new: `Deferral`, `deferralOf`, open-transaction retry, `abortableDelay`, `COHORT_CONNECT_SETTLE_MS`, moved), packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts, packages/quereus-plugin-sereus/src/types.ts, packages/quereus-plugin-sereus/src/index.ts, packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts, packages/cadre-core/src/strand-app-schema-report.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-instance-manager.ts (`launchedSAppConfig`), packages/cadre-core/src/cadre-node.ts (`stopAppSchemaRefusedStrand`, `stopIfRebuildRefusedAppSchema`, `handleStrandWake`, `handleStrandCheckIn`), docs/strands.md, packages/quereus-plugin-sereus/README.md, packages/cadre-core/README.md, .release-notes.pending.md
----

# A running member stops when a higher app schema version is recorded

Third of three tickets on app schema versions (gotchoices/sereus#59). The gate from `app-schema-version-gates-strand-open` refuses a lower app at connect. This ticket covers a member that was already open when another member recorded a higher number: its writes on the old catalog would clear the newer columns.

## What was built

**Plugin: a running check, and one report.** `AppSchemaVersionCheck` (`app-schema-version.ts`) does a live read of `Strand.AppSchemaVersion`. It reads on a `Database.watch` wake of that table (after a 50 ms coalesce), 2 s after each strand-node `peer:connect` (`COHORT_CONNECT_SETTLE_MS`), and at least every 30 s (`APP_SCHEMA_VERSION_CHECK_MS`). Only one read runs at a time; a wake during a read schedules one more. A failed read is logged at debug. The check makes no read when it starts, because the gate has just read the version. It stops when it reports or when `released` aborts. Timers are `unref`'d. `composeStrand` starts it once the connect-time apply settles `applied`, whether at once or after a deferral (`afterApply`).

**Result API.** `SereusPluginResult` has two new members:

- `onAppSchemaSuperseded(listener) => unsubscribe` is called once with `AppSchemaOutdatedError(appSchemaVersion, strandSchemaVersion)`. The report is latched: a listener added after the report is called at once. Nothing is reported after shutdown.
- `applyAppSchema(app)` applies a schema to the live connection and then checks that version. It stops the running check first, so its own record does not report itself as superseded, and restarts that check if the apply fails.

**cadre-core.**

- `StrandAppSchemaReport` subscribes to the plugin's report and forwards it at once through the new `StrandAppSchemaListeners.onAppSchemaSuperseded`, whether or not the database has been published. `release()` unsubscribes, so a closing database reports nothing.
- `StrandDatabase.attachAppSchema` now calls `result.applyAppSchema`, so a claimed replica is checked too.
- `CadreNode.stopAppSchemaRefusedStrand`:
  - untracks the strand from hibernation;
  - stops it through `StrandInstanceManager.stopStrand`, which keeps storage, network state, control rows and the registered sApp config;
  - calls `suppressIfAppSchemaRefused(strandId, launchedSAppConfig, error)`, or `forgetStrand` when a newer claim registered another config meanwhile;
  - emits `strand:stopped`, then `strand:error`.
- A second report for the same strand joins the stop already in flight.

**Hibernation wake path.** This was broken and is now fixed. A wake or check-in whose rebuild was refused the schema used to re-hibernate, so the next wake was refused again on the backoff ladder. `handleStrandWake` and `handleStrandCheckIn` now call `stopIfRebuildRefusedAppSchema` first. It acts only when the rebuild itself failed (status `'error'`) with an `AppSchemaRefusedError`. `serviceWake` and the removed-machine rebuild go through `handleStrandWake`. I traced the hibernation manager's settle path: `rearmAfterWake` leaves a `'stopped'` instance alone, and `runCheckIn` sees its `runningCheckIns` entry already removed by the untrack and does not reschedule.

**Module split.** The `NOTE:` in `app-schema.ts` asked for this split if this ticket added more version logic, and it did. The gate and its helpers moved to `app-schema-version.ts`. The errors moved to `app-schema-errors.ts`, which `index.ts` now exports from. The shared waits moved to `app-schema-waits.ts`. Line counts: `app-schema.ts` 367, `app-schema-version.ts` 392, `app-schema-waits.ts` 83, `app-schema-errors.ts` 45.

## Deviations from the ticket, for the reviewer to weigh

- **A deferred retry that finds the strand ahead also reports through `onAppSchemaSuperseded`.** The ticket had cadre-core watch two signals: the report, and an `appSchema` outcome of `failed` with an outdated error. Here the plugin raises both through the one report, so a host calling `connectToStrand` directly also has only one thing to listen for. `StrandAppSchemaReport.settle` therefore does not raise `onAppSchemaFailed` for an outdated error, which avoids a duplicate `strand:error`. The `appSchema` promise still settles `failed` with the error.
- **`applyAppSchema` on the result** replaces cadre-core's direct import of the plugin's `applyAppSchema` in `StrandDatabase`. This lets the plugin own the check for the attach path too, using the composition's `released` signal and peers. The standalone `applyAppSchema` export stays.
- **`strand:stopped` is emitted before `strand:error`.** The ticket names only `strand:error`. The strand had emitted `strand:started`, so an app tracking running strands from those two events would otherwise show it as running forever.

## Tests

- `networked.e2e.spec.ts` → "tells a running member when another member records a higher App schema version". Peer A runs version 1 and stays open. Peer B connects with version 2, which adds a nullable column to `Msg`. A's listener must receive `{ appSchemaVersion: 1, strandSchemaVersion: 2 }` in less than `APP_SCHEMA_VERSION_CHECK_MS`. It passed in about 0.5 s. A debug run showed the report 66 ms after B's record, so A's watch woke on B's commit without strand reactivity. No other test was added. As the ticket said, cadre-core's reaction is wiring over existing calls and is verified by reading the code.

## Validation

- `yarn typecheck` passes in the plugin and cadre-core, and `yarn lint` passes at the repo root.
- Plugin `yarn test`: 15 files, 168 passed, 1 todo.
- cadre-core `yarn test`: 2629 passed, 3 failed, all in `control-database-solo-warm-start.spec.ts`. They failed on control-database genesis and `first.stop()` op timeouts under full-suite load, while the machine was at 97% CPU with 59 other `node` processes running. The file passes 6 of 6 when run alone.
  - `tickets/.pre-existing-known.md` records this file as a one-off. Following its confirm protocol, I measured the genesis empty-collection commit at 9–13 s alone; the record measured about 1 s. That is written up in `tickets/.pre-existing-error.md` for triage.
  - It is not this change: genesis runs before any strand exists, and every strand connection in that spec shut down within 1 ms.
- The plugin was rebuilt (`yarn build`) so cadre-core runs against the new `dist`.

## Known gaps

- **No spec for cadre-core's stop, or for the wake/check-in stop.** Both were checked by reading the code. A spec would need a cadre node whose strand hibernates and then wakes into a strand ahead of its schema, and no existing hibernation spec does that.
- **A report during the database build, before publication, stops a strand whose build is still in flight.** This relies on the manager's existing stop-during-build handling, the same path an app's `stopStrand` takes (`firstSyncGates` closed by `releaseRuntime`, and builds re-checking `isCurrentRuntime`). I did not exercise it.
- **The check's read joins a transaction the app holds open.** It is a plain `db.eval`, so it runs inside the app's transaction and may read that transaction's view. The next wake reads again.
- **Every `peer:connect` wakes a check, including the relay's.** Wakes are coalesced to one pending timer.
- **Tripwires left as `NOTE:` comments:**
  - at `APP_SCHEMA_VERSION_CHECK_MS`: the detection window is milliseconds with reactivity and up to 30 s without; check in the commit path if that window matters before lenses land;
  - at `AppSchemaVersionWatch`: a member alone pays one statement-lock-holding read per 30 s; skip the floor read when the node has no connections if that shows up as stalled statements.
- **The offline queue is not held**, as the ticket decided. The limit is documented in docs/strands.md → "A running member stops", and the work is parked as `backlog/feat-offline-queue-waits-for-a-current-app-schema-version`.

## Review focus

- The single-flight and wake logic in `AppSchemaVersionWatch`: the `due` comparison, `again`, and how the floor is re-armed.
- `AppSchemaVersionCheck.stop()` dropping a pending connect-time apply. This matters if a host calls `applyAppSchema` while its connect-time apply is still deferred.
- `stopIfRebuildRefusedAppSchema` gating on `instance.status === 'error'`, when a wake joins a check-in's failed rebuild or the reverse.
- Whether emitting `strand:stopped` alongside `strand:error` is wanted.
