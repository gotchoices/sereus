# Running a node in a NativeScript app

This document is for a developer who embeds a cadre node in a NativeScript app. It covers what the app supplies to cadre-core's edge node, the globals the NativeScript runtime lacks, the webpack rules that make the libp2p, Optimystic and Quereus packages bundle, and where the node keeps its state on the device. All of it is taken from `packages/reference-app-ns`, the only NativeScript app in the repository, which declares the Android runtime only.

Related: [The cadre node](../cadre/node.md) · [React Native](react-native.md) · [Browser](browser.md) · [The reference apps](reference-apps.md) · [reference-app-ns README](../../packages/reference-app-ns/README.md)

## What the app must provide

A NativeScript app runs the same edge node as a React Native app or a browser tab: `createEdgeNode(platform)` from `@serfab/cadre-core/edge-node` ([The edge node](../cadre/node.md#the-edge-node)). The edge node builds, starts, stops and rebuilds the `CadreNode`, runs the owner step, saves the start for the next launch, and joins another cadre. The app supplies the rest.

- **An `EdgeNodePlatform`.** A `KeyStore` and an `EdgeNodeStorage` are required (`packages/cadre-core/src/edge-node/platform.ts`). `packages/reference-app-ns/src/ns-edge-platform.ts` implements both over SQLite and can be used as a starting point; [Where node state is kept](#where-node-state-is-kept) describes it.
- **Two native plugins.** `@nativescript-community/sqlite` backs `@optimystic/db-p2p-storage-ns` (`openOptimysticNSDb`, `sqliteNodeStorage`, `SqliteKVStore`). `@valor/nativescript-websockets` installs the `WebSocket` global, which NativeScript does not have. Both contain native code, so the node runs only on a device or an emulator.
- **Polyfills, loaded first.** libp2p and its dependencies read Web and Node globals while their modules load, so the app's entry file imports the polyfills before anything else ([Polyfills](#polyfills)).
- **A webpack configuration** that selects the stack's TCP-free and browser files and replaces the modules that call Node APIs ([Webpack configuration](#webpack-configuration)). TypeScript needs the same conditions to find the same types: `"customConditions": ["react-native", "browser"]` in `tsconfig.json`.
- **Relay addresses, if the phone is to be reachable.** A phone accepts no inbound connection. The start option `relayAddrs` names circuit relays; the control node and each strand node reserve a slot on them and can then be dialled at a `/p2p-circuit` address. With none, the node can dial out but no other machine can dial it ([Which nodes can be reached through a relay](../network/relay.md#which-nodes-can-be-reached-through-a-relay)).
- **Permission for cleartext WebSockets on Android, if the app dials `/ws` addresses.** The WebSocket plugin uses OkHttp, which follows Android's network security policy, and Android refuses cleartext connections from an app that targets API 28 or later unless its manifest sets `android:usesCleartextTraffic="true"` or a network security configuration allows the host. A `/wss` address needs nothing. The reference app's manifest sets neither, so it is expected to dial only `/wss` addresses; this has not been confirmed on a device.
- **A decision about schema signing.** cadre-core refuses an unsigned app schema by default. An app whose sApp configuration carries no signature sets `requireSignedSchemas: false` in `EdgeNodePlatform.configure`, as the reference app does for its demonstration schema. A production app signs its schema and leaves the default.

The platform object leaves `transports` unset, so the node dials with the edge node's defaults: WebSockets and the circuit-relay transport. There is no TCP and no WebRTC on NativeScript.

### Startup order

The entry file imports the polyfills, logs the audit, and only then starts the application. The pages import the cadre code, so the libp2p, Optimystic and Quereus modules are first evaluated when the first page loads, after the audit has run.

```ts
// app/app.ts
import '../src/polyfills';

import { Application } from '@nativescript/core';
import { runPolyfillAudit } from '../src/polyfills/audit';

runPolyfillAudit();
Application.run({ moduleName: 'app-root' });
```

## Polyfills

The shims are in `packages/reference-app-ns/src/polyfills/`, one file per concern, imported in order by `index.ts`. `hermes.ts` keeps the name of the React Native kit file it was ported from (`packages/cadre-rn/polyfills/hermes.js`). Each shim tests for the global before installing and calls `markPolyfilled` (`registry.ts`) only when it installs, so the audit can tell a global the runtime provides from one a shim supplied.

### V8 versus Hermes

NativeScript's V8 runtime and React Native's Hermes lack different things, so the React Native kit's polyfills (`@serfab/cadre-rn/polyfills`, [React Native → Polyfills](react-native.md#polyfills)) cannot be reused unchanged. The table compares the globals on which the two runtimes differ, or which both lack.

| API | NativeScript 8.8+ (V8) | Hermes with `@serfab/cadre-rn` |
|---|---|---|
| `crypto.getRandomValues` | native | native module `react-native-get-random-values` |
| `crypto.subtle` `generateKey` / `sign` / `verify` | native | absent; the kit's `polyfills/native-crypto` supplies Ed25519 through `react-native-quick-crypto` |
| `crypto.subtle.digest` | polyfilled: the runtime ships `subtle` without `digest` | polyfilled |
| `TextEncoder` | native | native |
| `TextDecoder` | polyfilled when absent (UTF-8 only) | polyfilled on bare React Native; Expo SDK 52+ provides it |
| `AbortController`, `AbortSignal` | absent; polyfilled in full | native |
| `Intl.DateTimeFormat`, `NumberFormat`, `Locale` | absent on Android; polyfilled with `@formatjs` | provided on Android, where Hermes uses the platform's ICU |
| `WebSocket` | from the `@valor/nativescript-websockets` plugin | native |
| `WebSocket.prototype.bufferedAmount` | polyfilled | polyfilled |

### Polyfilled on NativeScript (`src/polyfills/`)

The rows are in load order. "Needed by" names the package whose failure shows the shim is missing.

| Global | File | Implementation | Needed by |
|---|---|---|---|
| `process` | `process.ts` | `env`, `nextTick`, `stdout` and `stderr` with an `fd`, browser flags | `debug` and `weald` (libp2p's loggers), which read `process.env` and `process.stderr.fd` when a module loads |
| `Buffer` | `buffer-global.ts` | the npm `buffer` package | libp2p dependencies that use the Node global |
| `crypto.subtle.digest` | `hermes.ts` | SHA-256 and SHA-512 from `@noble/hashes` | `multiformats/hashes/sha2-browser` |
| `TextDecoder` | `hermes.ts`, `text-decoder.ts` | hand-written, UTF-8 only | `uint8arrays`, at module scope; Optimystic decodes every block it reads |
| `structuredClone` | `hermes.ts` | `@ungap/structured-clone` | `@optimystic/db-core` |
| `Symbol.asyncIterator` | `hermes.ts` | `Symbol.for('Symbol.asyncIterator')` | `for await` over custom iterables |
| `ReadableStream`, `WritableStream`, `TransformStream` | `hermes.ts` | `web-streams-polyfill` | streaming libraries |
| `Promise.withResolvers` | `hermes.ts` | inline | `@libp2p/utils`, yamux, `it-queue`, `mortice`, `abort-error` |
| Timer `.ref()` and `.unref()` | `hermes.ts` | wraps the numeric timer id in an object | `@optimystic/db-p2p`, undici, libp2p |
| `Intl.PluralRules` | `intl-pluralrules.ts` | English cardinal and ordinal rules | `moat-maker`, at module scope |
| `Intl.DateTimeFormat`, `NumberFormat`, `Locale`, `getCanonicalLocales` | `intl-datetimeformat.ts` | `@formatjs` polyfills with every time zone and `en` locale data | Quereus's `temporal-polyfill`, which captures `Intl.DateTimeFormat` at module scope |
| `EventTarget`, `Event`, `CustomEvent` | `event.ts` | `event-target-polyfill` plus a `CustomEvent` class | libp2p's `safeDispatchEvent` |
| `AbortController`, `AbortSignal` | `abort.ts` | hand-written over the polyfilled `EventTarget`, with `timeout`, `any` and `throwIfAborted` | libp2p, circuit-relay-v2, `it-pushable`, `any-signal`, `p-retry`, cadre-core |
| `BroadcastChannel` | `broadcast-channel.ts` | a channel that delivers to nobody | `mortice`, the mutex behind libp2p's peer-store write lock |
| `WebSocket` | `websocket.ts` | imports `@valor/nativescript-websockets` | `@libp2p/websockets` |
| `WebSocket.prototype.bufferedAmount` | `websocket.ts` | a getter that returns 0 | `@libp2p/websockets` |

The reasons that are not evident from the table:

- **`process` is loaded first and never names itself.** `@nativescript/webpack`'s `DefinePlugin` rewrites every bare `process` identifier to `global.process`, which the runtime does not define, so the first module that reads `process.env` throws. The shim assigns `globalThis.process` and refers to it only through `globalThis`, because a bare reference inside the shim would be rewritten too.
- **Only `digest` is added to `crypto.subtle`.** The runtime's own `generateKey`, `sign` and `verify` are kept.
- **`Intl` needs real time zone data.** NativeScript's Android V8 is compiled without internationalisation support and no application setting turns it on. Quereus computes `Temporal.ZonedDateTime` values in named zones, so a stub that knew only UTC would return wrong results without an error. `intl-pluralrules.ts` loads first because it creates the `Intl` object the `@formatjs` polyfills extend.
- **The local time zone is read from Android.** The `@formatjs` polyfill cannot detect the device's zone and assumes UTC. On Android the shim reads `java.util.TimeZone.getDefault()` and registers it.
- **`abort.ts` loads after `event.ts`.** NativeScript has no `AbortSignal` to patch, so the shim builds the whole class on the polyfilled `EventTarget`.
- **A `BroadcastChannel` that reaches nobody is correct.** A NativeScript app is one JavaScript context with no workers, and `mortice` does its in-process locking through its own emitter. Without the global the peer store's first write throws.
- **`websocket.ts` imports the plugin itself.** The `bufferedAmount` patch must run after the plugin has installed the global; a patch that ran first would find nothing to patch and report no error.
- **`bufferedAmount` must be a number.** `@libp2p/websockets` sends only while `bufferedAmount` is below its limit. The plugin declares the field and never assigns it, so the comparison is false, libp2p never writes the handshake, and every outbound dial ends at the dial timeout. Zero is accurate: the plugin hands each frame to the native socket inside `send()` and keeps no queue in JavaScript.
- **`TextDecoder` has a twin.** `text-decoder.ts` is the same decoder as the one in `packages/cadre-rn/polyfills/hermes.js`. Both are tested against Node's decoder on the inputs in `test-harness/utf8-decoder-inputs.ts`, so a fix to one belongs in the other.

### The boot audit

`runPolyfillAudit` (`src/polyfills/audit.ts`) logs one line per global the stack needs, marked `✓` native, `∙` polyfilled or `✗` missing, and warns when any is missing. It runs before any libp2p module is evaluated. Its purpose is to show a change in what a NativeScript release provides at startup, with the global's name, instead of as an unrelated failure inside libp2p. An app that copies the shims should copy the audit and extend its probe list with each global it adds.

## Webpack configuration

NativeScript builds with webpack 5 through `@nativescript/webpack`. `packages/reference-app-ns/webpack.config.js` adds the rules described in this section, most of them through `webpack.chainWebpack`. They do for webpack what the React Native kit's Metro helper does for Metro ([React Native → Metro configuration](react-native.md#metro-configuration)).

### Export-condition resolution

```js
config.resolve.set('conditionNames', [
	'react-native', 'browser', 'module', 'import', 'require', 'default',
]);
```

`react-native` makes `@optimystic/db-p2p` resolve to its `rn.js` entry, which does not import `@libp2p/tcp`. `browser` makes `@libp2p/websockets` and similar packages resolve to their browser files. `node` is left out because the NativeScript runtime has no Node APIs.

### Node built-in shims (`resolve.fallback`)

NativeScript sets `externalsPresets.node: false`, so an import of a Node built-in is bundled, not left external, and must resolve to something.

| Module | Resolves to | Why |
|---|---|---|
| `os` | `src/polyfills/node-os.ts` | `@libp2p/utils` calls `networkInterfaces()`; the shim returns `{}` |
| `crypto` | `src/polyfills/node-crypto.ts` | `multiformats/hashes/sha2` calls `createHash`; nothing else is implemented |
| `tty` | `src/polyfills/node-tty.ts` | `debug` and `weald` call `tty.isatty` whenever a logger is created; an empty module throws |
| `cluster` | `src/polyfills/node-cluster.ts` | `mortice` reads `cluster.isPrimary` and calls `cluster.on('message')`; an empty module throws |
| `stream` | `readable-stream` | libp2p stream handling |
| `net`, `tls`, `http`, `https`, `http2`, `zlib`, `dns`, `dgram`, `fs`, `child_process`, `worker_threads` and the others listed in the file | `false` (an empty module) | imported on Node-only branches that a node without TCP never runs; they must resolve for the bundle to build |

`buffer`, `events`, `util` and `string_decoder` need no entry because npm packages of those names are installed.

### `node:` scheme stripping

With `externalsPresets.node: false`, webpack treats `node:os` as a URL with an unknown scheme and fails with `UnhandledSchemeError`. A `NormalModuleReplacementPlugin` rewrites `node:foo` to `foo`, so both spellings reach `resolve.fallback`.

### Named-package Node → browser rewrite

Some packages ship parallel `*.browser.js` files and select them only through the top-level `browser` map in `package.json`, not through `exports`. `conditionNames` cannot select such files, and webpack's `browser` alias field does not apply the map to the package's own relative imports. For each package named in `BROWSER_MAP_PACKAGES` (`packages/reference-app-ns/browser-map.js`), a `NormalModuleReplacementPlugin` applies the map itself: a relative `.js` import whose path inside the package is a key of the map is redirected to the mapped file. Each installed copy of a package is rewritten from its own `package.json`.

The listed packages:

- **`@libp2p/crypto`.** Its Node files for Ed25519, secp256k1, RSA and ECDH keys, HMAC and AES-GCM call Node key APIs that the `createHash`-only `crypto` shim does not have, so generating the node's identity throws. The browser files use `@noble/curves` and WebCrypto.
- **`main-event`.** Its Node `events.js` calls the static `setMaxListeners` from `node:events`, which the npm `events` package does not have. Every call throws a `TypeError` that the package catches, and libp2p makes one for each abort signal it creates. The browser file does nothing.

A package joins the list only when its Node file is found to fail or to cost something on NativeScript. Other packages' Node files are bundled (`mortice`, `weald`, parts of `libp2p` and `@libp2p/utils`) and none is known to matter. `scripts/bundle-check.js` fails when a bundled file is one the rewrite should have replaced, because a rewrite that has stopped working still compiles and fails only on a device.

### libp2p user agent

`libp2p.js` imports `./user-agent.js` by relative path, so no export condition applies and webpack bundles the Node file. That file reads `process.versions.node`, which the `process` shim does not have, and throws inside the `Libp2p` constructor. libp2p's React Native file is no use either, because it imports React Native's `Platform` module. A `NormalModuleReplacementPlugin` redirects the import, in every installed copy of libp2p, to `src/shims/libp2p-user-agent.js`, which returns a fixed string.

### Noise crypto

`@chainsafe/libp2p-noise`'s default crypto replaces its pure-JavaScript X25519 and SHA-256 with `node:crypto` calls (`generateKeyPairSync`, `createPrivateKey`, `diffieHellman`), which the `crypto` shim does not implement, so the `Noise` constructor throws. The package's `exports` offer no browser condition for that module, and db-p2p calls `noise()` without a `crypto` override. A `NormalModuleReplacementPlugin` redirects the package's `crypto/index.js` to `src/shims/noise-crypto.js`, which binds every name the module exports to the `@noble` implementation. The wire protocol is unchanged.

### ES2022 downlevel + modern output

libp2p packages such as `@libp2p/peer-store` and `@libp2p/circuit-relay-v2` publish ES2022 private methods (`async #method`). The NativeScript 8 build parses files under `node_modules` at a lower language level and rejects them. An `esbuild-loader` rule rewrites the syntax to `es2020` for everything under `node_modules` except `@nativescript`'s own packages. The runtime supports the newer syntax; the rule exists only for the build-time parser. For the same reason `output.environment` lets webpack emit arrow functions, `async`, `const` and optional chaining in its own runtime code.

### `exportsPresence: 'warn'`

`@nativescript/webpack`'s base configuration puts the app's own `node_modules` directory first in `resolve.modules`. A bare import made from inside a nested `node_modules` therefore resolves to the app's hoisted copy of a package, even when a different version sits beside the importing file. When the two versions export different names, webpack reports a missing export, and for strict ESM that is an error. Metro tolerates the same imports.

The configuration lowers the error to a warning (`exportsPresence: 'warn'`) and suppresses four known messages through `ignoreWarnings`, matched by export and module name: `StrictSign`, `StrictNoSign` and `TopicValidatorResult` from `@libp2p/interface`, and `streamMessage` from `protons-runtime`. `scripts/bundle-check.js` fails on any other warning, so a new missing export still stops the build.

None of the four is expected from the packages installed in this repository: `@chainsafe/libp2p-gossipsub`, the importer of the three `@libp2p/interface` names, is not installed, and the `protons-runtime` the app hoists exports `streamMessage`. Whether the bundle check passes without the override has not been confirmed. An app that copies this configuration should try its build without the override first.

## Where node state is kept

`ns-edge-platform.ts` keeps everything in SQLite, in two kinds of database. [Node-local state](../cadre/node.md#node-local-state) lists the same records for every platform.

### The identity database

`sereus-peer-identity` exists once per install and holds what must be read before the party is known. It cannot be named after the party, because the party id is one of the records in it. Its `kv` table holds two things in separate columns.

- **The key store** (`EdgeNodePlatform.keyStore`), as bytes in `b_val`. The node's identity is under the key `peer-private-key`. Every other slot (the owner key, the joined-strand records, the strand-move records) is under `keystore.<slot id>`. Each write is followed by a synced commit, because a key may found a party and a key lost to a power cut would leave that party with an owner nobody holds. A row whose `b_val` holds no bytes raises `KeyStoreAccessError`; reading it as an empty slot would let the node write a new key over it.
- **The node-local records** (`EdgeNodeStorage.nodeLocal`), as text in `s_val`, through one `SqliteKVStore` with an empty key prefix. They are the saved start (`start-options`), the dissolve marker (`dissolving-party`), and for each party the trusted-owner anchor, cold-start dial targets, enrolled-machine count and strand network state (`trusted-owners.<partyId>`, `bootstrap-peers.<partyId>`, `enrolled-machines.<partyId>`, `strand-network.<partyId>`).

The identity, the owner key and the anchor are in one file on purpose: clearing the app's data removes all three together, so a new identity never inherits an old anchor.

### One database per storage scope

cadre-core asks for storage by scope key: `controlStorageScope(partyId)` for the party's control database and the strand id for each strand ([Storage](../cadre/node.md#storage)). The platform names the database `sereus-<scope>`. The control key contains the party id, so two parties on one device use two databases.

- **One call opens all of the scope's storage.** `sqliteNodeStorage` returns the scope's blocks, the node-local records the node must keep across a restart (its blob records, the owed-blob and under-replication ledgers, the clock's high-water mark and its transaction state) and the blob pieces this phone holds, over the one connection. It asserts that all three report one store identity, so everything the node keeps is inside the one file its block store measures.
- **Opened on first use.** `EdgeNodeStorage.nodeStorage` is asynchronous, so the platform opens the database and then the storage over it; nothing is opened ahead of a start or a strand launch.
- **One open per database name.** Every caller for a scope shares one connection and one set of stores. The platform caches the pending open, not the handle, so two first uses that overlap do not open two native handles on one file. A failed open is forgotten: the operations waiting on it fail with its error and the next operation opens again.
- **Closed by every stop.** A stop, and a failed start, flush and close the identity database and every scope's node storage and then its database (`EdgeNodeStorage.close`). Node storage goes first because it flushes the pieces and the key-value store and closes the block store, all of which write through the connection the next step closes. The next start reopens them. A screen must therefore not keep a strand instance across a stop; the reference app's view model drops its strand list whenever the edge node reports `stopped`, `removed` or `failed`.
- **Deleted by a removal or a dissolve.** `destroyScope` closes the scope's node storage and then its handle, and deletes the file with the plugin's `deleteDatabase`.

### The offline journal

`EdgeNodeStorage.offlineJournal` returns the scope's own key-value store — the one `sqliteNodeStorage` opened — rather than a second store over its database. Optimystic declares the journal's key prefix among the node's own key-value namespaces for exactly this sharing, so the journal's rows stay out of every block listing, and a strand's queued writes are flushed and closed with the rest of that scope's storage. Offline mode is therefore available on NativeScript ([Offline mode](../strands/writes.md#offline-mode)); what the reference chat does not yet have is the surface for it — a toggle, a queue line, per-message progress (ticket `feat-strand-offline-mode-nativescript`).

### The storage allotment

SQLite reports no free space of its own, so the platform declares how much of the device a node may use: `DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES`, 2 GiB. The figure bounds **each** network the node serves rather than the device, and it is what the node measures itself against as it fills ([The storage allotment](../cadre/node-storage.md#the-storage-allotment)); without it a node here could not tell how full it is at all.

### Opening a database on Android

The SQLite plugin opens a bare name through `Activity.openOrCreateDatabase` and throws when no Activity exists yet, which is the case when the node starts itself at launch. `src/ns-db-path.ts` passes the absolute path under the app's databases directory instead (`Context.getDatabasePath(name)`), which the plugin opens without an Activity. It is the same file a bare name would open.

### The saved start

The edge node saves the options of each successful start under `start-options` and reads them back at launch (`EdgeNode.loadSavedStart`). The record is not filed under a party id because it is what selects the party. An app reads it once at launch to start the node unattended when `autoStart` is true and to prefill its connection form. Uninstalling the app deletes the SQLite files, identity included, so a reinstalled app is a new node in a new party.

## Limits and accepted tradeoffs

- **Keys are stored in plaintext.** The identity, the owner key and the trusted-owner anchor are in an unencrypted SQLite file, where React Native uses the platform secure store. NativeScript has no Keychain or Keystore integration here. Whoever adds one must move the identity, the owner key and the anchor together, because protecting one of them alone protects nothing.
- **Offline mode has no app surface.** The platform keeps the journal, so `EdgeNode.setStrandOfflineMode` works, but the reference chat offers no toggle, queue line or per-message progress as the other two reference apps do (ticket `feat-strand-offline-mode-nativescript`).
- **No WebRTC.** The node has WebSocket and relay transports only, so a connection made through a relay stays on the relay.
- **Noise runs in JavaScript.** The Noise shim uses `@noble` for every handshake and every frame, and the platform supplies no `EdgeNodePlatform.noiseCrypto`. React Native replaces the same code with native crypto because it dominates connection setup on Hermes; the cost on NativeScript has not been measured.
- **Android only.** The package declares `@nativescript/android` and no iOS runtime, and `scripts/bundle-check.js` compiles for Android. The local time zone is read through an Android API, so on iOS the implicit zone would be UTC. Nothing else about iOS is established.
- **The polyfills are narrow.** `TextDecoder` decodes UTF-8 only and throws `RangeError` for another encoding. `Intl.PluralRules` knows English only. `@formatjs` carries `en` locale data only.
- **`AbortSignal.any` can retain listeners.** A combined signal none of whose inputs ever aborts keeps its listeners on those inputs for as long as they live, because the runtime offers no weak reference to release them. `yarn lint` keeps first-party source off `AbortSignal.any` and `AbortSignal.timeout` (`PHONE_RUNTIME_GUARD` in `eslint.config.mjs`).
- **Nested dependency versions are not honoured.** Because the app's `node_modules` is searched first, a dependency that needs a different major version of a package than the app hoists gets the hoisted one. The build guards against one symptom of that, a missing export, by suppressing four named messages. Nothing reports when a suppressed message stops occurring, so the list can outlive its cause. (ticket `debt-reference-app-ns-resolve-nested-libp2p-deps`)
- **The bundle check does not run the code.** `yarn workspace @serfab/reference-app-ns test:bundle` proves that the whole import graph resolves and parses. Whether a shim works is known only from a device, which is why the audit runs at every launch.
