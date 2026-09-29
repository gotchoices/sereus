description: Make the React Native phone app remember the group id and server addresses it last connected with, so it reconnects by itself on relaunch and can start from a push notification after the phone killed it, instead of making the user retype them in Settings every time.
architecture: docs/reference-app-rn.md#node-local-persistence
files: packages/reference-app-rn/src/start-options.ts (new), packages/reference-app-rn/test/start-options.spec.ts (new), packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/src/noise-crypto-config.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/push-wake-native.ts, packages/reference-app-rn/src/push-wake.ts, packages/reference-app-rn/src/relay-config.ts, packages/reference-app-rn/test/react/use-cadre.spec.ts, docs/reference-app-rn.md, docs/architecture.md, tickets/blocked/rn-host-node-request-device-run.md
----

# React Native: remember the node's start options

## Problem

`PhoneNodeOptions` (`phone-node-config.ts`) — party id, bootstrap addresses, relay addresses, Noise crypto mode — comes only from the Settings form and is stored nowhere. So:

- every relaunch starts with blank fields; a user who leaves Party ID blank gets a fresh random id, which means **a solo phone founds a new party on every relaunch**;
- every node-local record (trusted-owner anchor, bootstrap dial targets, enrolled-machine count, strand peer book) is filed under the party id, so they load empty every launch — correct storage that is never read back;
- a push wake into an OS-killed process has nothing to start from, so `push-wake-native.ts` builds its handler with no `ensureNode` and the wake is a `no-node` no-op;
- the `BackgroundRunner` cold start in `use-cadre.ts` (`ensureNode` → `optsRef`) only works if `start()` ran in this JS context (pinned as a known gap by the test `documents: a warm node at mount (no start()) cannot cold-start after an OS kill` in `test/react/use-cadre.spec.ts`).

## Design (settled)

### What is stored, and where

One record, not party-scoped (it is what *selects* the party):

```ts
// start-options.ts — no native imports, so Node tests load it
export interface SavedStartOptions {
	/** Exactly what the node was last successfully started with. */
	options: PhoneNodeOptions;
	/** True after a successful start, false after the user taps Disconnect. Gates every unattended start. */
	autoStart: boolean;
}
export function parseSavedStartOptions(text: string | undefined): SavedStartOptions | undefined;
export function serializeSavedStartOptions(saved: SavedStartOptions): string;
```

Serialized as `{ "version": 1, "partyId", "bootstrapAddrs", "relayAddrs", "noiseCryptoMode"?, "autoStart" }`.

Parse rules (the one piece with real branching):
- `undefined`, unparseable JSON, a non-object, an unknown `version`, or a missing / empty / non-string `partyId` ⇒ `undefined` (absent), with a `console.warn` for everything except `undefined` input.
- The party id is the only field worth protecting, so a malformed *optional* field is dropped to its default rather than discarding the record: a non-string-array `bootstrapAddrs` / `relayAddrs` ⇒ `[]`; a `noiseCryptoMode` that is not one of the three modes ⇒ omitted (build default); a non-boolean `autoStart` ⇒ `false`.

**Backend: the existing app-private `sereus-node-local` LevelDB**, one key: add `START_OPTIONS_KV_KEY = 'start-options'` to `node-local-slots.ts` (read through the same `LevelDBKVStore(handle, NODE_LOCAL_KV_PREFIX)` and `kvStoreSlot` the other non-trust-bearing records use). Not secure store: nothing here is secret or trust-bearing (a group identifier and public network addresses), and a relay list can outgrow SecureStore's ~2048-byte value. Not a new database: the web app keeps its persisted party id in its node-local database too (`reference-app-web/src/lib/cadre-web.ts`, `loadOrCreatePartyId`). No new native dependency, so no dev-client rebuild.

Tradeoff to document (in `node-local-slots.ts`'s module comment and the docs): on iOS the anchor lives in the Keychain, which survives an uninstall, while this record lives in LevelDB, which does not. After a reinstall the phone gets a new party id and the surviving Keychain anchor for the old one is simply never read again — same outcome as today, no regression.

`noiseCryptoMode` validation needs the three-mode list, which today lives in `noise-crypto-config.ts` — a module that imports the native kit. Move `NOISE_CRYPTO_MODES` and `isNoiseCryptoMode` to `phone-node-config.ts` (native-free, already owns `PhoneNodeOptions`) and import them back into `noise-crypto-config.ts`.

### Who writes it — all inside `cadre-phone.ts`

Every path that starts or stops the node goes through `startPhoneNode` / `stopPhoneNode`, so persistence lives there and no caller can forget it:

- **Handle accessor.** Replace the inline `nodeLocalDb ??= openLevelDb(NODE_LOCAL_DB_NAME)` with a small `nodeLocalDbHandle()` that does the same (the open is synchronous, so JS single-threading already prevents a double open). `stopPhoneNode` keeps closing it exactly as now; the next access reopens.
- **`loadSavedStartOptions(): Promise<SavedStartOptions | undefined>`** (exported) — reads the key and parses. A read *fault* propagates (the caller decides; see below).
- **After a successful start** (after `initializeFormationResponder`), `startPhoneNode` saves `{ options: opts, autoStart: true }`. Best-effort: a failed write is `console.warn`ed and does not fail the start. Record the options the node was built with in a module variable beside `nodeNoiseCryptoMode`.
- **`stopPhoneNode`** saves `{ options: <recorded options>, autoStart: false }` *before* `stopping.stop()` and before the handle is closed, best-effort and logged, and only when options were recorded (a stop after a start that never built a node writes nothing). `stopPhoneNode` is only reached from Settings → Disconnect (`use-cadre.ts` `stop`), which already means "log out" (it clears the push-wake device token), so clearing auto-start there is the same intent. An OS kill runs no code, so `autoStart` stays true across it — which is the point.
- **Single-flight start.** Add `let starting: Promise<CadreNode> | null`: while a start is in flight, `startPhoneNode` returns that promise instead of beginning a second one (clear it in a `finally`). Today only one caller can race; after this ticket a launch auto-start, a push-wake cold start, the runner's `ensureNode` and a Connect tap can all overlap, and two concurrent starts would each build a `CadreNode`. A second caller with *different* options gets the in-flight node — the same "whatever is running wins" rule the `node?.isRunning` early return already applies — and its options are not saved, because only the call that did the work saves.
- **Stop during a start.** `stopPhoneNode` awaits an in-flight `starting` (ignoring its rejection) before tearing down, so Disconnect tapped during an auto-start stops the node that start produces rather than racing it.

### Who reads it

- **`use-cadre.ts`, once on mount** (the `CadreProvider` is mounted at the root layout, so this is app launch): `loadSavedStartOptions()`. Then:
  - expose it as a new `UseCadreResult.savedStartOptions: PhoneNodeOptions | null` (set once, from this load only) for Settings to prefill from;
  - if `autoStart` is true, set `optsRef.current = saved.options` — that alone fixes the runner's cold start — and, if no node is running (`getPhoneNode()?.isRunning` is false), call the hook's own `start(saved.options)` so status, device-token registration and every other side effect of Connect happen the same way;
  - a read fault: `console.warn` and `setError('Could not read the saved connection settings: …')` without changing `status`; no auto-start, fields stay blank.
- **`push-wake-native.ts`**: give the module-scope handler an `ensureNode` that loads the saved record and, only when `autoStart` is true, calls `startPhoneNode(saved.options)`. Any throw is already caught and logged by `ensureLiveNode` in `push-wake.ts`. Rewrite the comment above `handler` (it currently explains why `ensureNode` is omitted) and the `ensureNode` doc in `PushWakeHandlerDeps` ("or if start options aren't persisted").
- **`app/settings.tsx`**: initialise `partyId`, `bootstrapAddr`, `relayAddr` and `noiseCryptoMode` from `cadre.savedStartOptions` when present (falling back to today's defaults), and add an effect on `cadre.savedStartOptions` that applies the same values when the load resolves after the screen mounted. Prefill `bootstrapAddr` as `bootstrapAddrs.join(', ')` and have `handleConnect` parse that field with `splitRelayAddrs` (a multiaddr never contains a comma), so a saved list round-trips; the field stays a single-line input.

### Deliberate choices (document them; do not re-open)

- **Stored values win over the build defaults.** `relayAddrs` and `noiseCryptoMode` are stored as resolved — exactly what the node ran with — not as "use the build default". A later build with a different `EXPO_PUBLIC_RELAY_ADDR` / `EXPO_PUBLIC_NOISE_CRYPTO` does not override a device's remembered values; to pick up the new default, Disconnect, clear the Relay field (empty already means "build default" in `resolveRelayAddrs`) or pick the mode, and Connect. The Node card already shows the mode actually running. Say this in `relay-config.ts`'s module comment (replacing the "Nothing persists the typed value" bullet) and in the docs' Configuration section.
- **Launch auto-connects** when the last session ended in a connected state. This is what makes a solo phone keep its party across relaunches. Maestro flows launch with `clearState: true` (`maestro/_setup.yaml`, `flows/4-solo-create-strand.yaml`), so they always see a fresh, idle app and are unaffected.
- **Save on success only.** A failed start does not overwrite the last good record, so a typo in Settings cannot replace a working party; an unattended start always uses the last configuration that actually came up.

## Edge cases & interactions

- **Corrupt or foreign-shaped record** ⇒ treated as absent, warned, and overwritten by the next successful start. Verified by the parse test below.
- **LevelDB read fault on launch** ⇒ no auto-start, visible error, blank fields. A Connect with a blank party id would then mint a new one and overwrite on success; acceptable because the node-local stores in the same database propagate read faults and fail that start first. Leave a `NOTE:` at the load site saying so. By inspection.
- **Save failure** after a successful start or on Disconnect ⇒ logged, node state unaffected. By inspection.
- **Overlapping starts** (launch auto-start + push-wake cold start + runner `ensureNode` + Connect tap) ⇒ one `CadreNode`, via the single-flight promise. By inspection; the Connect button is also disabled while `status === 'connecting'`.
- **Disconnect during an auto-start** ⇒ `stopPhoneNode` waits for the in-flight start, then stops; the record ends `autoStart: false`. By inspection.
- **Node already running at mount** (a push-wake task started it in this JS runtime before the UI mounted) ⇒ no second start; `optsRef` is populated so the runner can cold-start later. Covered by the converted test below.
- **Push wake after the user disconnected** ⇒ `autoStart` is false, so the wake stays a `no-node` no-op; the device token was also cleared at Disconnect. By inspection.
- **Switching party in Settings** ⇒ Disconnect (writes `autoStart: false` with the old options), edit, Connect (writes the new options). By inspection.
- **Handle lifetime.** A load after Disconnect reopens `sereus-node-local` and leaves it open until the next stop. No leak: `nodeLocalDbHandle()` reuses an open handle. The dev-reload hazard already documented beside `nodeLocalDb` is unchanged.
- **Party-scoped records now actually survive a relaunch.** The enrolled-machine count will now declare a repair yardstick on relaunch, and the strand peer book / bootstrap dial targets will be dialed. These paths are already covered headlessly in cadre-core; nothing app-side to add.

## Tests (only these)

- `test/start-options.spec.ts`: one `describe` over `parseSavedStartOptions`: a serialize→parse round trip returns the input; unparseable JSON, a wrong `version`, and a blank `partyId` each return `undefined`; a record with a bad `noiseCryptoMode` and a non-array `relayAddrs` keeps its `partyId` with those fields defaulted.
- `test/react/use-cadre.spec.ts`: add `loadSavedStartOptions` to the `cadre-phone` mock (default: resolves `undefined`). Convert `documents: a warm node at mount (no start()) cannot cold-start after an OS kill` into the positive contract: with a saved `autoStart: true` record and a warm node at mount, an OS kill followed by foreground makes `startPhoneNode` run with the saved options (and mount itself does not start a second node). Add one test: with a saved `autoStart: true` record and no node, mount calls `startPhoneNode` with the saved options and reaches `connected`; with `autoStart: false`, mount starts nothing and `savedStartOptions` still carries the options.

No test for the `cadre-phone.ts` wiring (it imports native modules and has no Node test today); verify by inspection and typecheck.

## Docs

- `docs/reference-app-rn.md`: add a "Start options (app-private LevelDB)" subsection under **Node-Local Persistence**: what is stored, the key, when it is written (successful start / Disconnect), who reads it (launch, runner cold start, push wake), the stored-values-win-over-build-defaults rule, the reinstall note. Delete the ⚠️ paragraph under "Bootstrap dial targets" and rewrite the "Reconnecting to the lent node after the app relaunches…" sentence in *Borrowing a Node From a cadre-host → The run* so it no longer waits on this ticket. In the Configuration section's Noise-mode table, note the Settings choice is now remembered.
- `docs/architecture.md` (the long node-local persistence paragraph, the "⚠️ On both phone apps…" sentence): rewrite to say React Native persists its start options (party id included), so its records are observable across a relaunch; NativeScript is still outstanding under `ns-persist-node-start-options`. That follow-up ticket deletes the sentence.
- `tickets/blocked/rn-host-node-request-device-run.md` line 32: replace "cannot be checked yet … until ticket `feat-rn-persist-node-start-options` lands" with a step to check the reconnect after a relaunch.
- Update the stale code comments that name `feat-rn-persist-node-start-options`: `cadre-phone.ts` (the NOTE in `startPhoneNode`), `phone-node-config.ts` (`relayAddrs` doc), `relay-config.ts` (module comment), `push-wake-native.ts`. `grep -rn "persist-node-start-options" packages/reference-app-rn docs` should return nothing afterwards.

The ticket's original request to move the "a solo phone re-founds a party on every relaunch" caveat somewhere more visible is dropped: this ticket removes the behaviour, and the caveat goes with it.

## TODO

- Move `NOISE_CRYPTO_MODES` / `isNoiseCryptoMode` into `phone-node-config.ts`; re-import in `noise-crypto-config.ts`.
- Add `start-options.ts` (type, parse, serialize) and `START_OPTIONS_KV_KEY` in `node-local-slots.ts` (extend its module comment).
- `cadre-phone.ts`: `nodeLocalDbHandle()`, recorded options, `loadSavedStartOptions`, save-on-success in `startPhoneNode`, save-`autoStart:false` in `stopPhoneNode`, single-flight `starting`, stop awaits an in-flight start. Update the party-scoped NOTE.
- `use-cadre.ts`: mount load → `savedStartOptions`, `optsRef`, auto-start, read-fault error.
- `push-wake-native.ts` / `push-wake.ts`: `ensureNode` from the saved record; comments.
- `app/settings.tsx`: prefill from `savedStartOptions`; bootstrap field comma-split.
- `relay-config.ts` / `phone-node-config.ts` comments.
- Tests: `start-options.spec.ts`; `use-cadre.spec.ts` mock + converted test + mount auto-start test.
- Docs and the blocked ticket's line as above.
- `yarn workspace @serfab/reference-app-rn typecheck`, `yarn workspace @serfab/reference-app-rn test`, `yarn lint`.
