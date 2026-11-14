description: When a newer app version is applied to a shared workspace while an older app is still open on it, close the workspace on the older app's side with the "update the app" error, because its later edits would otherwise erase what the newer version added.
prereq: app-schema-version-gates-strand-open
architecture: docs/strands.md#until-then-every-member-on-the-same-schema-version
files: packages/quereus-plugin-sereus/src/app-schema.ts, packages/quereus-plugin-sereus/src/compose-strand.ts (result, `released`, `peers`), packages/quereus-plugin-sereus/src/types.ts (`SereusPluginResult`), packages/cadre-core/src/strand-database.ts, packages/cadre-core/src/strand-app-schema-report.ts, packages/cadre-core/src/strand-instance-manager.ts (`stopStrand`, `resumeStrand`, launch configs), packages/cadre-core/src/cadre-node.ts (`suppressIfAppSchemaRefused`, the `appSchema` listeners ~7636), packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts (two-peer harness), docs/strands.md, .release-notes.pending.md
----

# A running member stops when a higher app schema version is recorded

Third of three tickets. After `app-schema-version-gates-strand-open`, `Strand.AppSchemaVersion` holds the highest recorded `App` schema version and a lower app is refused at connect. A member that opened before another member recorded a higher number still runs on its own hydrated catalog, and Optimystic says what that costs: "its writes can erase a value in a column it does not know about … with no error on either machine" (Optimystic README, limitations). docs/strands.md says such a member "stops writing the strand's app tables, failing the same way" as a refused connect.

## Decisions

**Detect by reading the row, in the plugin.** After the gated apply settles `applied` (immediately or deferred), the composition starts a check of `select Version from Strand.AppSchemaVersion` (a live read, so it pulls other machines' commits). It runs:

- on every `Database.watch` wake of `Strand.AppSchemaVersion` (local commits, and with strand reactivity, any machine's, via the `network_watch` tag the table carries);
- on each strand-node `peer:connect`, after the same settle delay the deferred retry uses (`COHORT_CONNECT_SETTLE_MS`), so a member coming back from offline checks before it does much else;
- every `APP_SCHEMA_VERSION_CHECK_MS` = 30 000 ms, the change-notification renewal interval, as the floor when neither fires.

A read that fails is logged at debug and left to the next trigger. Checks never overlap (one in flight; a trigger during it schedules one more). The check stops when `released` aborts.

**Report, don't act, in the plugin.** On the first read above this app's number the plugin stops checking and reports once:

```ts
interface SereusPluginResult {
	/** Called once, when a higher App schema version than this connection's is recorded. Returns an idempotent unsubscribe. A host must close the database: its writes can erase what the newer version added. */
	onAppSchemaSuperseded: (listener: (error: AppSchemaOutdatedError) => void) => () => void;
}
```

The plugin cannot close a `Database` its caller owns, and Quereus has no read-only switch or pre-commit hook to refuse writes with. A direct plugin host (`connectToStrand` without cadre-core) closes on the report; the README/JSDoc says so.

**cadre-core stops the strand, like a refused launch.** Two signals mean the same thing: `onAppSchemaSuperseded`, and an `appSchema` outcome `{ state: 'failed' }` whose error is an `AppSchemaOutdatedError` (a deferred retry that found the strand ahead). On either, for the strand's live database:

- stop the strand's runtime and instance through the manager's stop (`StrandInstanceManager.stopStrand`), not `CadreNode.stopStrand`/`detachStrand`: storage, saved network state and control rows stay;
- `suppressIfAppSchemaRefused(strandId, <the config it launched with>, error)`, so the watcher does not relaunch; the next `addStrand` (an updated app's claim) lifts it and launches through the connect gate;
- emit `strand:error` with `{ strandId, error }`; the app branches on `error instanceof AppSchemaOutdatedError` to tell its user to update.

This is what a refused connect leaves behind, so the app sees one state for both. Stopping rather than demoting to a storage replica: apps run on phones and browsers, which do not host unclaimed strands; a replica there would be a strand nothing asked for.

**The offline queue is not held.** A member offline at the lower version keeps queuing, and its queue can drain on reconnect before the check above sees the higher number; a queued update then rewrites rows without the newer columns. Holding the queue needs a check that the number is current, made against the network, before the queue's gate opens; that is parked as `backlog/feat-offline-queue-waits-for-a-current-app-schema-version`. Here: document the limit in docs/strands.md and order the reconnect check as early as the settle delay allows.

## Edge cases & interactions

- **The detection window.** Writes made between another member's record and this member's check can still erase values: milliseconds with reactivity, up to 30 s without. State it in docs/strands.md as the limit of this stop-gap; lenses remove it (`feat-app-schema-migration-through-lenses`). Add a `NOTE:` at `APP_SCHEMA_VERSION_CHECK_MS`: if the window matters before lenses land, check in the commit path instead.
- **Hibernation.** A quiesced strand has no database and no check. Its wake recomposes, so the connect gate refuses it. Verify `resumeStrand`/the wake path treats that `AppSchemaRefusedError` like a launch refusal (stopped, suppressed, `strand:error`) rather than retrying on the hibernation ladder; fix there if not. By inspection, or extend an existing hibernation spec only if it already wakes into a refused schema.
- **A deferred apply** never starts the check until it lands; a retry that finds the strand ahead settles `failed` with the outdated error, which cadre-core treats as above.
- **Shutdown during a check**: the read is abandoned (`released`); no report after shutdown. `StrandAppSchemaReport.release()` already drops reports from a closing connection; route the new signal through it so a report from a closing database does not reach the app.
- **The member that recorded the higher number** reads its own number: equal, no report.
- **A storage replica** has no app schema: no check.
- **A claim that attached the schema to a live replica** (`attachAppSchema`) starts the check the same way after its apply.
- **Two higher versions racing**: the check reports at the first read above this app's number; it does not need the final one.

## Test that pays

`networked.e2e.spec.ts`, two peers on one strand: A connects with schema version 1 and stays open. B connects with version 2 (adds a nullable column), which records 2. A's `onAppSchemaSuperseded` listener is called with `appSchemaVersion === 1`, `strandSchemaVersion === 2`, within a bound well under 30 s (both peers hold every block at the default breadth, so A's watch wakes on B's commit; if it does not, the peer-connect trigger or a test-local wait on the 30 s floor decides the bound — prefer making the watch path work over lengthening the test). cadre-core's reaction is wiring over existing calls and is verified by inspection.

## TODO

- Version check loop in app-schema.ts (watch, peer connect, 30 s floor, single flight, `released`), started after the gated apply lands; `onAppSchemaSuperseded` on `SereusPluginResult`.
- cadre-core: route both signals through `StrandAppSchemaReport`/`StrandDatabase` to a handler that stops the instance, suppresses, emits `strand:error`.
- Check the hibernation wake path against a refused schema.
- The networked spec.
- docs/strands.md → "Until then": the running-member mechanism, the window, the offline-queue limit; remove the "not yet built" note. Release notes.
- `yarn lint`, typecheck, plugin and cadre-core suites.
