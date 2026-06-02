# @serfab/reference-app-ns

NativeScript Core reference app whose purpose is **runtime validation**: proving
the full Sereus / Optimystic stack (`@serfab/cadre-core`, `@optimystic/db-p2p`,
`@quereus/quereus`, libp2p) bundles and boots under NativeScript's V8/JSC engine.

UI framework: **NativeScript Core** (plain TypeScript + XML) — not Svelte Native
(archived / Svelte-4-only) and not Vue. The UI is deliberately trivial; the value
is in the bundler config, polyfills, WebSocket transport, and SQLite storage.

> The full **chat-connect UI** (Chat + Settings tabs, connect over WebSocket +
> circuit relay, apply seed, create strand, poll-based bidirectional chat) landed
> with `reference-app-ns-chat` at parity with reference-app-rn. The automated
> Maestro e2e is the dependent `reference-app-ns-e2e` ticket. `src/solo-smoke.ts`
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
   Connect; messages then replicate bidirectionally.

## Storage

Reuses `@optimystic/db-p2p-storage-ns` (`SqliteRawStorage`, `openOptimysticNSDb`,
`loadOrCreateNSPeerKey`) — SQLite via the `@nativescript-community/sqlite` peer
dependency. Each strand gets its own `sereus-<strandId>` database; the peer identity
lives in `sereus-peer-identity`. Because `openOptimysticNSDb` is async but
`CadreNodeConfig.storage.provider` is a sync factory, `ns-storage.ts` returns a lazy
proxy that awaits a cached open before delegating (see that file).
