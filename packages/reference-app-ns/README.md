# @serfab/reference-app-ns

NativeScript Core reference app whose purpose is **runtime validation**: proving
the full Sereus / Optimystic stack (`@serfab/cadre-core`, `@optimystic/db-p2p`,
`@quereus/quereus`, libp2p) bundles and boots under NativeScript's V8/JSC engine.

UI framework: **NativeScript Core** (plain TypeScript + XML) — not Svelte Native
(archived / Svelte-4-only) and not Vue. The UI is deliberately trivial; the value
is in the bundler config, polyfills, WebSocket transport, and SQLite storage.

> This milestone covers **solo/forming mode only** (create a local chat strand,
> insert + echo a message — no drone, no network). Chat-connect UI and e2e land
> in the dependent tickets `reference-app-ns-chat` and `reference-app-ns-e2e`.

## Layout

```
app/
  app.ts            ENTRY: polyfills + @valor/nativescript-websockets FIRST, then audit + Application.run
  app-root.xml      Frame → main/main-page
  main/             minimal bootable page that drives the solo smoke
src/
  polyfills/        V8/JSC-audited globals (hermes, event, intl, node-crypto, node-os, buffer-global, audit)
  ns-storage.ts     makeLazyNsStorage(strandId) — lazy IRawStorage proxy over async openOptimysticNSDb
  cadre-phone.ts    CadreNode singleton (NS storage provider, WS transports, SQLite identity)
  chat-strand.ts    create/join chat strand (ported from reference-app-rn)
  chat-operations.ts insert/query members + messages (ported)
  solo-smoke.ts     startSolo → createChatStrand → insertMessage → queryMessages
webpack.config.js   node shims + react-native/browser conditions + @libp2p/crypto browser rewrite
nativescript.config.ts
```

## Scripts

| Script | What it does | Agent-runnable? |
|--------|--------------|-----------------|
| `yarn workspace @serfab/reference-app-ns typecheck` | `tsc --noEmit` across the new package + cadre-core/db-p2p/storage-ns/quereus types | yes |
| `yarn workspace @serfab/reference-app-ns test:bundle` | `ns prepare android` — runs the webpack compile, resolving the whole import graph (db-p2p → `rn.js`, no `@libp2p/tcp`, `@libp2p/crypto` browser variants) | yes (no device build) |
| `ns build android` / `ns build ios` | full native device build | **no** — needs local Android SDK / Xcode, out-of-band / CI |

## Solo device smoke (manual / out-of-band)

A real device or emulator is required (the SQLite + WebSocket plugins are native).

1. `yarn install` at the repo root.
2. `yarn workspace @serfab/reference-app-ns android` (`ns run android`) with an
   emulator running, or `ns run ios` on macOS.
3. On boot, the **polyfill audit** logs a table to the device console (`✓ native ·
   ∙ polyfilled · ✗ missing`). Confirm nothing is `✗` before libp2p loads.
4. Tap **Run solo smoke**. Expected: `✓ Local echo OK — 1 message(s)` with a stable
   PeerId. Relaunch cold and confirm the **same PeerId** (identity persisted in the
   SQLite `kv` table under `peer-private-key`).

## Storage

Reuses `@optimystic/db-p2p-storage-ns` (`SqliteRawStorage`, `openOptimysticNSDb`,
`loadOrCreateNSPeerKey`) — SQLite via the `@nativescript-community/sqlite` peer
dependency. Each strand gets its own `sereus-<strandId>` database; the peer identity
lives in `sereus-peer-identity`. Because `openOptimysticNSDb` is async but
`CadreNodeConfig.storage.provider` is a sync factory, `ns-storage.ts` returns a lazy
proxy that awaits a cached open before delegating (see that file).
