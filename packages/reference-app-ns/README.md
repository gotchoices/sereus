# @serfab/reference-app-ns

NativeScript Core reference app whose purpose is **runtime validation**: proving
the full Sereus / Optimystic stack (`@serfab/cadre-core`, `@optimystic/db-p2p`,
`@quereus/quereus`, libp2p) bundles and boots under NativeScript's V8/JSC engine.

UI framework: **NativeScript Core** (plain TypeScript + XML) — not Svelte Native
(archived / Svelte-4-only) and not Vue. The UI is deliberately trivial; the value
is in the bundler config, polyfills, WebSocket transport, and SQLite storage.

Full architecture — topology, the re-audited V8/JSC polyfill table, the webpack
resolver config, the startup order, and the testing strategy — is in
[`docs/reference-app-ns.md`](../../docs/reference-app-ns.md).

> The full **chat-connect UI** (Chat + Settings tabs, connect over WebSocket +
> circuit relay, apply seed, create strand, poll-based bidirectional chat) is at
> parity with reference-app-rn, and an automated **Maestro e2e** (`yarn … test:e2e`,
> see below) reuses the RN drone fixture + flows verbatim. `src/solo-smoke.ts`
> remains as a programmatic solo/forming-mode helper (no UI).

## Layout

```
app/
  app.ts            ENTRY: polyfills + @valor/nativescript-websockets FIRST, then audit + Application.run
  app-root.xml      TabView → Chat + Settings (each a Frame defaultPage)
  app.css           dark theme shared by both screens
  chat/             chat screen: status bar, message ListView, composer (binds getChatVm())
  settings/         settings screen: connect/seed/add-peer/create-strand/modal (SettingsViewModel → cadre-vm)
src/
  polyfills/        V8/JSC-audited globals (hermes, event, intl, node-crypto, node-os, buffer-global, audit)
  ns-storage.ts     makeLazyNsStorage(strandId) — lazy IRawStorage proxy over async openOptimysticNSDb
  cadre-phone.ts    CadreNode singleton (NS storage provider, WS transports, SQLite identity)
  cadre-vm.ts       CadreViewModel (Observable) — node lifecycle/status/strands (← use-cadre + cadre-context)
  chat-vm.ts        ChatViewModel (Observable) — poll loop, optimistic send, member auto-register (← use-chat)
  test-ids.ts       automationText constants shared with the e2e flows (ported from RN)
  chat-strand.ts    create/join chat strand (ported from reference-app-rn)
  chat-operations.ts insert/query members + messages (ported)
  solo-smoke.ts     startSolo → createChatStrand → insertMessage → queryMessages (programmatic)
webpack.config.js   node shims + react-native/browser conditions + @libp2p/crypto browser rewrite
nativescript.config.ts
```

## Scripts

| Script | What it does | Agent-runnable? |
|--------|--------------|-----------------|
| `yarn workspace @serfab/reference-app-ns typecheck` | `tsc --noEmit` across the new package + cadre-core/db-p2p/storage-ns/quereus types | yes |
| `yarn workspace @serfab/reference-app-ns test:bundle` | `node scripts/bundle-check.js` — webpack-only compile (no gradle), resolving the whole import graph (db-p2p → `rn.js`, no `@libp2p/tcp`, `@libp2p/crypto` browser variants). The analog of reference-app-rn's `expo export`. | yes |
| `yarn workspace @serfab/reference-app-ns test:bundle:native` | `ns prepare android` — the same webpack compile plus the gradle native-plugin build | **no** — needs local Android SDK / gradle |
| `yarn workspace @serfab/reference-app-ns test:e2e` | `node scripts/run-e2e.mjs` — spawns the RN drone fixture, `adb reverse`, runs the reused RN Maestro flows against the NS app | **no** — needs emulator + built APK + Maestro + adb (see Automated e2e) |
| `ns build android` / `ns build ios` | full native device build | **no** — needs local Android SDK / Xcode, out-of-band / CI |

## Device smoke (manual / out-of-band)

A real device or emulator is required (the SQLite + WebSocket plugins are native).

1. `yarn install` at the repo root.
2. `yarn workspace @serfab/reference-app-ns android` (`ns run android`) with an
   emulator running, or `ns run ios` on macOS.
3. On boot, the **polyfill audit** logs a table to the device console (`✓ native ·
   ∙ polyfilled · ✗ missing`). Confirm nothing is `✗` before libp2p loads.
4. **Settings** tab → leave Party ID blank (auto-generated) → **Connect**. The
   node boots solo; status flips to *Connected* and the **Peer ID** is shown.
5. **Create Chat Strand** → "Strand created" modal.
6. **Chat** tab → type `hello` → **Send**. Expect it to appear in the list (local
   echo). Relaunch cold and reconnect to confirm the **same Peer ID** (identity
   persisted in the SQLite `kv` table under `peer-private-key`).
7. Against a drone (see [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md)
   § Two-Node Startup): enter the drone's Party ID + bootstrap multiaddr before
   Connect. Then paste the drone's **enrollment invite** into *Paste enrollment
   invite (for trust)* along with the seed before **Apply Seed** — a cold phone
   has an empty trusted-owner anchor and otherwise rejects a seed signed by
   another cadre. Expect *Seed applied / Pinned 1 owner key(s)*. A **second**
   Apply Seed with the invite field blank must also succeed (the pin persisted).
   Messages then replicate bidirectionally.

### Two-node drone start (manual)

```bash
# Drone (Node.js) — listens on WebSocket so the phone can reach it
cd packages/cadre-cli
node dist/bin/cadre.js start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds --ws-port 4002
# → note the printed Peer ID, then build the bootstrap multiaddr:
#   /ip4/<LAN_IP>/tcp/4002/ws/p2p/<DRONE_PEER_ID>
```

On the phone's **Settings** tab: enter the drone's **Party ID**
(`reference-chat-party`) + that **bootstrap addr** → **Connect** → paste the seed
+ the drone's **enrollment invite** → **Apply Seed** → **Create Chat Strand**,
then chat on the **Chat** tab. The full
walk-through is shared with RN —
[`docs/reference-app-rn.md` § Two-Node Startup Sequence](../../docs/reference-app-rn.md#two-node-startup-sequence).

## Automated e2e (Maestro)

```bash
yarn workspace @serfab/reference-app-ns test:e2e
```

`scripts/run-e2e.mjs` **reuses reference-app-rn's drone fixture, HTTP sidecar,
Maestro flows, `_setup.yaml`, and `_helpers/*` verbatim** — they are
runtime-agnostic, so the only difference from an RN run is `MAESTRO_APP_ID`
(→ `org.gotchoices.sereus.chat.ns`). There are no duplicate flow files in this
package; see [`maestro/README.md`](maestro/README.md). The orchestrator spawns
the RN fixture, waits for `GET /health`, reads its `test-data.json`, sets up
`adb reverse tcp:4002`/`tcp:4080`, runs the three flows
(`1-connect-and-send`, `2-drone-to-phone`, `3-round-trip`), and tears down.

**Prerequisites (out-of-band — not agent-runnable):**

- a built NS APK installed on a running Android emulator
  (`ns build android` / `ns run android`; the SQLite + WebSocket plugins are
  native, so an emulator or device is mandatory)
- `adb` on PATH
- the [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro)
  on PATH

**One-time verification:** confirm Maestro's `id:` matcher resolves the NS
`automationText` values (Android `contentDescription` / iOS
`accessibilityIdentifier`) via Maestro Studio against a real build. If `id:`
matching is unworkable on NS, fall back to Appium — see
[`docs/reference-app-ns.md` § Testing strategy](../../docs/reference-app-ns.md#maestro-e2e-device--ci--out-of-band).

## Storage

Reuses `@optimystic/db-p2p-storage-ns` (`SqliteRawStorage`, `openOptimysticNSDb`,
`loadOrCreateNSPeerKey`) — SQLite via the `@nativescript-community/sqlite` peer
dependency. Each strand gets its own `sereus-<strandId>` database; the peer identity
lives in `sereus-peer-identity`. Because `openOptimysticNSDb` is async but
`CadreNodeConfig.storage.provider` is a sync factory, `ns-storage.ts` returns a lazy
proxy that awaits a cached open before delegating (see that file).
