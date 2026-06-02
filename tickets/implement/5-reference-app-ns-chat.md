description: Build the @serfab/reference-app-ns chat UI at RN parity — chat screen + settings/connect screen, view models for cadre/chat lifecycle, connect-to-drone over WebSocket+circuit-relay, seed apply, create strand, and bidirectional poll-based chat.
prereq: reference-app-ns-runtime
files: packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/app/settings.tsx, packages/reference-app-rn/src/use-chat.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-context.tsx, packages/reference-app-rn/src/test-ids.ts, packages/reference-app-rn/src/cadre-phone.ts, docs/reference-app-rn.md
----

## Goal

With the runtime proven (`reference-app-ns-runtime`), build the **UI and connectivity** at
functional parity with reference-app-rn: a **chat screen** and a **settings/connect screen**,
NativeScript-Core view models replacing the RN hooks, and the full connect→seed→create-strand→chat
flow against the drone. Poll-based replication (every ~2s) is acceptable, matching RN/web.

This is **NativeScript Core** (decided in the runtime ticket): plain TypeScript code-behind +
XML views, no UI framework.

## Functional requirements (parity with reference-app-rn)

- **Connect to a drone**: enter Party ID + bootstrap multiaddr
  (`/ip4/<ip>/tcp/4002/ws/p2p/<peerId>`), dial outbound over WebSocket + circuit relay, join the
  control network, converge the shared strand. (`cadre-phone.ts` `dialPeer` / `startPhoneNode`.)
- **Seed bootstrap**: paste a base64url-encoded seed and apply it (`decodeSeed` + `applySeed`),
  mirroring the RN Settings screen.
- **Create strand**: `createChatStrand(node, uuid())` (already ported in the runtime ticket).
- **Chat**: insert messages into the strand's Quereus DB and display the message list, polling
  every ~2s; the drone replicates bidirectionally.
- **Stable peer identity** across restarts (already handled via `loadOrCreateNSPeerKey` in the
  runtime ticket — surface the PeerId on the settings screen).
- **Screens**: chat + settings/connect, matching the RN surface
  (`app/index.tsx` chat, `app/settings.tsx` connect / apply seed / create strand / add peer).

## Design

### Screens & navigation

A two-tab layout (NativeScript `BottomNavigation`/`Tabs`, or a simple Frame with a nav button):
**Chat** and **Settings**. Reproduce the RN surface element-for-element so the e2e flows
(`reference-app-ns-e2e`) can drive identical interactions.

- **Settings** (`app/settings/*`): Party ID input, bootstrap addr input, Connect / Disconnect
  buttons, seed input + Apply Seed, add-peer input + button, Create Strand button, a status
  modal (title + OK) for "Seed applied" / "Strand created", and the local PeerId display.
- **Chat** (`app/chat/*`): status bar (e.g. "Connected · strand <id>"), message list, message
  input, send button.

### View models (replace RN hooks)

The RN app uses React hooks + context (`use-cadre.ts`, `use-chat.ts`, `cadre-context.tsx`).
Re-implement as NativeScript `Observable`-based view models / a shared singleton service:

- **`cadre-vm.ts`** ← `use-cadre.ts` + `cadre-context.tsx`: holds the single `CadreNode`
  (`getPhoneNode()` from `cadre-phone.ts`), exposes `status` (`idle|connecting|connected|error`),
  `peerId`, `strands`, and actions `start(opts)`, `stop()`, `applySeed(encoded)`, `dialPeer(addr)`,
  `createStrand(strandId)`. Subscribe to `strand:started`/`stopped`/`error` events from the node
  and refresh the strand map (same events the RN app listens to).
- **`chat-vm.ts`** ← `use-chat.ts`: given a strand + memberId, polls `queryMessages` every ~2s
  (`pollIntervalMs` default 2000), exposes `messages`/`members`/`loading`/`error`, `send(content)`
  (optimistic append then refresh), and auto-registers the local member via `insertMember` on first
  attach. Use `chat-operations.ts` from the runtime ticket.

Keep the singleton-CadreNode pattern (one node shared across both screens), as RN's
`cadre-context` does.

### Connect flow (reuse cadre-phone.ts)

`cadre-phone.ts` (runtime ticket) already provides the CadreNode config with
`transports: [webSockets(), circuitRelayTransport()]`, `listenAddrs: []`. This ticket adds the
distributed path: `startPhoneNode({ partyId, bootstrapAddrs })`, `applySeed`, `dialPeer`,
`createStrand`. The status indicator turns "connected" once the control network syncs; the
strand status reflects the joined strand.

## Key tests / expected outputs (TDD intent)

- **Manual device smoke** (out-of-band, against the drone fixture from `reference-app-ns-e2e`):
  Settings → enter Party ID + bootstrap addr → Connect → status connected; Apply Seed → "Seed
  applied" modal; Create Strand → "Strand created" modal; Chat → send "hello" → appears in list
  (local echo). This is the same sequence as RN's `maestro/_setup.yaml`.
- **Bidirectional**: a drone-side insert (via the fixture's HTTP sidecar) appears in the app's
  message list within ~5s; an app-sent message is visible on the drone.
- View-model unit-ish checks where practical (poll cadence, optimistic append, member
  auto-registration) — but the authoritative coverage is the Maestro e2e in the next ticket.

## TODO

### Phase 1 — view models
- Implement `src/cadre-vm.ts` (Observable) wrapping the `cadre-phone.ts` singleton: `start`,
  `stop`, `applySeed`, `dialPeer`, `createStrand`, `status`, `peerId`, `strands`; subscribe to
  node strand events.
- Implement `src/chat-vm.ts` (Observable): poll loop (~2s), `send` (optimistic), `insertMember`
  auto-register, `messages`/`members`/`loading`/`error`.

### Phase 2 — settings screen
- `app/settings/*` (XML + code-behind) with Party ID / bootstrap / Connect / Disconnect / seed
  input + Apply Seed / add-peer / Create Strand / status modal / PeerId display, bound to `cadre-vm`.

### Phase 3 — chat screen
- `app/chat/*` (XML + code-behind): status bar, message list (bound to `chat-vm.messages`),
  message input, send button. Two-tab navigation between Chat and Settings.

### Phase 4 — wire connect path in cadre-phone.ts
- Ensure `startPhoneNode({ partyId, bootstrapAddrs })`, `applySeed(encoded)`, `dialPeer(addr)`
  are implemented (extend the solo-only version from the runtime ticket).

### Phase 5 — validate
- `yarn workspace @serfab/reference-app-ns test:bundle` still passes with the UI added.
- Typecheck the package; no `any`, lowercase SQL, tabs.
- Note in the review handoff which flows were device-smoked vs deferred (full automated coverage
  is `reference-app-ns-e2e`).
