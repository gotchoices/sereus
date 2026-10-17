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

The phone reserves a slot on each relay named in Settings → Relays (`input-relay-addr`, the start's `relayAddrs`), so its control node and each strand node hold a `/p2p-circuit` address and can be dialed through the relay. With no relay named it dials out only, and cannot be invited (see [architecture.md → Which nodes can be reached through a relay](architecture.md#which-nodes-can-be-reached-through-a-relay)).

### Storage

The phone runs cadre-core's edge node (`createEdgeNode` from `@serfab/cadre-core/edge-node`, the bring-up React Native's `createPhoneNode` is too) over SQLite: `src/ns-edge-platform.ts` supplies its key store and storage over `@optimystic/db-p2p-storage-ns` (`SqliteRawStorage`, `SqliteKVStore`, `openOptimysticNSDb`) and the `@nativescript-community/sqlite` native plugin. One database per cadre-core storage scope: `sereus-<strandId>` for each strand, and `sereus-control-<hex party id>` for the party's control database — the control key carries the party id, so switching parties on one device lands on a different database rather than sharing one. On Android each database is opened by its full path under the app's databases directory (`src/ns-db-path.ts`), so opening one needs no Activity and works before the first screen exists; it is the same file the plugin uses for a bare name.

- **Opened on first use.** The edge node asks for a scope's storage synchronously and the opener is async, so the platform hands out cadre-core's `lazyRawStorage` proxy, which awaits the open before each call. Its `durability` is read before any open, so it states `'power-loss'`, the value `SqliteRawStorage` fixes.
- **One open per database name.** Every proxy over a scope shares one connection. An open that fails is dropped, so the operations awaiting it fail with its error and the next operation opens again.
- **Closed by every stop.** A stop, and a failed start, flush and close the identity database and every scope's block store and database (`EdgeNodeStorage.close`); the next start opens them again. A screen therefore must not hold a strand instance across Disconnect: the view model drops its strand list on each status a stop reports (`stopped`, `removed`, `failed`).
- **Deleted by a removal or a dissolve.** `destroyScope` closes the scope's handle, then deletes its file with the plugin's `deleteDatabase`.

A device that ran a build predating the party scoping still has an unscoped
`sereus-control` database. Nothing opens or deletes it: its rows belong to whichever
party was configured when they were written and nothing recorded which.

### Node-local records and identity

`sereus-peer-identity` is the one database that is not a storage scope, and cannot be: the party id is read out of it. Its `kv` table holds two things, each in its own column:

- **The key store** (`EdgeNodePlatform.keyStore`), in `b_val`: the identity under `peer-private-key`, the row `loadOrCreateNSPeerKey` wrote before the edge node, so a phone keeps its peer id across the upgrade; every other slot (the owner key, the joined-strand and strand-move records) under `keystore.<slot id>`. Each write is followed by a synced commit. A slot's row that holds no bytes is refused with `KeyStoreAccessError`, never read as empty, which would write a new key over it.
- **The node-local records** (`EdgeNodeStorage.nodeLocal`), text in `s_val` through one `SqliteKVStore` with an empty key prefix: the saved start (`start-options`), the dissolve marker (`dissolving-party`), and per party the trusted-owner anchor, bootstrap peers, enrolled-machine count and strand network state (`trusted-owners.<partyId>`, `bootstrap-peers.<partyId>`, `enrolled-machines.<partyId>`, `strand-network.<partyId>`), the keys this app wrote before the edge node.

The database opens on first use (the launch read of the saved start, or a start) and closes with every stop; the next read opens it again.

One database, one fate: the identity, the owner key and the anchor are wiped together. This app has no Keychain/Keystore integration, so all three sit in plaintext SQLite, unlike React Native, which keeps them in the platform secure store (see [`reference-app-rn.md`](reference-app-rn.md)). Whoever adds NS secure storage moves the identity, the owner key and the anchor together.

### Joining another cadre

Settings' Join a Cadre section takes a pasted invitation (`input-cadre-invitation`, `btn-join-cadre`) and hands it, with the Relays field's relays, to the edge node's `joinCadre` (`CadreViewModel.joinCadre`). The phone moves to the invitation's party, keeping its identity: the edge node stops the running node, starts one in that party with `origin: 'joined'`, and redeems the invitation there, which pins the bundle's owner keys before dialing the members it names. A joined party never runs owner genesis, on this start or a later one: genesis before the party's control rows arrive would seat the phone as a second founder.

- **Admitted**: the edge node saves the joined party as the start, and the Settings form takes the running start's party, bootstrap and relay fields, so the next Connect starts the joined party rather than the one the phone left.
- **Refused**: the edge node starts the party the phone left again, and the modal words the refusal (`src/join-failure.ts`).
- **Strands of the party left behind**: when the phone founded the party it leaves and there is something to move, the join is refused before anything stops (`StrandsNeedOwnerJoinError`): every row a move seats is owner-signed, and a machine invitation makes the phone a member. The edge node moves them itself on a join with an owner grant, which this app's join field does not take yet (`tickets/backlog/feat-reference-app-ns-owner-grant-join.md`). The left party's data stays on disk under its own names; dissolving it has no NativeScript UI.

The Seed Bootstrap field (`input-seed`) is accepted only when the seed's signer is already anchored — the default `anchoredTrustPolicy` — so it serves a phone that founded the cadre or joined it by that owner's invitation; the hint beside it says so. Both fields are kept on failure, so the retry costs no re-paste. A seed decodes through a raw base64url → `JSON.parse` in cadre-core, and `decodeCadreInvitation` names what is wrong with a bundle but not which field it came from, so `CadreViewModel` rewraps either failure with copy naming *which* paste was unreadable; the modal would otherwise read `SyntaxError: Unexpected token …` and name neither. (RN surfaces the bare parse error; this is a deliberate NS-only improvement, not a parity gap to close in the other direction.) `src/join-failure.ts` is a hand-copied twin of RN's module: one plain sentence per rejection code, one each for an unreachable member and an unverifiable reply, and one for the refusal to join as a member with strands to move.

### Owner key

A start from Settings → Connect founds its party (`origin` absent, read as `'founded'`), so the edge node runs owner genesis on it: on a party with no owner yet, it creates an owner key in the key store's owner slot, seats it as the founding owner and wires it for signing; on a party that already has owners, it wires the slot's key only if it is one of them. The key sits in plaintext SQLite beside the identity (see above). A start naming the party of the saved start takes that start's `origin`, so typing a joined party's id back into Settings does not run genesis there.

Typing *another* cadre's party id and bootstrap address into Settings is still a founded start: on a phone whose copy of that party's owner rows has not arrived when genesis runs, genesis seats this phone's key as a second founding owner, as it does on React Native. Joining by invitation is the way into another cadre. The bootstrap-peer record fills in from `applySeed`.

### Start options

Every record above is filed under the party id, so they are read back on a relaunch only because the party id itself is remembered: the **saved start** (`EdgeNode.loadSavedStart`; party id, bootstrap and relay addresses, how the phone came to the party, plus `autoStart`) sits under the one key `start-options`, deliberately *not* party-scoped, since it is what selects the party. The edge node owns its format and parsing (`@serfab/cadre-core/edge-node` → `options.ts`). A record written before the edge node (`{ version, partyId, bootstrapAddrs, autoStart }`) reads as a founded start with no relays, so an installed phone keeps its party and its auto-start (pinned in `test/ns-edge-platform.spec.ts`).

- **Written** only by the edge node: after every successful start and an admitted join (`autoStart: true`), and on Settings → **Disconnect** (`autoStart: false`, same options); a removal by an owner replaces it with the cadre the phone founded and left (auto-start off) or deletes it, and the view model reads it again so the Settings form offers that, never the removed party. A failed start writes nothing. `startSolo` (`solo-smoke.ts`) is a start like any other and writes it too.
- **Read** once at app launch (`CadreViewModel.restore`, run when `getCadreVm()` first creates the shared view model). With `autoStart` true and nothing started yet, the app connects by itself with those options, exactly as a Connect tap would. Either way the Settings Party ID, Bootstrap and Relays fields prefill from them (comma-separated, so a list round-trips). A read fault shows "Could not read the saved connection settings" and starts nothing.
- **Overlapping transitions** (the launch auto-start and a Connect tap, Disconnect during a start, Connect during a stop) are queued by the edge node and run in call order.
- **Reinstall** deletes the SQLite database with the app, identity included, so a reinstalled phone is a new peer in a new party. Nothing on this app lives in the Keychain to outlive it.

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
  settings/         settings screen: connect/join-cadre/seed/dial-peer/create-strand/modal  (SettingsViewModel → cadre-vm)
src/
  polyfills/        V8/JSC-audited globals (buffer-global, hermes, intl-pluralrules, event, node-crypto, node-os, audit, registry)
  ns-edge-platform.ts the edge node's platform: key store, node-local store, per-scope block stores (SQLite)
  cadre-phone.ts    the phone's one edge node (@serfab/cadre-core/edge-node) + the peer dial on its running node
  cadre-vm.ts       CadreViewModel (Observable) — edge-node status/strands/join  (← RN use-cadre + cadre-context)
  join-failure.ts   plain words for each way a join can fail  (hand-copied twin of RN's)
  chat-vm.ts        ChatViewModel (Observable) — 2 s poll loop, optimistic send, participant auto-register  (← RN use-chat)
  test-ids.ts       automationText constants shared with the e2e flows (ported from RN src/test-ids.ts)
  chat-strand.ts    create/join chat strand (ported from reference-app-rn)
  chat-operations.ts insert/query participants + messages (ported)
  solo-smoke.ts     startSolo → createChatStrand → insertMessage → queryMessages (programmatic helper, no UI)
webpack.config.js   node shims + react-native/browser conditions + named-package browser rewrite + esbuild downlevel
browser-map.js      the named packages and their `browser` file maps, shared by webpack.config.js and scripts/bundle-check.js
nativescript.config.ts   id: org.gotchoices.sereus.chat.ns
```

### Parity map (RN → NS)

| reference-app-rn | reference-app-ns |
|---|---|
| `src/use-cadre.ts` + `src/cadre-context.tsx` | `src/cadre-vm.ts` (`CadreViewModel`, `getCadreVm()` singleton) |
| `src/use-chat.ts` | `src/chat-vm.ts` (`ChatViewModel`, `getChatVm()` singleton) |
| `src/chat-send.ts` (`ChatSender` — extracted so the send rule is testable without React) | folded into `ChatViewModel.send`, which holds the pending draft itself (tested in `test/chat-vm.spec.ts`) |
| `src/test-ids.ts` (`testID`) | `src/test-ids.ts` (same strings, surfaced via `automationText`) |
| `app/settings.tsx` | `app/settings/settings-page.{xml,ts}` + `settings-view-model.ts` |
| `app/index.tsx` | `app/chat/chat-page.{xml,ts}` |
| `app/_layout.tsx` (Expo Router tabs) | `app/app-root.xml` (`TabView` Chat + Settings) |

## Startup Sequence

libp2p and its dependencies reference Web/Node globals **at import time**, so the
entry point (`app/app.ts`) loads polyfills and the WebSocket global before any
cadre/libp2p code. The heavy cadre/db-p2p/Quereus graph is pulled in lazily by the
Chat / Settings pages (via `cadre-vm` → `cadre-phone`) on navigation, after the
audit runs. The Chat page (the default page) creates the shared `CadreViewModel`,
which reads the saved start options and reconnects when the last session ended
connected — Settings → Connect is the other way the node starts (see
[Start options](#start-options)).

```ts
// app/app.ts
import '../src/polyfills';            // 1. every runtime global, WebSocket included

import { Application } from '@nativescript/core';
import { runPolyfillAudit } from '../src/polyfills/audit';

runPolyfillAudit();                   // 2. log the real V8/JSC surface (native vs polyfilled vs ✗) before libp2p
Application.run({ moduleName: 'app-root' }); // 3. start the app (TabView)
```

The polyfill barrel (`src/polyfills/index.ts`) enforces the intra-polyfill order:
`process` → `buffer-global` (sets `globalThis.Buffer`) → `hermes` (runtime shims)
→ `intl-pluralrules` → `intl-datetimeformat` → `event`
(`EventTarget`/`Event`/`CustomEvent`) → `abort` → `broadcast-channel` →
`websocket`.

NativeScript has no native `WebSocket`; `@valor/nativescript-websockets` installs
the global when imported. `websocket.ts` imports that plugin itself and then
patches `WebSocket.prototype.bufferedAmount`, so the patch can never run against a
global that does not exist yet (it would silently no-op).

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
| `WebSocket` | **plugin** (`@valor/nativescript-websockets`, loaded by `websocket.ts`) | native (RN) |
| `WebSocket.prototype.bufferedAmount` | **∙ polyfilled** — the plugin declares the field in its type but never assigns it | polyfilled (fixed 2026-09-16, commit `7a0fd6c` — the phone could not dial anyone until then) |

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
| `AbortController` / `AbortSignal` | `abort.ts` | hand-rolled over the polyfilled `EventTarget`/`Event` | libp2p, @libp2p/utils, circuit-relay-v2, it-pushable, any-signal, p-retry and most of the cadre stack | NS ships neither — which is why the `throwIfAborted` patch above short-circuits. Carries `AbortSignal.timeout` and `AbortSignal.any`; `DOMException` is feature-detected, falling back to a named `Error`. An `AbortSignal.any` combination whose inputs *all* fail to abort keeps its listeners (no caller does that today — same caveat as the RN row in [`reference-app-rn.md`](reference-app-rn.md)). `yarn lint` keeps first-party source off these APIs (`PHONE_RUNTIME_GUARD` in `eslint.config.mjs`) |
| `WebSocket.prototype.bufferedAmount` | `websocket.ts` (imports the plugin first, then patches) | inline, returns `0` | `@libp2p/websockets` (`websocket-to-conn.js` gates sending on it) | `@valor/nativescript-websockets` declares the field but never assigns it; without this every outbound WebSocket dial died on the 10 s dial timeout — same defect fixed for RN in commit `7a0fd6c` |
| Timer `.ref()` / `.unref()` | `hermes.ts` | object-wrap | @optimystic/db-p2p, undici, libp2p internals | NS timers return numbers; wraps the id in an object and patches `clear{Timeout,Interval}` to unwrap. Probes a real timer first and only wraps if native timers aren't already objects |
| `Buffer` (global) | `buffer-global.ts` | `buffer` (npm) | libp2p transitive deps reaching for the Node `Buffer` global | the webpack `buffer` *module* alias doesn't register a global |
| `CustomEvent` | `event.ts` | shim over `event-target-polyfill` | libp2p `safeDispatchEvent` | `event-target-polyfill` installs spec-complete `EventTarget`/`Event` but omits `CustomEvent` |
| `Intl.PluralRules` | `intl-pluralrules.ts` | English-only shim | moat-maker (ordinal error messages) | cardinal + ordinal English rules |
| `Intl.DateTimeFormat` (+ `Locale` / `getCanonicalLocales` / `NumberFormat`) | `intl-datetimeformat.ts` | `@formatjs` polyfills, all-tz + `en` data | Quereus's `temporal-polyfill`, which captures `Intl.DateTimeFormat` at module scope | NS's Android V8 is built with `v8_enable_i18n_support=false`, so the whole namespace is absent and there is no app-level toggle. Real IANA zone data, not a UTC stub — `Temporal.ZonedDateTime` results would otherwise be silently wrong. Loads after `intl-pluralrules`, which creates the `Intl` object these extend |
| `BroadcastChannel` | `broadcast-channel.ts` | no-op single-context stand-in | `mortice`, the async mutex behind libp2p's `PersistentPeerStore` write lock | A NativeScript app is one JS context with no sibling processes or workers, so a channel that reaches nobody is correct — mortice's in-memory emitter does the real locking. Without it the peer-store lock threw on the first write |
| `process` (global) | `process.ts` | minimal Node-like shim (`env`, `nextTick`, browser flags) | `debug` via @libp2p/logger, which reads `process.env.DEBUG` at module scope | @nativescript/webpack's DefinePlugin rewrites every bare `process` to `global.process`, which NS does not define, so the cadre/libp2p graph threw "Cannot read properties of undefined (reading 'env')" on load. Imported FIRST, and never references the bare identifier itself |

## Webpack Resolver Config

`webpack.config.js` reproduces the RN Metro resolver behaviour
(`@serfab/cadre-rn/metro`, which `reference-app-rn/metro.config.js` calls) so the same import graph bundles under
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

### Named-package Node → browser rewrite

Some packages ship parallel `*.browser.js` files and select them only through their top-level `browser` map — **not** `exports`, so `conditionNames` cannot select them, and (verified) the `browser` alias field does not apply the map to the package's *internal* relative imports either. For each package on an explicit list (`BROWSER_MAP_PACKAGES` in `browser-map.js`), a `NormalModuleReplacementPlugin` applies the map itself, like the RN Metro `resolveRequest` rewrite ([`reference-app-rn.md` § Why the browser rewrite matters](reference-app-rn.md#metro-configuration)): an internal relative `.js` import whose package-relative path is a map key is redirected to the mapped file. The owning package is taken from the last `node_modules` segment of the import's resolved path, and each installed copy (local + nested optimystic) is rewritten from its own `package.json`. `test:bundle` fails if any bundled file is one the rewrite should have replaced, since a stopped rewrite still compiles cleanly and fails only on a device.

The listed packages:

- **`@libp2p/crypto`** — its Node files (ed25519 / secp256k1 / rsa / ecdh keys, hmac, aes-gcm) call Node key APIs that the `createHash`-only crypto shim lacks, so `generateKeyPair('Ed25519')` (peer identity) throws `undefined cannot be used as a constructor`; the browser files use `@noble/curves` + WebCrypto.
- **`main-event`** — its Node `events.js` calls the static `setMaxListeners` from `node:events`, which the npm `events` package does not have, so every call throws a `TypeError` that the package swallows; libp2p calls it for every abort signal it creates. The browser `events.browser.js` is a no-op.

A package joins the list only when its Node variant is measured to break or cost something. Other packages' Node variants are bundled too (`mortice`, `weald`, parts of `libp2p` and `@libp2p/utils`, `multiformats`' sha2) and none is known to matter; libp2p's user agent has its own shim instead, because its browser variant reads `navigator.userAgent`.

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
the build reflect the same working-at-runtime reality as the RN app. The 22
resulting warnings (4 distinct missing exports) are then allowlisted by message
regex via `ignoreWarnings`, so a clean build reports **0 errors, 0 warnings** —
and `scripts/bundle-check.js` treats any warning as fatal, which is what keeps a
*new* missing export from slipping through the `'warn'` downgrade.

Two independent causes, neither fixed by the (landed) upstream
`optimystic-db-p2p-libp2p-dep-skew` dependency alignment:

- `@nativescript/webpack`'s base config prepends this app's **absolute**
  `node_modules` path to `resolve.modules`, so every bare specifier resolves
  against it first — even imports originating inside
  `../optimystic/packages/db-p2p/node_modules`, which has the correct nested
  `protons-runtime@6` copy. The hoisted `protons-runtime@5.6.0` wins instead.
- `@chainsafe/libp2p-gossipsub` (14.1.2, the latest published release as of
  2026-07) still declares `@libp2p/interface@^2`, a different major than the
  `^3.x` the rest of the stack uses. No `^3`-compatible release exists upstream.

Removing the override today reintroduces all 22 as hard errors. Tracked in
`tickets/backlog/debt-reference-app-ns-resolve-nested-libp2p-deps.md`.

## Testing Strategy

| Tier | Command | Agent/CI-runnable? | What it proves |
|------|---------|--------------------|----------------|
| Typecheck | `yarn workspace @serfab/reference-app-ns typecheck` | **yes** | `tsc --noEmit` across the package + cadre-core/db-p2p/storage-ns/quereus types |
| Unit | `yarn workspace @serfab/reference-app-ns test` | **yes** | Vitest over `test/**/*.spec.ts` under plain Node: the SQLite edge-node platform (`src/ns-edge-platform.ts`) under the real edge node over `node:sqlite` — what an upgraded phone reads back and the key store's rows — the two `Observable` view models behind the Settings screen (`src/cadre-vm.ts`, `app/settings/settings-view-model.ts`) — the join and seed paths in depth, plus every other button on that screen — and the chat view model (`src/chat-vm.ts`: poll, participant registration, send and retry key) over a real in-memory Quereus database. Guarded by the shared stale-build check (`test/global-setup.ts`). The pages are **not** covered here. |
| Bundle smoke | `yarn workspace @serfab/reference-app-ns test:bundle` | **yes** | `node scripts/bundle-check.js` — webpack-only compile (no gradle), resolving the whole import graph (db-p2p → `rn.js`, no `@libp2p/tcp`, the named-package browser variants). The analog of RN's `expo export`. |
| Native prepare | `yarn workspace @serfab/reference-app-ns test:bundle:native` | **no** | `ns prepare android` — the webpack compile plus the gradle native-plugin build (needs Android SDK / gradle) |
| Maestro e2e | `yarn workspace @serfab/reference-app-ns test:e2e` | **no** | full device run (needs emulator + built APK + Maestro + adb) |

### Unit suite

`vitest.config.ts` collects `test/**/*.spec.ts` under `environment: 'node'`.

Three groups are targeted. The first is the platform the edge node runs over, `src/ns-edge-platform.ts` (`test/ns-edge-platform.spec.ts`). Node's built-in `node:sqlite`, behind `@optimystic/db-p2p-storage-ns`'s own `wrapNSPluginDb`, stands in for the NativeScript plugin: only `openOptimysticNSDb` and the plugin's `deleteDatabase` are mocked, so the SQL, the package's stores and cadre-core's edge node are real. It pins what a phone that ran this app before the edge node reads back — its identity row as the key store's identity slot, its saved start through `EdgeNode.loadSavedStart` — and the key store's rows: each slot's `kv` key, the listing, and the refusal of a row that holds no bytes. The edge node's own behaviour (queued transitions, cleanup after a failed start, genesis, joins) is covered by cadre-core's suite; this platform's open, close and delete of its handles is checked by reading.

The second is the two `Observable` view models behind the Settings screen —
`src/cadre-vm.ts` and `app/settings/settings-view-model.ts`. They import
`@nativescript/core`, whose entry point cannot load under plain Node (it reaches
`@nativescript/core/globals` as a *directory* import, which Node's ESM loader
refuses). `resolve.alias` therefore redirects that exact specifier — anchored
regex, so the subpaths are untouched — to `test/stubs/nativescript-core.ts`,
which re-exports the **real** `Observable` and `ObservableArray` from the
submodules that do load (`data/observable`, `data/observable-array`). The stub
also fixes `isAndroid` at false, so `src/ns-db-path.ts` hands the platform suite
the plain database names its opener is keyed by. Both suites drive one shared fake
edge node and the fake `CadreNode` it runs (`test/stubs/fake-cadre-node.ts`), handed
over through a mocked `src/cadre-phone.ts`. The fakes record every call into a
single ordered array, because the behaviours under test are orderings: a pasted
invitation is decoded (by the real `decodeCadreInvitation`, over a bundle the real
`encodeCadreInvitation` rendered) *before* the edge node's `joinCadre` is reached,
so an unreadable paste never touches it; a seed decodes before it is applied; and a
Settings handler given a blank field makes no call at all. The view model's status,
peer id and strand list follow the fake edge node's status reports, as they follow
the real one's, and a join that comes up in the invitation's party leaves the
Settings form naming that party, as a removal leaves it naming the cadre the saved
start now names. Both fakes declare `implements` against a
`Pick<…>` of the real types, so a cadre-core signature change fails `typecheck`
instead of leaving the suites green while the app breaks on device — a `vi.mock`
factory is not otherwise checked against the module it replaces.

The third is the chat screen's view model, `src/chat-vm.ts`
(`test/chat-vm.spec.ts`): the poll's one-read-at-a-time guard, dropping a late
read of a strand it has switched away from and clearing the list on the switch,
registering the
local participant once the strand is writable, and the send rule with its retry
key (the NativeScript counterpart of `reference-app-rn`'s `chat-send.spec.ts`). It
drives the same fake node, but `src/chat-operations.ts` runs unmocked against a
real in-memory Quereus `Database` carrying the app's own chat schema, so
primary-key and foreign-key refusals are real and a query that stops matching the
schema fails here. The strand hands out a thin decorator over that database
which records each statement by the table it touches and lets a test hold one
open, refuse it, or apply it and then throw ("stored, then the outcome was
lost"). Only the poll's `setInterval` is faked.

Still uncovered here: the pages. They need the device harness below.

`test/global-setup.ts` runs the shared stale-build guard
(`test-harness/build-freshness.ts`) first, because those specs execute real
compiled output from `@serfab/cadre-core` and the linked `@optimystic` /
`@quereus` siblings. A stale sibling `dist` fails the run up front rather than
reporting green about code it never executed. `test/build-targets.spec.ts` holds
that hand-written target list against the package's actual dependencies.

### Bundle smoke (the whole-graph gate)

`scripts/bundle-check.js` runs the webpack compile and asserts the whole graph
resolves with 0 errors **and 0 warnings** (see `exportsPresence: 'warn'` above for
why warnings are fatal), and that no listed package's Node file was bundled in place of its browser file (see [Named-package Node → browser rewrite](#named-package-node--browser-rewrite)). It is the only gate without an Android device that reaches
the *whole* import graph — the unit suite above loads a few modules and mocks the
native seams — and everything that requires the native SQLite / WebSocket plugins
stays device-only. A green bundle proves resolution and parse, **not** execution.

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
3. reads `test-data.json` (`partyId`, `droneBootstrapAddr`, `cadreInvitation`,
   `strandId`);
4. runs `adb reverse tcp:4002` and `tcp:4080` so the Android emulator can reach
   the host-bound fixture;
5. runs `maestro test` over the RN `maestro/flows/`, passing the test-data fields
   (`PARTY_ID`, `BOOTSTRAP_ADDR`, `JOIN_CODE` from `cadreInvitation`, `STRAND_ID`) +
   `SIDECAR_URL` + `MAESTRO_APP_ID` as `-e KEY=VALUE` env vars (and
   `--format junit`). `JOIN_CODE` is the drone's machine invitation, not the owner grant the
   phone app's run passes, since this app's join field takes no grant yet; it is what `_setup.yaml` types into
   `input-cadre-invitation` before tapping `btn-join-cadre` and asserting the
   `Joined cadre` modal: redeeming it pins the drone's owner key and admits the
   phone at the drone;
6. tears down the fixture + adb reverse rules on exit.

#### Flows (reused from RN)

| Flow | Coverage |
|------|----------|
| `flows/1-connect-and-send.yaml` | cold launch → connect → join → create strand → send → local echo |
| `flows/2-drone-to-phone.yaml` | drone-side HTTP insert appears in the app within ~5 s |
| `flows/3-round-trip.yaml` | bidirectional (app→drone and drone→app both visible) + monotonic timestamps |
| `flows/4-solo-create-strand.yaml` | no drone: connect alone → create strand → `Strand created` within 60 s |

Flow 4 uses no drone and no `_setup.yaml`; it taps the RN app's `btn-first-launch-fresh` only when it shows, so on NS it uses only `btn-connect`, `btn-disconnect`, `btn-create-strand`, `modal-title` and `btn-modal-ok`. Flows 1–3 share `_setup.yaml` and the `_helpers/*.js`
(`discover-phone-strand.js`, `drone-insert.js`, `drone-assert-phone-message.js`,
`assert-monotonic-timestamps.js`). The app-created strand syncs to the drone via
`strandFilter:all`; `discover-phone-strand.js` polls the sidecar `/status` to find
it so both sides reference the same DB.

#### The one real NS-specific risk: test-id resolution

RN sets `testID`; NativeScript has no `testID`. The NS UI instead sets
**`automationText`** on every interactive element using the **exact same string
values** as `src/test-ids.ts` (`input-party-id`, `btn-connect`, `btn-disconnect`,
`input-seed`, `btn-apply-seed`, `input-cadre-invitation`, `btn-join-cadre`, `input-add-peer`, `btn-add-peer`,
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

The seed bootstrap flow, the simplified Chat sApp schema (`Participant` + `Message`,
no signature verification), peer-identity persistence, open-vs-closed strands, and
the multi-party strand topology are identical to the RN reference and documented
once in [`reference-app-rn.md`](reference-app-rn.md). The NS app differs only in
runtime (V8/JSC), storage (SQLite vs LevelDB), and UI framework (NS-Core vs RN).
