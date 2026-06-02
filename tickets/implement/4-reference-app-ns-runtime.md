description: Scaffold @serfab/reference-app-ns (NativeScript Core) and prove the cadre/db-p2p/Quereus/Optimystic stack bundles and boots solo under NativeScript's V8/JSC runtime — webpack Node-shimming, the polyfill set, WebSocket transport, SQLite storage, and a bundle-only smoke target.
prereq:
files: packages/reference-app-rn/metro.config.js, packages/reference-app-rn/polyfills/, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/index.js, ../optimystic/packages/db-p2p-storage-ns/, ../optimystic/packages/db-p2p/package.json (exports), packages/cadre-core/src/types.ts, packages/cadre-core/package.json (exports), package.json (root resolutions), docs/reference-app-rn.md
effort: xhigh
----

## Goal

Stand up the new workspace package `packages/reference-app-ns` (`@serfab/reference-app-ns`)
as a **NativeScript Core** app, and get the full Sereus/Optimystic stack to *bundle and boot
in solo/forming mode* on a device/emulator: create a local chat strand and send/echo a
message locally, with **no drone and no network**. This ticket is the runtime-validation
core — the riskiest part of the parity effort — and is a standalone milestone. Chat-connect
UI and e2e are split into the dependent tickets `reference-app-ns-chat` and
`reference-app-ns-e2e`.

## Resolved design decisions (from the plan stage)

These close the plan ticket's "Open questions". Implementers should treat them as settled;
the per-decision verification work lives in the TODO list.

### UI framework → NativeScript Core (plain TS + XML), not Svelte Native

The dev suggested Svelte Native, but it is **not viable**: the original `halfnelson/svelte-native`
repo was archived (Mar 2025); the community fork `@nativescript-community/svelte-native` does
**not support Svelte 5** (reference-app-web is on Svelte 5, so there is no shared mental model
to gain) and was last published ~a year ago. For an app whose entire purpose is validating the
*runtime*, not the UI, taking a stale, Svelte-4-only framework dependency is the wrong risk.
The UI is two trivial screens driven by stable test IDs — **NativeScript Core** (plain
TypeScript + XML views, officially supported, zero UI-framework version risk, minimal dependency
surface) is the lowest-risk parity path. `nativescript-vue` is a documented fallback if Core's
ergonomics prove painful, but Core is the default.

### Storage → reuse the existing `@optimystic/db-p2p-storage-ns`

`@optimystic/db-p2p-storage-ns` **already exists** in the sibling optimystic repo
(`../optimystic/packages/db-p2p-storage-ns`) and is complete: `SqliteRawStorage` (implements
`IRawStorage`), `SqliteKVStore`, `openOptimysticNSDb(name, version)`, and
`loadOrCreateNSPeerKey(db, keyName='peer-private-key')`. It is SQLite-backed via the peer
dependency `@nativescript-community/sqlite@^3.5.0`. **No new storage backend is needed** — this
ticket only wires it in and adds the root `resolutions` link. The schema DDL
(`metadata`/`revisions`/`pending`/`transactions`/`materialized`/`kv` tables) and WAL pragmas
are applied by `openOptimysticNSDb`.

**Async-open vs sync provider factory.** `CadreNodeConfig.storage.provider` is
`IRawStorage | ((strandId) => IRawStorage)` — a *synchronous* factory. The RN app gets away with
a sync factory because `rn-leveldb` opens synchronously; `openOptimysticNSDb` is **async**, so a
sync factory cannot open it. Recommended approach: a small **lazy proxy `IRawStorage`** per
strand — `provider: (strandId) => makeLazyNsStorage(strandId)` returns a proxy whose every
(already-async) method `await`s a cached `openOptimysticNSDb(\`sereus-${strandId}\`)` promise
before delegating to the real `SqliteRawStorage`. This preserves the RN app's per-strand storage
isolation and sidesteps the sync/async mismatch in ~40 lines. (Sharing one DB instance across
all strands is *not* recommended unless block-id global-uniqueness across networks is proven.)

### JS-engine polyfill surface (re-audited for V8/JSC, do NOT assume the Hermes set)

NativeScript 8.8 already provides (confirm the project's NS version is ≥ 8.8): `crypto.getRandomValues`,
`crypto.randomUUID`, `crypto.subtle.generateKey/sign/verify` (HMAC, RSA-OAEP), `btoa`/`atob`,
and `TextEncoder`. The stack still needs the following, which NS does **not** reliably provide —
port adapted versions of the RN polyfills (`packages/reference-app-rn/polyfills/`) but re-verify
each with a `typeof` guard so they no-op where the runtime already has them:

| API | Status under NS | Source to port |
|-----|-----------------|----------------|
| `crypto.subtle.digest` | **Missing in 8.8** (only generateKey/sign/verify) — required by `multiformats/hashes/sha2-browser` | `polyfills/hermes.js` digest shim via `@noble/hashes/sha2` |
| `TextDecoder` | Not guaranteed | `polyfills/hermes.js` UTF-8 fallback |
| `structuredClone` | Not guaranteed | `@ungap/structured-clone` |
| `ReadableStream`/`WritableStream`/`TransformStream` | Not guaranteed | `web-streams-polyfill` |
| `Promise.withResolvers` | V8/JSC-version dependent | `polyfills/hermes.js` shim |
| `AbortSignal.prototype.throwIfAborted` | Not guaranteed | `polyfills/hermes.js` shim |
| timer `.ref()`/`.unref()` | NS timers are numeric | port the RN wrapper + `clearTimeout`/`clearInterval` unwrap |
| `EventTarget`/`Event`/`CustomEvent` | Partial | `event-target-polyfill` + `CustomEvent` shim (`polyfills/event.js`) |
| `Intl.PluralRules` | Not guaranteed | `polyfills/intl-pluralrules.js` (English-only, for moat-maker) |
| `globalThis.Buffer` | Missing | npm `buffer`, set global like reference-app-web's `polyfills.ts` |

`crypto.getRandomValues` is **native** on NS 8.8 — do not polyfill it (no `react-native-get-random-values`
equivalent needed). Do an at-boot `typeof` audit (log a one-line table of which globals are
native vs polyfilled) to make the real V8/JSC surface visible and catch regressions.

### WebSocket transport → `@valor/nativescript-websockets` (connectivity linchpin)

NativeScript has **no global `WebSocket`**. `@libp2p/websockets` needs one. Add
`@valor/nativescript-websockets` (polyfills a web-compatible global `WebSocket` for Android+iOS,
RN-derived) and import it **first** in the entry, before any libp2p code. Also ensure webpack
resolves the **browser** build of `@libp2p/websockets` (not the `ws`/Node variant) — see the
`conditionNames` note below. This ticket only needs the transport to *exist and bundle*; actual
dialing is exercised in `reference-app-ns-chat`/`-e2e`, but smoke-verify a `new WebSocket(...)`
constructs at boot.

### Bundler / Node-builtin shimming → `@nativescript/webpack` (webpack 5)

NativeScript builds via `@nativescript/webpack`, not Metro/Vite. Reproduce the RN Metro
resolver behaviour (`packages/reference-app-rn/metro.config.js`) in `webpack.config.js`:

- **`resolve.fallback`** for Node builtins: `os`/`node:os`, `net`/`node:net`, `tls`/`node:tls`
  → `false` (or an `empty.js` shim); `stream`/`node:stream` → `readable-stream`;
  `buffer`/`node:buffer` → `buffer`; `crypto`/`node:crypto` → a **custom shim** implementing only
  `createHash` (SHA-256/512 via `@noble/hashes`), ported from `polyfills/node-crypto.js`. Do **not**
  blanket-polyfill `crypto` with `crypto-browserify`.
- **`resolve.conditionNames`** must include `'react-native'` so `@optimystic/db-p2p` and
  `@serfab/cadre-core` resolve their `react-native` export condition. For db-p2p that is
  `./dist/src/rn.js` (the TCP-free entrypoint) — *critical*, otherwise `@libp2p/tcp` is pulled in
  and bundling/booting fails. Also include `'browser'` so `@libp2p/websockets` and friends pick
  their browser variants. (Alternatively, alias `@optimystic/db-p2p` → `@optimystic/db-p2p/rn`
  explicitly; the `./rn` subpath export exists.)
- **`@libp2p/crypto` browser rewrite** (the same one that is critical on RN — see
  `docs/reference-app-rn.md` § "libp2p/crypto Node → browser rewrite"): the package ships
  `*.browser.js` variants (Ed25519/secp256k1/RSA/ECDH keys, webcrypto, hmac, aes-gcm) that use
  `@noble/curves` + WebCrypto instead of Node `crypto`. Port the Metro `resolveRequest` logic
  (read `@libp2p/crypto`'s `package.json` `browser` map, rewrite resolved paths) into a webpack
  `NormalModuleReplacementPlugin` or `resolve.alias` set generated from that map. Without it, the
  first `generateKeyPair('Ed25519')` (peer identity) throws.

### Build/CI tooling → bundle-only smoke target is the agent-runnable gate

Full device builds (`ns build android|ios`) and Maestro require local native tooling
(Android SDK / Xcode) and routinely exceed the 10-minute agent idle budget — those are
**out-of-band / human / CI**, not agent-runnable. The agent-runnable gate is a **bundle-only
smoke**: `ns prepare android` runs the webpack compile (resolving the whole import graph) without
a device build, analogous to the RN app's `yarn test:bundle` (`expo export`). Wire this as
`test:bundle` and stream its output (`| tee`). It catches import-resolution failures — exactly
the failure mode this ticket is most likely to hit.

## Package shape (target)

```
packages/reference-app-ns/
  package.json              # @serfab/reference-app-ns, workspace deps, scripts (test:bundle)
  nativescript.config.ts    # id: org.gotchoices.sereus.chat.ns (or similar), main: app/app.ts
  webpack.config.js         # node fallbacks + conditionNames + @libp2p/crypto browser rewrite
  tsconfig.json
  app/
    app.ts                  # ENTRY: import polyfills + @valor/nativescript-websockets FIRST, then app
  src/
    polyfills/              # ported & re-audited: hermes.ts, event.ts, intl-pluralrules.ts,
                            #   node-crypto.ts, node-os.ts, empty.ts, buffer-global.ts
    cadre-phone.ts          # CadreNode singleton (NS storage provider, WS transports, seed)
    ns-storage.ts           # makeLazyNsStorage(strandId) lazy IRawStorage proxy
    chat-strand.ts          # ported pure-TS from reference-app-rn/src/chat-strand.ts
    chat-operations.ts      # ported pure-TS from reference-app-rn/src/chat-operations.ts
```

(UI screens, view models, and test IDs land in `reference-app-ns-chat`.)

## CadreNode config (mirror the RN phone, NS storage)

```typescript
const config: CadreNodeConfig = {
  privateKey,                       // loadOrCreateNSPeerKey(identityDb) — key 'peer-private-key'
  controlNetwork: { partyId, bootstrapNodes: bootstrapAddrs },
  profile: 'transaction',
  storage: { provider: (strandId) => makeLazyNsStorage(strandId) },
  network: {
    transports: [webSockets(), circuitRelayTransport()],
    listenAddrs: [],                // NS client cannot listen
  },
  strandFilter: { mode: 'all' },
  hibernation: { enabled: false },
};
```

For solo boot, `bootstrapNodes: []`. `chat-strand.ts`'s `createChatStrand(node, uuid())` +
`chat-operations.ts`'s `insertMessage` / `queryMessages` drive the local-echo smoke.

## Key tests / expected outputs (TDD intent for later phases)

- **`yarn workspace @serfab/reference-app-ns test:bundle`** → webpack compile succeeds, whole
  import graph resolves (db-p2p resolves `rn.js`, no `@libp2p/tcp`, `@libp2p/crypto` browser
  variants selected). Expected: exit 0, no "Module not found" / "cannot be used as a constructor".
- **At-boot polyfill audit** → logs a table; `crypto.subtle.digest`, `structuredClone`,
  `WebSocket`, streams, `Promise.withResolvers`, `AbortSignal.throwIfAborted` all present
  (native or polyfilled) before any libp2p import runs.
- **Solo smoke (device/emulator, manual / out-of-band)** → boot CadreNode with no network,
  `createChatStrand`, `insertMessage('hello')`, `queryMessages()` returns the message. Stable
  PeerId across two cold launches (key persisted in SQLite `kv` under `peer-private-key`).

## TODO

### Phase 1 — workspace scaffold
- Create `packages/reference-app-ns` with `package.json` (`@serfab/reference-app-ns`, `private`,
  `installConfig.hoistingLimits: workspaces`), `nativescript.config.ts`, `tsconfig.json`.
- Add deps: `@serfab/cadre-core` (`workspace:^`), `@optimystic/db-p2p`,
  `@optimystic/db-p2p-storage-ns`, `@quereus/quereus`, `@libp2p/websockets`,
  `@libp2p/circuit-relay-v2`, `@valor/nativescript-websockets`,
  `@nativescript-community/sqlite`, `@noble/hashes@^2.0.0`, `@ungap/structured-clone`,
  `buffer`, `event-target-polyfill`, `readable-stream`, `web-streams-polyfill`,
  `@nativescript/core`, `@nativescript/webpack`, `@nativescript/types` (dev), `typescript`.
- Add root `package.json` `resolutions`:
  `"@optimystic/db-p2p-storage-ns": "link:../optimystic/packages/db-p2p-storage-ns"`.
- Confirm `packages/*` glob picks up the new package; `yarn install` succeeds.

### Phase 2 — webpack + Node shimming
- Author `webpack.config.js` extending `@nativescript/webpack`: `resolve.fallback`
  (os/net/tls→false, stream→readable-stream, buffer→buffer, crypto→custom shim);
  `resolve.conditionNames` += `'react-native'`, `'browser'`.
- Port the `@libp2p/crypto` browser-map rewrite from `metro.config.js` to webpack
  (`NormalModuleReplacementPlugin` or generated `resolve.alias`).
- Verify db-p2p resolves `dist/src/rn.js` (no `@libp2p/tcp` in the bundle).

### Phase 3 — polyfills + WebSocket
- Port & re-audit polyfills into `src/polyfills/` (hermes, event, intl-pluralrules, node-crypto,
  node-os, empty, buffer-global) with `typeof` guards. **Drop `getRandomValues` polyfill** (native
  on NS 8.8). Keep the `subtle.digest` shim (NS lacks it).
- Wire `app/app.ts` entry to import polyfills + `@valor/nativescript-websockets` **before** any
  libp2p/cadre import. Add the at-boot polyfill-audit log.

### Phase 4 — storage + CadreNode + solo boot
- Implement `src/ns-storage.ts` `makeLazyNsStorage(strandId)` (lazy proxy over
  `openOptimysticNSDb` + `SqliteRawStorage`).
- Port `chat-strand.ts` and `chat-operations.ts` (pure TS) from reference-app-rn.
- Implement `src/cadre-phone.ts`: identity via `loadOrCreateNSPeerKey`, CadreNode config above,
  `startSolo()` / `createChatStrand` / `stop`.

### Phase 5 — bundle smoke + validate
- Add `test:bundle` script (`ns prepare android`) and run it streamed (`| tee`); fix all
  resolution failures until exit 0.
- Run `yarn workspace @serfab/cadre-core build` / typecheck the new package; ensure no `any`,
  lowercase SQL, tabs (.editorconfig).
- Document the solo device-smoke steps in the package `README.md` stub (full docs land in
  `reference-app-ns-e2e`). Note in the review handoff which steps were agent-run vs deferred
  to a device.
