# @serfab/cadre-rn

The React Native kit for Sereus apps. A React Native app that runs a `@serfab/cadre-core` node depends on this package for the platform-specific pieces, instead of copying them from the reference app.

Every entry point is a subpath; there is no root import. An app loads only the parts it uses, so it installs only the native modules those parts need.

| Import | What it provides |
|---|---|
| `@serfab/cadre-rn/phone-node` | `createPhoneNode(platform)`: builds, starts, stops and rebuilds the phone's `CadreNode` the prescribed way, plus `attachStrandWhenWritable` and `retryAfterRestart` |
| `@serfab/cadre-rn/lifecycle` | `createBackgroundRunner`: hibernates the node's strands when the app goes to the background and resumes, bounded, when it returns; `phoneNodeLifecycle(phone)` connects it to a phone node |
| `@serfab/cadre-rn/key-store` | `SecureStoreKeyStore`: cadre-core's `KeyStore` over the platform secure store, so the node identity lives in the iOS Keychain / Android Keystore rather than plaintext storage |
| `@serfab/cadre-rn/node-local` | `secureStoreSlot`, `kvStoreSlot` and the record keys: the `DurableSlot`s cadre-core's node-local stores (trusted owners, bootstrap peers, enrolled machines, strand network state) persist through |
| `@serfab/cadre-rn/noise-crypto` | `buildNoiseCrypto(mode)`, `NoiseCryptoMode`, `DEFAULT_NOISE_CRYPTO_MODE`: runs libp2p's Noise connection encryption in native code. Loading it also switches `crypto.subtle.digest` to native SHA-256/512 (see `native-digest`) |
| `@serfab/cadre-rn/native-digest` | `installNativeDigest(createHash)`, `nativeDigestActive()`: replaces the boot polyfill's JavaScript `crypto.subtle.digest` with a native hash |
| `@serfab/cadre-rn/polyfills` | Side effects only: the web APIs libp2p and Optimystic read that Hermes and React Native lack (`AbortSignal.timeout` / `any`, abort reasons, `WebSocket.prototype.bufferedAmount`, `Promise.withResolvers`, `structuredClone`, `DOMException`, `crypto.subtle.digest`, EventTarget / `CustomEvent`, `Intl.PluralRules`, timer `ref()` / `unref()`, and more) |
| `@serfab/cadre-rn/native-ed25519` | `installNativeEd25519(nativeSubtle)`, `nativeEd25519Active()`: fills `crypto.subtle`'s missing Ed25519 methods from a native WebCrypto |
| `@serfab/cadre-rn/polyfills/native-crypto` | Side effects only: native Ed25519 and SHA-256/512 behind `crypto.subtle` from boot, through `react-native-quick-crypto` |
| `@serfab/cadre-rn/polyfills/webrtc` | Side effects only: `react-native-webrtc`'s `registerGlobals()`, for apps that use `@libp2p/webrtc` |
| `@serfab/cadre-rn/boot-check` | Side effects only, development builds only: a boot-time table of which globals are native, polyfilled, known gaps or missing, and a `[reload] <reason>` log line before any reload started from JavaScript |
| `@serfab/cadre-rn/metro` | CommonJS, for `metro.config.js`: `withCadreMetro(config, options)` adds the Metro settings a Sereus app needs (Node built-in shims, one copy of each native module, libp2p's browser variants) |

## Phone node

`createPhoneNode` is a phone app's whole node bring-up. It keeps the identity in the secure store, opens the four node-local stores party-scoped, gives each storage scope its own LevelDB database, makes the phone its party's owner, and remembers the last start so the app can start again unattended. Call it once, at module scope; a second call over the same storage names throws while the first is running.

```ts
import * as SecureStore from 'expo-secure-store';           // or an adapter over the app's own secure store
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { createPhoneNode } from '@serfab/cadre-rn/phone-node';
import { buildNoiseCrypto, DEFAULT_NOISE_CRYPTO_MODE } from '@serfab/cadre-rn/noise-crypto';

export const phone = createPhoneNode({
	secureStore: SecureStore,
	secureStoreOptions: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
	leveldb: { openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch },
	noiseCrypto: { build: buildNoiseCrypto, defaultMode: DEFAULT_NOISE_CRYPTO_MODE },
	names: { storagePrefix: 'myapp-', nodeLocalDb: 'myapp-node-local', nodeLocalKvPrefix: 'myapp:node-local:' },
	dataVersion: '1',
});

// Register strand handling before the first start: strands joined from another party
// come back through `strand:discovered` after every start.
phone.on('strand:discovered', ({ strand }) => { /* attachStrandWhenWritable(phone.node!, { strandRow: strand, sAppConfig }) */ });

const saved = await phone.loadSavedStart();
if (saved?.autoStart) await phone.start(saved.options);
```

| Member | What it does |
|---|---|
| `start(options)` | Starts the node, or joins the start in flight; a running node is returned as is. A start called during a stop or restart runs after it, so it never builds on databases being closed. A failed start closes everything it opened and leaves `status` `failed`. A successful one saves its options with `autoStart: true`. |
| `stop()` | The user's disconnect: waits for a start in flight, saves `autoStart: false`, stops the node, and closes every database it opened (rn-leveldb locks each name, so one left open fails the next start). |
| `restart(options)` | Rebuilds the node with new relays or a new Noise mode, which libp2p reads only when the node is built. Leaves `autoStart` set. |
| `loadSavedStart()` | The last successful start's options, `autoStart`, and `writtenBy`: the `dataVersion` of the build that wrote this device's data, for the app to compare with its own. During a stop it answers after the stop has saved `autoStart: false`. |
| `on(event, handler)` | A node event for the life of the phone node: re-applied to every node a start or restart builds. Returns an unsubscribe. |
| `status`, `onStatus` | `stopped`, `starting`, `running` (with `owner`: `enrolled`, `failed` or `timed-out`), or `failed` (with the error). |

Platform options with defaults:

- **`transports`**: WebSockets and circuit relay. An app with `react-native-webrtc` adds `webRTC({ rtcConfiguration: { iceServers: resolveStunServers(relayAddrs) } })`, as the reference app does.
- **`allowPrivateDial`**: `true`. Dials loopback, private and plain `ws://` addresses, which libp2p's React Native gater refuses. Without it an emulator cannot reach `10.0.2.2`, and a relay on the home network or without TLS is unreachable.
- **`ownerGenesisTimeoutMs`**: 60 s.
- **`configure(config)`**: none. The last word on the generated `CadreNodeConfig`: strand filter, `requireSignedSchemas`, `linkRoundTripMs`.

Two helpers for code that uses the node:

- `attachStrandWhenWritable(node, config)` treats a first sync that outlasts `addStrand`'s budget as progress and waits for the strand to become writable.
- `retryAfterRestart(write)` retries a write that fails for want of a super-majority, as the first writes after a node restarts alone do.

### What the app must install

`@serfab/cadre-core`, `rn-leveldb` and its secure-store module. `@optimystic/db-p2p-storage-rn` and the default transports are dependencies of the kit. `@libp2p/webrtc` and `react-native-webrtc` only if the app adds WebRTC.

## Lifecycle

`createBackgroundRunner` follows react-native's `AppState`.

- **On `background`** it hibernates the node's strands and keeps the control connection up for as long as the OS allows. It drops to `background-hibernating` when the control network disconnects.
- **On `active`** it starts the node again if the OS killed it. It then waits, bounded, for the control network to reconnect, and reports `degraded` if it does not. `inactive` (an incoming call, the app switcher) does nothing.
- **Rapid flapping** is safe: a later transition always wins over an earlier one still in progress.

```ts
import { AppState } from 'react-native';
import { createBackgroundRunner, phoneNodeLifecycle } from '@serfab/cadre-rn/lifecycle';

const runner = createBackgroundRunner({ ...phoneNodeLifecycle(phone), appState: AppState });
runner.onStateChange(() => render(runner.state, runner.resuming, runner.degraded));
runner.start();   // once the node is running; runner.stop() on logout
```

`phoneNodeLifecycle(phone)` supplies the runner's two node hooks from a `PhoneNode`. Its cold start uses the saved start, and only while `autoStart` is set, so a node the user stopped stays stopped. An app that must refresh its own state after a cold start passes its own `ensureNode` instead.

The runner never imports `react-native`: `AppState` is assignable to its `AppStateLike`, and tests pass a fake. A push wake (FCM/APNs) is the app's own; the reference app's `push-wake*.ts` is the worked example.

## Key store and node-local records

cadre-core asks its host for durable storage: a `KeyStore` for the node identity (`keyStore` in `CadreNodeConfig`, never `privateKey` on a phone) and a `DurableSlot` behind each node-local store (`trustedOwners`, `bootstrapPeers`, `enrolledMachines`, `strandNetworkState`). Left out, each falls back to memory, and a phone that restarts before it reconnects loses its dial hints and its trusted owners. These two subpaths are the phone's answer.

Both talk to the secure store through `SecureStoreApi`, three async methods (`getItemAsync`, `setItemAsync`, `deleteItemAsync`) over string values. `expo-secure-store` is structurally assignable to it. A bare React Native app passes an adapter over its own secure-storage module that keeps the same contract: `null` for an absent key, a throw for a denied or failed read. Neither subpath imports a native module.

```ts
import * as SecureStore from 'expo-secure-store';
import { SecureStoreKeyStore } from '@serfab/cadre-rn/key-store';
import { anchorSlotKey, bootstrapPeersKvKey, kvStoreSlot, secureStoreSlot } from '@serfab/cadre-rn/node-local';
import { PersistentBootstrapPeerStore, PersistentTrustedOwnerStore } from '@serfab/cadre-core';

const options = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const keyStore = new SecureStoreKeyStore(SecureStore, options);
const trustedOwnerStore = await PersistentTrustedOwnerStore.open(
	secureStoreSlot(SecureStore, anchorSlotKey(partyId), options), partyId);
const bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
	kvStoreSlot(nodeLocalKv, bootstrapPeersKvKey(partyId)), partyId);
```

The trust-bearing anchor goes in the secure store; the dial hints, the enrolled-machine count and the strand network state go in a LevelDB database of the app's own (`nodeLocalKv` above is a `LevelDBKVStore` over it), because they grant no authority and outgrow the secure store's value limit. The module headers give the reasoning. `createPhoneNode` (above) wires all of this; these subpaths are for an app that builds its node another way.

Use the same options object for the key store and the anchor slot. `keychainAccessible: AFTER_FIRST_UNLOCK` lets iOS read the identity while the device is locked, which a background or push-wake start needs. `secureStoreSlot` refuses a gated (`requireAuthentication`) slot, because it reads `null` as absent.

### What the app must install

`@serfab/cadre-core` (an optional peer, needed by every subpath that builds or persists a node: these two, `/phone-node` and `/lifecycle`), and the secure-store module it passes in: `expo-secure-store` under Expo, or the bare app's own choice. The LevelDB store is the app's `@optimystic/db-p2p-storage-rn`, which it already has for strand storage.

## Polyfills and boot check

**Import `@serfab/cadre-rn/polyfills` before anything else.** libp2p and its dependencies read these globals while their modules evaluate, so a library module that loads first has already captured `undefined`, and the failure shows up much later as an unrelated timeout. Nothing in the package can enforce the order; the app's entry file must:

```js
// index.js: the app's entry module (package.json "main")
import '@serfab/cadre-rn/polyfills';          // first
import '@serfab/cadre-rn/polyfills/webrtc';   // only if the app uses @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';         // after every polyfill, before the app
import 'expo-router/entry';                   // or AppRegistry.registerComponent(...)
```

`boot-check` goes after every polyfill and before the app's own code because both of its parts act at import time: the audit table has to print before an import-time crash could, and the reload logger has to be installed before the app tree evaluates. In a development build logcat shows the table under `[cadre-rn] polyfill audit`, and warns with `[cadre-rn] MISSING globals` if a global the stack reads is absent. `RTCPeerConnection` reads as a known gap in an app that does not import `/polyfills/webrtc`.

Each patch checks for the API first and does nothing where the runtime already provides it. The reference app's [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#polyfills) lists what each one patches and which library needs it.

### What the app must install

React Native links native modules only for the app's own direct dependencies, so the app lists these in its `package.json` and rebuilds its native app after adding them:

- `react-native-get-random-values` (`^1.11.0`), for `/polyfills`: the native random source behind `crypto.getRandomValues`. There is deliberately no `Math.random` fallback.
- `react-native-webrtc` (`^124.0.6`), for `/polyfills/webrtc` only.

Both are optional peer dependencies of this package, as is `react-native` itself (`boot-check` imports its `DevSettings`). The pure-JavaScript polyfill libraries (`@ungap/structured-clone`, `web-streams-polyfill`, `event-target-polyfill`, `@noble/hashes`) are ordinary dependencies of this package; the app does not list them.

## `@serfab/cadre-rn/metro`

`withCadreMetro` takes the config the app's own toolchain produced, adds the Sereus settings to it and returns it, so an app's `metro.config.js` is one call. With Expo:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

With bare React Native:

```js
// metro.config.js
const { getDefaultConfig } = require('@react-native/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

| Option | Meaning |
|---|---|
| `projectRoot` | The app's directory (`__dirname`). |
| `linkedRoots` | Optional. Local checkouts whose packages are linked into the app (a monorepo root, sibling repositories). Each is watched, and its `node_modules` is searched after the app's own. Omit it when every package comes from npm. |

What it adds, keeping whatever the incoming config already set (lists are appended to, an alias the app already has wins, an existing `resolveRequest` is called by the new one):

- Symlink support, and the `linkedRoots` as watch folders and module search paths.
- Aliases for the Node built-ins libp2p imports: `os` and `crypto` to small shims in this package, `net` and `tls` to an empty module, `stream` and `buffer` to the `readable-stream` and `buffer` packages. Both the bare and the `node:` names are mapped.
- A `resolveRequest` that resolves this package's peer dependencies (`react-native` and the native modules) from the app, whoever imports them, so the bundle holds one copy of each; resolves `@babel/runtime` helpers to their CommonJS files from the app's copy; and swaps `@libp2p/crypto` and `@libp2p/webrtc` files for the `browser` variants their package lists, which run under Hermes.

It relies on the toolchain's defaults for package exports (both Expo's and React Native's enable them) and leaves condition names to the app. The reference app's [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#metro-configuration) explains each setting; the comments in `metro/index.cjs` have the full reasoning.

The app installs nothing extra for `/metro`. The peers it resolves are the ones the other subpaths already need, and only if something imports them.

## `@serfab/cadre-rn/noise-crypto`

Metro resolves `@chainsafe/libp2p-noise`'s browser build, so on React Native every connection handshake and every encrypted frame runs SHA-256, ChaCha20-Poly1305 and X25519 in JavaScript on Hermes. SHA-256 over 512 bytes was measured at about 15 ms on a Galaxy S7 and 5 ms on an Android emulator, against 0.03 ms in Node on the emulator's own machine. `buildNoiseCrypto` returns a Noise crypto implementation backed by `react-native-quick-crypto` instead (the source file's header comment has the full measurements).

```ts
import { buildNoiseCrypto, DEFAULT_NOISE_CRYPTO_MODE } from '@serfab/cadre-rn/noise-crypto';

const config: CadreNodeConfig = {
	// ...
	network: {
		// ...
		noiseCrypto: buildNoiseCrypto(DEFAULT_NOISE_CRYPTO_MODE),
	},
};
```

| Mode | Effect |
|---|---|
| `'off'` | Returns `undefined`: Noise keeps its pure-JavaScript default. |
| `'symmetric'` (default) | Native SHA-256 and ChaCha20-Poly1305, the per-frame costs. X25519 stays pure JavaScript. |
| `'full'` | Also native X25519 key generation and Diffie-Hellman. It has had less device time than `'symmetric'`. |

Every mode starts from `noisePureJsCrypto` and overrides only its own functions, so anything it does not replace (`getHKDF`, for one) keeps working.

cadre-core reads `network.noiseCrypto` only when it builds the node. Changing the mode means stopping the node and starting a new one.

The reference app (`packages/reference-app-rn`) is the worked example: it takes the mode as a start option, defaults it from a build-time `EXPO_PUBLIC_NOISE_CRYPTO`, offers the three modes in its Settings screen, and shows the running node's mode on the Node card. [`docs/reference-app-rn.md`](../../docs/reference-app-rn.md#phone-rn-app-configuration) walks through it.

### Native hashing comes with it

Loading this subpath also calls `installNativeDigest` (`@serfab/cadre-rn/native-digest`) with quick-crypto's `createHash`, so the boot polyfill's JavaScript `crypto.subtle.digest` is replaced with native SHA-256/512. Optimystic hashes every block through that digest (multiformats' `sha256`), and in pure JavaScript it took 47% of a phone app's JS time. Hashing done before the import uses the JavaScript fallback.

### What the app must install

React Native links native modules only for the app's own direct dependencies, so the app lists these in its `package.json`:

- `react-native-quick-crypto` (`^1.1.7`)
- `react-native-nitro-modules` (`>=0.31.2`), quick-crypto's native bridge
- `react-native-quick-base64` (`>=3.0.0`), which quick-crypto imports

`react-native-quick-crypto` needs React Native's new architecture. `@craftzdog/react-native-buffer`, which this module imports, is installed by quick-crypto itself; under a package manager that does not hoist (pnpm's default layout), list it in the app too.

All four are optional peer dependencies of this package: an app that never imports `/noise-crypto` does not need them. This module imports only quick-crypto and the buffer; nitro and quick-base64 are peers so that `/metro` resolves them from the app as well, keeping one copy of each.

## `@serfab/cadre-rn/native-digest`

`installNativeDigest(createHash, subtle?)` replaces `crypto.subtle.digest` with one over a Node-style `createHash`, for SHA-256 and SHA-512; any other algorithm stays with the previous digest. It replaces only the digest `polyfills/hermes.js` tagged as its JavaScript fallback, so real WebCrypto, or a digest the app installed itself, is left alone. It checks the hash against a known SHA-256 vector first, and keeps the fallback, with a warning, if the check fails. It returns `'installed'`, `'already'`, `'not-polyfilled'` or `'check-failed'`. `nativeDigestActive()` reports whether the native digest is in place.

It imports no native module. `noise-crypto` calls it, so an app that passes native Noise crypto needs nothing more; an app that does not can call it with its own `createHash` after the polyfills have loaded.

## Native Ed25519 (`@serfab/cadre-rn/polyfills/native-crypto`)

@libp2p/crypto signs and verifies Ed25519 through WebCrypto when it can, and otherwise in pure JavaScript (`@noble/curves`). Hermes has no WebCrypto beyond the boot polyfill's digest, so without this a phone does every signature in JavaScript: 169 ms per verify on a Galaxy S7, against 0.72 ms native (measured by sereus-chat).

```js
// index.js
import '@serfab/cadre-rn/polyfills';
import '@serfab/cadre-rn/polyfills/native-crypto';   // right after /polyfills, before libp2p
import '@serfab/cadre-rn/boot-check';
```

It fills `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from react-native-quick-crypto's `subtle`, only where the global `crypto.subtle` lacks them, and installs the native digest (`native-digest`) at the same time. **It has to load at boot**: @libp2p/crypto decides between WebCrypto and JavaScript once, when its Ed25519 module is evaluated, and keeps the answer, so filling the methods later -- from `noise-crypto`, which itself imports libp2p -- would be too late for Ed25519. The digest has no such constraint.

`installNativeEd25519(nativeSubtle, subtle?)` (`@serfab/cadre-rn/native-ed25519`) is the logic, importing no native module: all or nothing, so a probe never sees half a WebCrypto, and a complete WebCrypto is left alone. It returns `'installed'`, `'already'`, `'not-needed'` or `'unavailable'`.

### What the app must install

react-native-quick-crypto, react-native-nitro-modules and react-native-quick-base64, as for `noise-crypto`, and a native rebuild. Quick-crypto needs React Native's new architecture.

