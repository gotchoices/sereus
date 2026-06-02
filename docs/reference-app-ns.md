# Reference App: P2P Chat for NativeScript

This document describes the architecture for `packages/reference-app-ns`, a
NativeScript Core (plain TypeScript + XML) peer-to-peer chat app built on the full
Sereus/Optimystic stack. It is the **NativeScript sibling** of
[`reference-app-rn`](reference-app-rn.md) (React Native / Hermes) and
[`reference-app-web`](../packages/reference-app-web/README.md) (browser). Its
primary purpose is to prove the stack bundles and boots on NativeScript's **V8
(Android) / JSC (iOS)** engines — a JS runtime distinct from Hermes and from the
browser.

The application behaviour (Chat + Settings, connect → seed → create-strand →
chat, bidirectional drone replication) is at **functional parity** with the RN
app. This doc therefore focuses on what is *different* on NativeScript — the
runtime polyfill surface, the webpack resolver config, the startup order, and the
testing strategy — and links to [`reference-app-rn.md`](reference-app-rn.md) for
the protocol-level material the two apps share verbatim (seed bootstrap flow,
two-node startup sequence, chat schema, multi-party topology).

## Goals

1. **Platform validation** — prove cadre-core, db-p2p, Quereus, and libp2p work
   on NativeScript's V8/JSC runtime (a third JS engine after Hermes and the browser)
2. **Realistic P2P scenario** — form a true 2-party cadre (phone + drone) sharing
   a chat-sApp strand, identical to the RN reference
3. **Automated test target** — a Maestro e2e suite that **reuses** the RN drone
   fixture, HTTP sidecar, flows, and helpers (only the app id differs)

## Architecture Overview

```
┌──────────────────────────┐        WebSocket         ┌────────────────────────┐
│   reference-app-ns        │◄═══════════════════════►│      cadre-cli /        │
│   (Phone node)            │     + circuit relay      │   test-fixture (Drone) │
│                           │                          │                        │
│  NativeScript Core        │                          │  Node.js               │
│  V8 (Android) / JSC (iOS) │     libp2p protocols     │  cadre-core            │
│  cadre-core               │◄──────────────────────►│  db-p2p (TCP/WS)       │
│  db-p2p (rn.js entrypoint)│                          │  MemoryRawStorage      │
│  db-p2p-storage-ns (SQLite)│                         │  (fixture) / fs (cli)  │
│  quereus + Chat sApp      │     shared strand        │  Chat sApp schema      │
└──────────────────────────┘                          └────────────────────────┘
```

Both nodes are members of the same **cadre** (party) and share a **control
network** (`control-<partyId>`, cadre coordination) plus a **strand network**
(`strand-<strandId>`, chat sApp data). The phone connects outbound over WebSocket
+ circuit relay; the drone listens on WebSocket so a NAT'd phone can reach it.
This is the same topology as the RN app — see
[`reference-app-rn.md` § Node Topology](reference-app-rn.md#node-topology) and
[§ Seed Bootstrap Flow](reference-app-rn.md#seed-bootstrap-flow).

| Role | Runtime | Transport | Storage | Profile |
|------|---------|-----------|---------|---------|
| **Phone** | NativeScript Core (V8/JSC) | WebSocket + circuit relay | SQLite (`db-p2p-storage-ns`) | `transaction` |
| **Drone** | Node.js (`cadre-cli` / test-fixture) | TCP + WebSocket listener | File system / in-memory | `storage` |

### Storage

The phone uses `@optimystic/db-p2p-storage-ns` (`SqliteRawStorage`,
`openOptimysticNSDb`, `loadOrCreateNSPeerKey`) over the
`@nativescript-community/sqlite` native plugin. Each strand gets its own
`sereus-<strandId>` database; the peer identity (Ed25519 key, producing a stable
PeerId across cold launches) lives in `sereus-peer-identity`. Because
`openOptimysticNSDb` is async but `CadreNodeConfig.storage.provider` is a sync
factory, `src/ns-storage.ts` returns a lazy `IRawStorage` proxy that awaits a
cached open before delegating each call.

## App Structure

NativeScript Core (plain TS + XML), not Svelte Native or Vue. NS-Core
`Observable` view models replace the RN hooks; a two-tab `TabView` shell replaces
the Expo Router tabs.

```
app/
  app.ts            ENTRY: polyfills + @valor/nativescript-websockets FIRST, then audit + Application.run
  app-root.xml      TabView → Chat + Settings (each a Frame defaultPage)
  app.css           dark theme shared by both screens
  chat/             chat screen: status bar, message ListView, composer  (binds getChatVm())
  settings/         settings screen: connect/seed/dial-peer/create-strand/modal  (SettingsViewModel → cadre-vm)
src/
  polyfills/        V8/JSC-audited globals (buffer-global, hermes, intl-pluralrules, event, node-crypto, node-os, audit, registry)
  ns-storage.ts     makeLazyNsStorage(strandId) — lazy IRawStorage proxy over async openOptimysticNSDb
  cadre-phone.ts    CadreNode singleton (NS storage provider, WS transports, SQLite identity)
  cadre-vm.ts       CadreViewModel (Observable) — node lifecycle/status/strands  (← RN use-cadre + cadre-context)
  chat-vm.ts        ChatViewModel (Observable) — 2 s poll loop, optimistic send, member auto-register  (← RN use-chat)
  test-ids.ts       automationText constants shared with the e2e flows (ported from RN src/test-ids.ts)
  chat-strand.ts    create/join chat strand (ported from reference-app-rn)
  chat-operations.ts insert/query members + messages (ported)
  solo-smoke.ts     startSolo → createChatStrand → insertMessage → queryMessages (programmatic helper, no UI)
webpack.config.js   node shims + react-native/browser conditions + @libp2p/crypto browser rewrite + esbuild downlevel
nativescript.config.ts   id: org.gotchoices.sereus.chat.ns
```

### Parity map (RN → NS)

| reference-app-rn | reference-app-ns |
|---|---|
| `src/use-cadre.ts` + `src/cadre-context.tsx` | `src/cadre-vm.ts` (`CadreViewModel`, `getCadreVm()` singleton) |
| `src/use-chat.ts` | `src/chat-vm.ts` (`ChatViewModel`, `getChatVm()` singleton) |
| `src/test-ids.ts` (`testID`) | `src/test-ids.ts` (same strings, surfaced via `automationText`) |
| `app/settings.tsx` | `app/settings/settings-page.{xml,ts}` + `settings-view-model.ts` |
| `app/index.tsx` | `app/chat/chat-page.{xml,ts}` |
| `app/_layout.tsx` (Expo Router tabs) | `app/app-root.xml` (`TabView` Chat + Settings) |

## Startup Sequence

libp2p and its dependencies reference Web/Node globals **at import time**, so the
entry point (`app/app.ts`) loads polyfills and the WebSocket global before any
cadre/libp2p code. The heavy cadre/db-p2p/Quereus graph is pulled in lazily by the
Chat / Settings pages (via `cadre-vm` → `cadre-phone`) on navigation, after the
audit runs.

```ts
// app/app.ts
import '../src/polyfills';            // 1. buffer-global → hermes → intl-pluralrules → event
import '@valor/nativescript-websockets'; // 2. global WebSocket (@libp2p/websockets needs it)

import { Application } from '@nativescript/core';
import { runPolyfillAudit } from '../src/polyfills/audit';

runPolyfillAudit();                   // 3. log the real V8/JSC surface (native vs polyfilled vs ✗) before libp2p
Application.run({ moduleName: 'app-root' }); // 4. start the app (TabView)
```

The polyfill barrel (`src/polyfills/index.ts`) enforces the intra-polyfill order:
`buffer-global` (sets `globalThis.Buffer`) → `hermes` (runtime shims) →
`intl-pluralrules` → `event` (`EventTarget`/`Event`/`CustomEvent`).

## Runtime Polyfills (re-audited for V8/JSC)

Every shim in `src/polyfills/` is guarded by a `typeof` check and calls
`markPolyfilled(key)` only when it actually patches, so the at-boot audit
(`src/polyfills/audit.ts`) reports the **real** V8/JSC surface
(`✓ native · ∙ polyfilled · ✗ missing`) and a regression (an API silently going
missing on an NS upgrade) surfaces loudly at startup, before libp2p loads.

### V8/JSC vs Hermes — what changes

The headline difference from the RN/Hermes port: **NativeScript 8.8+ provides more
natively than Hermes does**, so several Hermes polyfills become no-ops here.

| API | NativeScript (V8/JSC) | Hermes (reference-app-rn) |
|-----|------------------------|----------------------------|
| `crypto.getRandomValues` | **native** | polyfilled (`react-native-get-random-values`, native CSPRNG) |
| `crypto.randomUUID` | **native** | n/a |
| `crypto.subtle.generateKey` / `sign` / `verify` | **native** | provided by the Hermes `crypto.subtle` shim |
| `crypto.subtle.digest` | **∙ polyfilled** (NS ships `subtle` *without* `digest`) | polyfilled (@noble/hashes) |
| `TextEncoder` | **native** | native (Hermes) |
| `TextDecoder` | **∙ polyfilled** if absent (UTF-8 only) | polyfilled (Expo SDK 52+ has it; bare RN does not) |
| `WebSocket` | **plugin** (`@valor/nativescript-websockets`) | native (RN) |

### Polyfilled on NativeScript (`src/polyfills/`)

| Global | File | Source | Required by | Notes |
|--------|------|--------|-------------|-------|
| `crypto.subtle.digest` | `hermes.ts` | @noble/hashes (SHA-256/512) | `multiformats/hashes/sha2-browser` | NS `subtle` has `generateKey`/`sign`/`verify` but **not** `digest`; only `digest` is added, the native subtle is preserved |
| `TextDecoder` | `hermes.ts` | hand-rolled UTF-8-only | `uint8arrays` (libp2p/multiformats/yamux, module scope) | throws `RangeError` for non-UTF-8 — kept tiny on purpose |
| `structuredClone` | `hermes.ts` | `@ungap/structured-clone` | `@optimystic/db-core` (transform tracker, cache-source, coordinator) | spec-compliant (Date/Map/Set/circular) |
| `Symbol.asyncIterator` | `hermes.ts` | `Symbol.for('Symbol.asyncIterator')` | `for await…of` on custom iterables | registry symbol so independent polyfills converge |
| `ReadableStream` / `WritableStream` / `TransformStream` | `hermes.ts` | `web-streams-polyfill` | streaming libraries | installed together when `ReadableStream` is absent |
| `Promise.withResolvers` | `hermes.ts` | inline | @libp2p/utils, yamux, it-queue, mortice, abort-error | ES2024, version-dependent on V8/JSC |
| `AbortSignal.prototype.throwIfAborted` | `hermes.ts` | inline | libp2p, it-pushable, p-retry, circuit-relay-v2 | DOM spec addition |
| Timer `.ref()` / `.unref()` | `hermes.ts` | object-wrap | @optimystic/db-p2p, undici, libp2p internals | NS timers return numbers; wraps the id in an object and patches `clear{Timeout,Interval}` to unwrap. Probes a real timer first and only wraps if native timers aren't already objects |
| `Buffer` (global) | `buffer-global.ts` | `buffer` (npm) | libp2p transitive deps reaching for the Node `Buffer` global | the webpack `buffer` *module* alias doesn't register a global |
| `CustomEvent` | `event.ts` | shim over `event-target-polyfill` | libp2p `safeDispatchEvent` | `event-target-polyfill` installs spec-complete `EventTarget`/`Event` but omits `CustomEvent` |
| `Intl.PluralRules` | `intl-pluralrules.ts` | English-only shim | moat-maker (ordinal error messages) | cardinal + ordinal English rules |

## Webpack Resolver Config

`webpack.config.js` reproduces the RN Metro resolver behaviour
(`reference-app-rn/metro.config.js`) so the same import graph bundles under
NativeScript. The NS build is webpack 5 via `@nativescript/webpack`, configured
through `webpack.chainWebpack`.

### Export-condition resolution

```js
config.resolve.set('conditionNames', [
  'react-native', 'browser', 'module', 'import', 'require', 'default',
]);
```

`react-native` so `@optimystic/db-p2p` and `@serfab/cadre-core` resolve their
**TCP-free** export condition (db-p2p → `rn.js`, no `@libp2p/tcp`); `browser` so
`@libp2p/websockets` & friends pick their browser variants. `node` is
**deliberately omitted** — the NS V8/JSC runtime is browser-like, not Node.

### Node built-in shims (`resolve.fallback`)

| Module | Target | Notes |
|--------|--------|-------|
| `os` / `node:os` | `src/polyfills/node-os.ts` | custom shim — `networkInterfaces()→{}`, `platform`/`type`/`hostname`/`EOL`; unlike the RN shim it does **not** import `react-native` |
| `crypto` / `node:crypto` | `src/polyfills/node-crypto.ts` | custom shim — `createHash()` (SHA-256/512 via @noble/hashes). Key gen / sign / verify are intentionally absent (the @libp2p/crypto `*.browser.js` variants cover those) |
| `stream` / `node:stream` | `readable-stream` (npm) | libp2p stream handling |
| `buffer` / `events` / `util` / `process` / `string_decoder` | installed npm packages | `externalsPresets.node:false` bundles them rather than externalizing |
| `net` / `tls` / `http` / `https` / `http2` / `zlib` / `tty` / `dns` / `dgram` / `cluster` / `child_process` / `worker_threads` / `fs` / … | `false` (empty module) | imported by transitive libp2p / debug / `@multiformats/dns` deps on **Node-only branches never reached** on the TCP-free browser-transport `rn` path, but must resolve so the bundle builds |

### `node:` scheme stripping

NS sets `externalsPresets.node:false`, which leaves `node:`-prefixed imports as an
unhandled URI scheme (`UnhandledSchemeError`). A `NormalModuleReplacementPlugin`
rewrites `node:foo → foo` so it flows through `resolve.fallback`, matching the RN
Metro handling of both `node:os` and `os`.

### `@libp2p/crypto` Node → browser rewrite

`@libp2p/crypto` ships parallel `*.browser.js` variants (ed25519 / secp256k1 / rsa
/ ecdh keys, webcrypto, hmac, aes-gcm) using `@noble/curves` + WebCrypto instead
of Node's `crypto`. The mapping is declared in the package's top-level `browser`
field — **not** in `exports`, so `conditionNames` cannot select it, and (verified)
the `browser` alias field does not apply it to the package's *internal* relative
imports either. Without the rewrite the bundle picks `ed25519/index.js`, which
does `import crypto from 'crypto'` and calls Node key APIs the `createHash`-only
shim lacks — so `generateKeyPair('Ed25519')` (peer identity) throws
`undefined cannot be used as a constructor`.

A `NormalModuleReplacementPlugin` therefore applies the `browser` map explicitly,
exactly like the RN Metro `resolveRequest` rewrite
([`reference-app-rn.md` § Why the browser rewrite matters](reference-app-rn.md#metro-configuration)):
for any internal `.js` import resolving under an `@libp2p/crypto` package whose
package-relative path is a `browser`-map key, the request is redirected to the
absolute `*.browser.js` variant. The map is loaded from whichever copy is
installed (local + nested optimystic), so every `@libp2p/crypto` in the tree is
covered.

### ES2022 downlevel + modern output

NS 8.x's CommonJS-output toolchain parses bundled deps below ES2022 and rejects
`async #method` (ES2022 private methods) shipped by `@libp2p/peer-store`,
`circuit-relay-v2`, etc. An `esbuild-loader` rule downlevels syntax (semantics
preserved) to `es2020` for everything under `node_modules` **except**
`@nativescript`'s own packages — purely to satisfy the build-time parser; the
V8/JSC runtime supports the syntax. webpack's own runtime output is left modern
(`output.environment` enables arrow/async/const/optional-chaining/…).

### `exportsPresence: 'warn'`

`@optimystic/db-p2p`'s nested deps carry a version skew: `@chainsafe/libp2p-
gossipsub` imports `StrictSign` / `StrictNoSign` / `TopicValidatorResult` and
`@libp2p/autonat` imports `streamMessage` from versions of `@libp2p/interface` /
`protons-runtime` that renamed them. Metro tolerates missing named exports;
webpack treats them as hard errors for strict ESM. Downgrading to warnings makes
the build reflect the same working-at-runtime reality as the RN app. This is the
source of the bundle's ~22 warnings (4 distinct missing exports). Tracked for
upstream resolution in `tickets/backlog/optimystic-db-p2p-libp2p-dep-skew.md`;
resolving it upstream would let the NS app restore strict missing-export detection.

## Testing Strategy

| Tier | Command | Agent/CI-runnable? | What it proves |
|------|---------|--------------------|----------------|
| Typecheck | `yarn workspace @serfab/reference-app-ns typecheck` | **yes** | `tsc --noEmit` across the package + cadre-core/db-p2p/storage-ns/quereus types |
| Bundle smoke | `yarn workspace @serfab/reference-app-ns test:bundle` | **yes** | `node scripts/bundle-check.js` — webpack-only compile (no gradle), resolving the whole import graph (db-p2p → `rn.js`, no `@libp2p/tcp`, `@libp2p/crypto` browser variants). The analog of RN's `expo export`. |
| Native prepare | `yarn workspace @serfab/reference-app-ns test:bundle:native` | **no** | `ns prepare android` — the webpack compile plus the gradle native-plugin build (needs Android SDK / gradle) |
| Maestro e2e | `yarn workspace @serfab/reference-app-ns test:e2e` | **no** | full device run (needs emulator + built APK + Maestro + adb) |

### Bundle smoke (the agent-runnable gate)

`scripts/bundle-check.js` runs the webpack compile and asserts the whole graph
resolves. It is the only runtime-adjacent gate an agent or CI without an Android
device can run; everything that requires the native SQLite / WebSocket plugins is
device-only. A green bundle proves resolution and parse, **not** execution.

### Maestro e2e (device / CI — out-of-band)

`scripts/run-e2e.mjs` is the NativeScript sibling of RN's `run-e2e.mjs`. It
**reuses the RN drone fixture, HTTP sidecar, Maestro flows, `_setup.yaml`, and
`_helpers/*` verbatim** — they are runtime-agnostic, so the only difference is
`MAESTRO_APP_ID` (→ `org.gotchoices.sereus.chat.ns`, the NS app id). There are no
duplicate flow files in this package; see
[`packages/reference-app-ns/maestro/README.md`](../packages/reference-app-ns/maestro/README.md).

The orchestrator:

1. spawns `reference-app-rn/test-fixture/start.mjs` (in-memory drone:
   `MemoryRawStorage`, profile `storage`, WS listener on 4002, `enableRelay`,
   `strandFilter:all`, `initializeSeedBootstrap`, a pre-created chat strand) with
   the RN package as cwd so its deps resolve;
2. waits for `GET http://127.0.0.1:4080/health` (the HTTP sidecar);
3. reads `test-data.json` (`partyId`, `droneBootstrapAddr`, `seed`, `strandId`);
4. runs `adb reverse tcp:4002` and `tcp:4080` so the Android emulator can reach
   the host-bound fixture;
5. runs `maestro test` over the RN `maestro/flows/`, passing the test-data fields
   + `MAESTRO_APP_ID` as `-e KEY=VALUE` env vars (and `--format junit`);
6. tears down the fixture + adb reverse rules on exit.

#### Flows (reused from RN)

| Flow | Coverage |
|------|----------|
| `flows/1-connect-and-send.yaml` | cold launch → connect → seed → create strand → send → local echo |
| `flows/2-drone-to-phone.yaml` | drone-side HTTP insert appears in the app within ~5 s |
| `flows/3-round-trip.yaml` | bidirectional (app→drone and drone→app both visible) + monotonic timestamps |

All three share `_setup.yaml` and the `_helpers/*.js`
(`discover-phone-strand.js`, `drone-insert.js`, `drone-assert-phone-message.js`,
`assert-monotonic-timestamps.js`). The app-created strand syncs to the drone via
`strandFilter:all`; `discover-phone-strand.js` polls the sidecar `/status` to find
it so both sides reference the same DB.

#### The one real NS-specific risk: test-id resolution

RN sets `testID`; NativeScript has no `testID`. The NS UI instead sets
**`automationText`** on every interactive element using the **exact same string
values** as `src/test-ids.ts` (`input-party-id`, `btn-connect`, `btn-disconnect`,
`input-seed`, `btn-apply-seed`, `input-add-peer`, `btn-add-peer`,
`btn-create-strand`, `value-peer-id`, `modal-title`, `btn-modal-ok`, `status-bar`,
`input-message`, `btn-send`, `message-list`, `message-row-<id>`). On Android
`automationText` maps to `contentDescription`; on iOS to
`accessibilityIdentifier`.

Whether Maestro's `id:` matcher resolves those values on an NS build must be
**verified once via Maestro Studio** against a real APK (Phase 3, out-of-band). If
`id:` matching proves unworkable on NS builds, the documented fallback is
**Appium** (which matches `content-desc` / `accessibilityIdentifier` directly);
Maestro is tried first for maximum reuse of the RN suite. Update this section with
the outcome once a device run is available.

A second device-only risk to watch in the same pass: `_setup.yaml`'s
`status-bar` visibility step asserts the Chat-screen status bar after creating a
strand while still on the Settings tab. Whether the NS `TabView` keeps the
inactive tab's view "visible" to Maestro is unknown without a device; if it
fails, eject the flows (see the maestro README) and switch to the Chat tab before
that assertion.

### Manual device smoke

See the package [README](../packages/reference-app-ns/README.md) § "Device smoke"
for the manual walk-through (boot → polyfill audit → connect → create strand →
send → cold-relaunch identity check → drone two-node). The two-node drone startup
is identical to RN's — see
[`reference-app-rn.md` § Two-Node Startup Sequence](reference-app-rn.md#two-node-startup-sequence).

## Shared protocol material

The seed bootstrap flow, the simplified Chat sApp schema (`Member` + `Message`,
no signature verification), peer-identity persistence, open-vs-closed strands, and
the multi-party strand topology are identical to the RN reference and documented
once in [`reference-app-rn.md`](reference-app-rn.md). The NS app differs only in
runtime (V8/JSC), storage (SQLite vs LevelDB), and UI framework (NS-Core vs RN).
