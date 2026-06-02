description: Review the @serfab/reference-app-ns chat UI (Chat + Settings tabs, NS-Core Observable view models replacing the RN hooks, connect/seed/create-strand/poll-chat) built at reference-app-rn parity. Agent gates (typecheck/lint/bundle) are green; device/emulator runtime — NS data-binding, TabView, the poll loop, connect-to-drone, seed apply, bidirectional replication — is NOT agent-verified (no emulator + native SQLite/WebSocket plugins). That runtime coverage is the seq-6 reference-app-ns-e2e ticket.
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/app/chat/chat-page.xml, packages/reference-app-ns/app/chat/chat-page.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/app/settings/settings-page.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/app-root.xml, packages/reference-app-ns/app/app.css, packages/reference-app-ns/app/app.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/README.md
----

## What landed

The **chat-connect UI** for `@serfab/reference-app-ns`, at functional parity with
`reference-app-rn`: a **Chat** screen and a **Settings** screen, two NativeScript
`Observable` view models replacing the RN hooks, and a two-tab `TabView` shell. The
heavy cadre/db-p2p/Quereus graph is now pulled in through the new view models
(cadre-vm → cadre-phone), not the deleted solo-smoke page.

### Parity map (RN → NS)

| reference-app-rn | reference-app-ns | Notes |
|---|---|---|
| `src/use-cadre.ts` + `src/cadre-context.tsx` | `src/cadre-vm.ts` (`CadreViewModel`, `getCadreVm()` singleton) | Holds the one `CadreNode`; `status`/`peerId`/`strands` + `start`/`stop`/`applySeed`/`dialPeer`/`createStrand`; subscribes to `strand:started|stopped|error` and refreshes the strand map. |
| `src/use-chat.ts` | `src/chat-vm.ts` (`ChatViewModel`, `getChatVm()` singleton) | Polls `queryMessages`/`queryMembers` every 2000 ms (`ObservableArray` rows); optimistic append on `send`; `insertMember` auto-register on first attach; reads active strand + peerId from the cadre VM. |
| `src/test-ids.ts` | `src/test-ids.ts` (ported) | Same string constants, surfaced via NS `automationText` (→ iOS accessibilityIdentifier / Android content-desc) instead of RN `testID`. |
| `app/settings.tsx` | `app/settings/settings-page.{xml,ts}` + `settings-view-model.ts` | Party ID / bootstrap / Connect / Disconnect / Add-Peer / Seed paste+Apply / Create Strand / PeerId display / in-page status-modal overlay. Page-local input + modal state live in `SettingsViewModel`; node state stays in the shared `cadre-vm`. |
| `app/index.tsx` | `app/chat/chat-page.{xml,ts}` | Status bar, message `ListView`, composer (input + Send); poll loop started/stopped by the page lifecycle. |
| `app/_layout.tsx` (Expo Router tabs) | `app/app-root.xml` (`TabView` Chat + Settings, each a `Frame defaultPage`) | |

### Phase 4 (connect path) — already present from the runtime ticket

`cadre-phone.ts` already exported `startPhoneNode({ partyId, bootstrapAddrs })`
(passes `bootstrapAddrs` → `controlNetwork.bootstrapNodes`), `applySeed`,
`decodeSeed`, and `dialPeer` (WebSocket + circuitRelay transports, `listenAddrs: []`).
This ticket **wired** them through the VM/UI and did not need to extend the file.
Note the seed-apply signature difference vs RN: NS `cadre-phone.applySeed` takes a
`ControlNetworkSeed` object, so `CadreViewModel.applySeed(encoded)` decodes first
(`node.decodeSeed(encoded)` → `node.applySeed(seed)`), matching the RN hook's
string-in contract and checking `result.success`.

### Other

- `app/app-root.xml` switched from `Frame → main/main-page` to the `TabView`.
- Deleted the obsolete solo-smoke page (`app/main/*`). `src/solo-smoke.ts` is kept
  as a programmatic solo/forming helper (still typechecked; no longer in the UI path
  nor, therefore, the bundle — the graph is now reached via the new VMs).
- `app/app.css` rewritten as a shared dark theme; `app.ts` entry comment updated;
  README "Layout" + "Device smoke" sections rewritten for the new UI.

## Validation

### Agent gates — all green (re-run after the final edit)

```
yarn workspace @serfab/reference-app-ns typecheck     # exit 0
yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app   # 0 problems
yarn workspace @serfab/reference-app-ns test:bundle    # 0 errors, 22 warnings
```

- **Bundle**: 0 errors, **22 warnings** — byte-identical to the runtime ticket's
  documented upstream skew (gossipsub/autonat `StrictSign`/`StrictNoSign`/
  `TopicValidatorResult`/`streamMessage`), not app code. The new UI did **not**
  introduce new warnings.
- **Graph reached through the new code**: grepped the emitted `bundle.js` — the
  cadre/libp2p graph (the 22 warnings) is only reachable via cadre-vm → cadre-phone,
  and `ChatViewModel`/`SettingsViewModel`/`message-row-`/`Create Chat Strand`/
  `Not connected — go to Settings` are all present in the output. So the screens are
  registered and bundled, not tree-shaken.

### NOT verified — device/emulator runtime (honest gaps, owned by reference-app-ns-e2e)

No Android emulator and no native `@nativescript-community/sqlite` /
`@valor/nativescript-websockets` plugins are available to the agent, so **nothing
below ran**. These are NS-runtime behaviors a webpack compile + tsc cannot prove:

1. **NS data-binding resolution** — nested `{{ cadre.* }}` paths, `visibility`
   bindings (`'visible'`/`'collapse'`), two-way `text` on `TextField`/`TextView`,
   `isEnabled` bindings, `Repeater items="{{ cadre.strandItems }}"`, and the
   per-row `automationText="{{ rowId }}"` in the `ListView` item template.
2. **`TabView` navigation** — both `Frame defaultPage` pages loading, `navigatingTo`
   setting `bindingContext`, and the Chat poll loop start/stop on tab switch. (Also:
   TabView tab-strip + per-page `ActionBar` may render two title rows — cosmetic,
   flagged for the e2e/reviewer to confirm/adjust.)
3. **The 2 s poll loop** actually firing on V8/JSC (`setInterval`/`clearInterval`)
   and `ObservableArray.splice` reconciling optimistic vs polled rows without
   flicker/dupes.
4. **Connect-to-drone** over WebSocket + circuit relay (`startPhoneNode` with a real
   bootstrap multiaddr), control-network convergence, and the status flip to
   connected.
5. **Seed apply** (`decodeSeed` + `applySeed`) and **dialPeer** against a live node.
6. **Bidirectional replication** — a drone-side insert appearing in the list within
   ~5 s, and an app-sent message visible on the drone.

## How the reviewer / e2e should test

Device/emulator (the real gate), mirroring RN's `maestro/_setup.yaml`:

1. **Settings** tab → leave Party ID blank → **Connect** → status flips to
   *Connected*, **Peer ID** shown (`automationText=value-peer-id`).
2. **Create Chat Strand** → "Strand created" modal (`automationText=modal-title`,
   OK = `btn-modal-ok`); the Strands repeater shows the new strand + status.
3. **Chat** tab → type `hello` → **Send** (`btn-send`) → row appears in
   `message-list` (local echo, `message-row-<id>`).
4. **Against the drone fixture** (`reference-app-ns-e2e`): enter the drone Party ID +
   bootstrap multiaddr before Connect; then **Apply Seed**; a drone-side HTTP insert
   appears in the list within ~5 s; an app-sent message is visible on the drone.

### Things worth a close review

- **`cadre-vm` derived-prop fan-out**: every getter bound in XML
  (`connectedVisibility`/`disconnectedVisibility`/`notConnecting`/`strandItems`/…)
  is notified from a `setStatus`/`setStrands`/`setPeerId`/`setError` mutator. Confirm
  no bound property is missing a `notifyPropertyChange` (would silently stop updating
  on device).
- **`chat-vm` status liveness**: the chat status bar / composer-enabled state track
  cadre changes via a `cadre.on(propertyChangeEvent, …)` subscription on the
  singleton. Confirm that's sufficient and not racy with the poll loop.
- **Member re-registration**: `chat-vm.attach()` resets the `registered` guard when
  the strand instance changes (reconnect), matching RN's per-strand effect.
- **TabView default-tab UX**: Chat is index 0, so the app opens disconnected on Chat
  ("Not connected — go to Settings", input disabled) until the user connects on
  Settings — intended, but verify it reads sensibly on device.

## Disposition

Code-complete and green on every gate reachable without a device. The open risk is
purely NS-runtime execution (binding/TabView/poll/connectivity), structurally out of
the agent's reach and owned by `reference-app-ns-e2e` (seq 6). No pre-existing test
failures encountered.
