description: The React Native phone app now remembers the group id and server addresses it last connected with, reconnects by itself on relaunch, and can start from a push notification after the phone killed it. Review the implementation before it is archived.
architecture: docs/reference-app-rn.md#start-options-app-private-leveldb
files: packages/reference-app-rn/src/start-options.ts (new), packages/reference-app-rn/test/start-options.spec.ts (new), packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/push-wake-native.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/src/relay-config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, packages/reference-app-rn/README.md, docs/reference-app-rn.md, docs/architecture.md, docs/reference-app-ns.md, tickets/blocked/rn-host-node-request-device-run.md, tickets/backlog/debt-rn-cadre-phone-lifecycle-untested.md
----

# React Native: remember the node's start options — review handoff

## What changed

The phone's start options (party id, bootstrap addresses, relay addresses, Noise crypto mode) plus an `autoStart` flag are now saved as one record, key `start-options`, in the app-private `sereus-node-local` LevelDB. The record is not party-scoped; it is what selects the party. Before this, every launch started with blank Settings fields, so a solo phone founded a new party on every relaunch and every party-scoped node-local record (trusted-owner anchor, dial hints, enrolled-machine count, strand peer book) was written but never read back.

- **`src/start-options.ts`** (new, native-free): `SavedStartOptions { options, autoStart }`, `serializeSavedStartOptions`, `parseSavedStartOptions`. Stored as `{ version: 1, partyId, bootstrapAddrs, relayAddrs, noiseCryptoMode?, autoStart }`. Unparseable JSON, a non-object, an unknown version or a missing/blank party id ⇒ `undefined` with a `console.warn`. A malformed optional field is defaulted instead (`[]`, omitted mode, `autoStart: false`).
- **`src/phone-node-config.ts`**: now owns `NOISE_CRYPTO_MODES` / `isNoiseCryptoMode` (moved from `noise-crypto-config.ts`, which imports the native kit), so the parser can validate a mode in a Node test. `isNoiseCryptoMode` takes `unknown`.
- **`src/node-local-slots.ts`**: `START_OPTIONS_KV_KEY = 'start-options'` (dot-free, so it cannot collide with `<record>.<partyId>` keys). The module comment covers the new record and carries an accepted-tradeoff `NOTE:` about iOS reinstall (the Keychain anchor survives the uninstall, this record does not, so the old anchor is orphaned, which is also what happened before this change).
- **`src/cadre-phone.ts`**:
  - `nodeLocalDbHandle()` replaces the inline `??=` open.
  - `nodeLocalKvSlot(key)` builds the four LevelDB slots.
  - `loadSavedStartOptions()` is exported, and a read fault propagates from it.
  - `startPhoneNode` is now single-flight: a `starting` promise is checked *before* the `node?.isRunning` early return, so a concurrent caller waits for owner genesis and the formation responder rather than getting a half-initialised node. The body moved to `buildAndStartNode`.
  - After a successful start, the options are recorded in `nodeOptions` (with the Noise mode resolved) and saved with `autoStart: true`. The save is best-effort and awaited, so a stop that waits on `starting` is ordered after it.
  - `stopPhoneNode` awaits an in-flight start (ignoring its rejection, which that start's own caller reports), then saves `autoStart: false` while the node is still the singleton and the handle still open, then tears down as before and clears `nodeOptions`.
- **`src/use-cadre.ts`**: a mount effect loads the record once:
  - It exposes `savedStartOptions: PhoneNodeOptions | null` (set once).
  - When `autoStart` is true and `optsRef` is still empty, it sets `optsRef` (this fixes the runner's cold start) and calls the hook's own `start()` unless a node is already running.
  - A read fault ⇒ `console.warn` + `setError('Could not read the saved connection settings: …')`, and nothing starts. A `NOTE:` at that site explains why a later Connect overwriting the record is acceptable.
  - The "a Connect tap that beat this read owns `optsRef`" guard is an addition beyond the ticket: it stops the launch read from overriding a user who connected in the few milliseconds before it resolved.
- **`src/push-wake-native.ts`**: the module-scope handler now has `ensureNode: startFromSavedOptions`, which starts from the saved record only when `autoStart` is true. The comment and the `ensureNode` doc in `push-wake.ts` were rewritten.
- **`app/settings.tsx`**: `connectFormFrom(saved)` computes the four field values (saved options, else today's defaults; a saved empty relay list shows the build default, which is what Connect would use). They are used for the initial state, and an effect on `cadre.savedStartOptions` applies them if the load resolves after mount. The Bootstrap field is now parsed with `splitRelayAddrs`, so a saved list round-trips as `a, b`. `NOISE_CRYPTO_MODES` is now imported from `phone-node-config`.
- **Comments/docs**:
  - `relay-config.ts` states the "stored values win over build defaults" rule and how to pick up a new default.
  - `docs/reference-app-rn.md` has a new "Start options (app-private LevelDB)" subsection, and the ⚠️ paragraph is gone. The Relay/Noise tables mention the remembered values, the lent-node relaunch sentence is rewritten, and the package tree lists `start-options.ts`.
  - `docs/architecture.md`: the ⚠️ sentence now covers NativeScript only.
  - `docs/reference-app-ns.md` points at `ns-persist-node-start-options`.
  - The README has one line in the solo quick-start.
  - `tickets/blocked/rn-host-node-request-device-run.md` gets a relaunch-reconnect step in place of the "cannot be checked yet" sentence.
  - `grep -rn "persist-node-start-options" packages/reference-app-rn docs` now finds only references to the NativeScript follow-up `ns-persist-node-start-options` (in `docs/architecture.md` and `docs/reference-app-ns.md`), and that ticket deletes them.

## Tests

- `test/start-options.spec.ts` (new, `node` project), one `describe` over `parseSavedStartOptions`:
  - serialize→parse round-trips;
  - unparseable JSON, `version: 2` and an empty `partyId` each return `undefined`;
  - a bad `noiseCryptoMode` plus a non-array `relayAddrs` keeps the party id and defaults those two fields.
- `test/react/use-cadre.spec.ts`:
  - The `cadre-phone` mock gains `loadSavedStartOptions` (resolves `h.ctl.saved`, default `undefined`, reset per test).
  - `documents: a warm node at mount (no start()) cannot cold-start after an OS kill` became `cold-starts a node that was already running at mount from the saved options`. With a warm node and a saved `autoStart: true` record, mount starts nothing, and an OS kill followed by foreground calls `startPhoneNode(SAVED_OPTS)`.
  - The new `describe('… resuming the last session at launch')` has two `it`s. `autoStart: true` with no node makes mount call `startPhoneNode(SAVED_OPTS)` and reach `connected`. `autoStart: false` starts nothing, leaves the status `idle`, and still exposes `savedStartOptions`. The ticket asked for "one test" here; I split it along the `autoStart` branch. Merge them if you prefer.

No test covers the `cadre-phone.ts` wiring: it imports native modules and has no Node test. I added this ticket's new rules (single-flight, stop waits for the start, save on success only, `autoStart: false` saved before teardown) as an arm of the existing backlog ticket `debt-rn-cadre-phone-lifecycle-untested` instead of filing a new one.

Validation run: `yarn workspace @serfab/reference-app-rn typecheck` passed. `yarn workspace @serfab/reference-app-rn test` passed: 21 files, 301 tests, with the stale-build guard green. `yarn lint` was clean.

## How to validate on a device (not done; no device run in this ticket)

- **Solo relaunch keeps the party.** Connect with a blank Party ID, create a strand, then force-stop and reopen the app. It should reach Connected by itself and the strand should come back. Disconnect: the Party ID field should show the same id as before.
- **Disconnect sticks.** Disconnect, then force-stop and reopen. The app stays idle, with all four fields prefilled from the last session.
- **Push wake after an OS kill.** With a session that ended connected, kill the process and deliver a strand-wake push. The background task should start the node (the `[push-wake]` logs show a `service-wake` outcome rather than `no-node`). After a Disconnect, the same push should be a `no-node` no-op.
- **Stored values win.** Connect on a build with relay A, rebuild with `EXPO_PUBLIC_RELAY_ADDR` = relay B, relaunch: the app still uses A. Disconnect, clear Relay and Connect: it now uses B.
- **Borrowed node after relaunch** — the new step in `tickets/blocked/rn-host-node-request-device-run.md`.

## Known gaps and things to look at

- **Start arriving during a stop's teardown (older race, one new path into it).** While `stopPhoneNode` awaits `stopping.stop()`, `node` is already null. A `startPhoneNode` call in that window (for example the background runner's resume, if the app goes to the background and back during Disconnect) builds a new node on the same LevelDB handle, and the stop's `finally` then closes that handle. This race existed before this ticket. A push wake reaches it only if it read the record *before* Disconnect saved `autoStart: false` and calls start after the teardown began, which is a very narrow window. Not fixed. A fix would be for `startPhoneNode` to await an in-flight stop.
- **Device token on Disconnect during a runner cold start.** `use-cadre`'s `stop` clears the device token before `stopPhoneNode` waits on the in-flight start. If the node is not running at that moment, the clear does nothing and the old `DeviceToken` row stays. This also existed before the ticket. From the UI it is reachable only when Disconnect is visible (status `connected`) while the runner is cold-starting a killed node. During a launch auto-start the status is `connecting`, so the Disconnect button is not shown.
- **Settings edits made before the launch load resolves** are overwritten by the prefill effect. The window is one LevelDB read at launch.
- **A launch into a node that a push wake already started** does not call `acquireAndRegisterDeviceToken`, because `start()` is skipped. The token was registered by an earlier Connect and is still in `DeviceToken`, so this seems fine, but it is a behaviour difference from a normal Connect.
- **Unmeasured:** auto-connect at launch, the push-wake cold start and the relaunch reconnect to a borrowed node have never been observed on a device.
- The NativeScript counterpart is `implement/2.1-ns-persist-node-start-options.md` (prereq on this ticket). It is told to follow this shape.
