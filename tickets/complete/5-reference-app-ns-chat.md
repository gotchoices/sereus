description: Chat-connect UI for @serfab/reference-app-ns (Chat + Settings TabView, NS-Core Observable view models replacing the RN hooks, connect/seed/dial/create-strand/poll-chat) at reference-app-rn parity. Reviewed; agent gates green; runtime coverage deferred to reference-app-ns-e2e (seq 6).
files: packages/reference-app-ns/src/cadre-vm.ts, packages/reference-app-ns/src/chat-vm.ts, packages/reference-app-ns/src/test-ids.ts, packages/reference-app-ns/app/chat/chat-page.xml, packages/reference-app-ns/app/chat/chat-page.ts, packages/reference-app-ns/app/settings/settings-page.xml, packages/reference-app-ns/app/settings/settings-page.ts, packages/reference-app-ns/app/settings/settings-view-model.ts, packages/reference-app-ns/app/app-root.xml, packages/reference-app-ns/app/app.css, packages/reference-app-ns/app/app.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/README.md
----

## What landed

The **chat-connect UI** for `@serfab/reference-app-ns`, at functional parity with
`reference-app-rn`: a **Chat** screen and a **Settings** screen, two NativeScript
`Observable` view models replacing the RN hooks, and a two-tab `TabView` shell.

### Parity map (RN → NS)

| reference-app-rn | reference-app-ns |
|---|---|
| `src/use-cadre.ts` + `src/cadre-context.tsx` | `src/cadre-vm.ts` (`CadreViewModel`, `getCadreVm()` singleton) |
| `src/use-chat.ts` | `src/chat-vm.ts` (`ChatViewModel`, `getChatVm()` singleton) |
| `src/test-ids.ts` | `src/test-ids.ts` (ported; surfaced via NS `automationText`) |
| `app/settings.tsx` | `app/settings/settings-page.{xml,ts}` + `settings-view-model.ts` |
| `app/index.tsx` | `app/chat/chat-page.{xml,ts}` |
| `app/_layout.tsx` (Expo Router tabs) | `app/app-root.xml` (`TabView` Chat + Settings) |

The heavy cadre/db-p2p/Quereus graph is reached through cadre-vm → cadre-phone (the
deleted solo-smoke page is gone; `src/solo-smoke.ts` is retained as a programmatic
helper, still typechecked). `cadre-phone.ts` (`startPhoneNode`/`applySeed`/
`decodeSeed`/`dialPeer`) was wired through the VMs and did not need extending.

## Review findings

Adversarial pass over the implement diff (`git show ea14886`), read before the
handoff summary, then cross-checked against the RN originals (`use-cadre.ts`,
`use-chat.ts`, `settings.tsx`).

### Checked

- **Gates re-run after review edits — all green:**
  - `yarn workspace @serfab/reference-app-ns typecheck` → exit 0
  - `yarn eslint packages/reference-app-ns/src packages/reference-app-ns/app` → 0 problems
  - `yarn workspace @serfab/reference-app-ns test:bundle` → 0 errors, 22 warnings
    (byte-identical upstream gossipsub/autonat skew documented by the runtime
    ticket; the chat UI introduced none).
- **Dangling references:** `git grep` for `main/main` / `main-page` /
  `main-view-model` / `app/main` across the package → none. The deleted solo-smoke
  page leaves no orphan imports.
- **Parity, behavior:** cadre-vm reproduces use-cadre's start/stop/applySeed/
  dialPeer/createStrand contract (string-in seed → `decodeSeed`+`applySeed`,
  `result.success` check), adopt-running-node-on-construct, and strand-event
  refresh. chat-vm reproduces use-chat's 2 s poll, optimistic append, and
  per-strand member re-registration guard. `settings-view-model` matches
  settings.tsx; it is in fact stricter than RN on connect failure (checks
  `cadre.status === 'error'` rather than relying on a catch that never fires,
  since `start()` swallows internally).
- **`notifyPropertyChange` fan-out (the flagged risk):** every XML-bound cadre
  getter (`connected*`/`disconnected*`/`notConnecting`/`peerIdDisplay`/
  `strandCount`/`strandItems`/…) is driven from a `setStatus`/`setPeerId`/
  `setStrands`/`setError` mutator. No bound property is missing a notification.
- **chat-vm status liveness:** the `cadre.on(propertyChangeEvent, …)` subscription
  is a single permanent listener on two app-lifetime singletons — no leak, and it
  updates `statusText`/`inputEnabled`/`canSend` on every cadre change.
- **test-id mapping:** RN's `addPeerBtn: 'btn-add-peer'` correctly maps to the NS
  **Dial Peer** button's `automationText="btn-add-peer"`; all other ids
  (`btn-connect`/`btn-apply-seed`/`btn-create-strand`/`value-peer-id`/`modal-*`/
  `message-row-<id>`/`message-list`/`input-*`) match RN one-for-one.
- **Docs:** README "Layout"/"Device smoke" sections accurately describe the new
  TabView UI and the Settings→Connect→Create Strand→Chat flow; the referenced
  `docs/reference-app-rn.md` § Two-Node Startup exists. `app.css` classes
  referenced from both XMLs are all defined.

### Found + fixed inline (minor)

- **Disabled-button parity gap.** RN gates *Dial Peer* (`disabled={!peerAddr.trim()}`)
  and *Apply Seed* (`disabled={!seedInput.trim()}`); the NS buttons had no
  `isEnabled` binding (handlers early-returned on empty, so functionally harmless,
  but the UX diverged). Added `canDialPeer`/`canApplySeed` getters to
  `settings-view-model.ts` (notified from the `peerAddr`/`seedInput` setters) and
  bound them as `isEnabled` in `settings-page.xml`. Re-ran all three gates → green.

### Found, NOT fixed — runtime, owned by reference-app-ns-e2e (seq 6)

These are NS-runtime behaviors a webpack compile + tsc cannot prove; none warranted
a new ticket (all are inside the existing e2e ticket's charter):

1. **Poll-loop list reconciliation.** `setMessages` does
   `ObservableArray.splice(0, len, ...rows)` every 2 s — replacing all elements
   fires one bulk change, so the `ListView` rebuilds every row rather than diffing.
   Possible flicker / scroll-jump on device; inherent to the polling design and
   acceptable for a reference app. Worth confirming visually in the e2e pass.
2. **Stale strand after disconnect/reconnect.** `chat-vm` only re-attaches while
   `this.strand` is null; after a disconnect the field still points at the stopped
   strand, so the next `refresh()` queries a closed DB and surfaces an error until a
   new strand attaches. Matches the per-strand-instance guard the implementer
   flagged; e2e to confirm the reconnect path.
3. **TabView poll start/stop.** Switching TabViewItems does not navigate the inner
   Frames, so `onNavigatingFrom`/`onUnloaded` may not fire on tab switch — the poll
   likely keeps running across tabs (probably desirable). Plus the possible
   double-title (TabView strip + per-page ActionBar). Cosmetic/behavioral, device-only.
4. **Modal not scrollable/selectable.** RN's alert modal wraps the message in a
   `ScrollView` with `selectable` text (to copy long peer ids / seeds); the NS modal
   is a plain `Label`. Cosmetic; the peer id is independently shown (and
   automation-tagged) in the Settings row.
5. **Unverified runtime** (no emulator + native SQLite/WebSocket plugins): NS
   data-binding resolution, the 2 s `setInterval` on V8/JSC, connect-to-drone over
   WebSocket + circuit relay, `decodeSeed`/`applySeed` + `dialPeer` against a live
   node, and bidirectional replication.

### Empty categories

- **Major findings → new tickets: none.** Every divergence from RN was either a
  trivial UX gap (fixed inline) or a runtime concern structurally out of agent reach
  and already scoped to `reference-app-ns-e2e`. Nothing required a fix/plan/backlog
  split.
- **Pre-existing test failures: none.** No `.pre-existing-error.md` written.

## How the e2e / human should test

Device/emulator (the real gate), mirroring RN's `maestro/_setup.yaml`:

1. **Settings** tab → blank Party ID → **Connect** → status *Connected*, **Peer ID**
   shown (`automationText=value-peer-id`).
2. **Create Chat Strand** → "Strand created" modal (`modal-title`, OK =
   `btn-modal-ok`); Strands repeater shows the new strand + status.
3. **Chat** tab → type `hello` → **Send** (`btn-send`) → row in `message-list`
   (`message-row-<id>`).
4. **Against the drone fixture:** enter drone Party ID + bootstrap multiaddr before
   Connect; **Apply Seed**; a drone-side insert appears within ~5 s; an app-sent
   message is visible on the drone.

## Disposition

Reviewed and code-complete; green on every gate reachable without a device. The one
minor parity gap found was fixed inline. Open risk is purely NS-runtime execution,
owned by `reference-app-ns-e2e` (seq 6).
