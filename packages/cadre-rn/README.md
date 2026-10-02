# @serfab/cadre-rn

The React Native kit for Sereus apps. A React Native app that runs a `@serfab/cadre-core` node depends on this package for the platform-specific pieces, instead of copying them from the reference app.

Every entry point is a subpath; there is no root import. An app loads only the parts it uses, so it installs only the native modules those parts need.

| Import | What it provides |
|---|---|
| `@serfab/cadre-rn/key-store` | `SecureStoreKeyStore`: cadre-core's `KeyStore` over the platform secure store, so the node identity lives in the iOS Keychain / Android Keystore rather than plaintext storage |
| `@serfab/cadre-rn/node-local` | `secureStoreSlot`, `kvStoreSlot` and the record keys: the `DurableSlot`s cadre-core's node-local stores (trusted owners, bootstrap peers, enrolled machines, strand network state) persist through |
| `@serfab/cadre-rn/noise-crypto` | `buildNoiseCrypto(mode)`, `NoiseCryptoMode`, `DEFAULT_NOISE_CRYPTO_MODE`: runs libp2p's Noise connection encryption in native code |
| `@serfab/cadre-rn/polyfills` | Side effects only: the web APIs libp2p and Optimystic read that Hermes and React Native lack (`AbortSignal.timeout` / `any`, abort reasons, `WebSocket.prototype.bufferedAmount`, `Promise.withResolvers`, `structuredClone`, `DOMException`, `crypto.subtle.digest`, EventTarget / `CustomEvent`, `Intl.PluralRules`, timer `ref()` / `unref()`, and more) |
| `@serfab/cadre-rn/polyfills/webrtc` | Side effects only: `react-native-webrtc`'s `registerGlobals()`, for apps that use `@libp2p/webrtc` |
| `@serfab/cadre-rn/boot-check` | Side effects only, development builds only: a boot-time table of which globals are native, polyfilled, known gaps or missing, and a `[reload] <reason>` log line before any reload started from JavaScript |
| `@serfab/cadre-rn/metro` | CommonJS, for `metro.config.js`: `withCadreMetro(config, options)` adds the Metro settings a Sereus app needs (Node built-in shims, one copy of each native module, libp2p's browser variants) |

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

The trust-bearing anchor goes in the secure store; the dial hints, the enrolled-machine count and the strand network state go in a LevelDB database of the app's own (`nodeLocalKv` above is a `LevelDBKVStore` over it), because they grant no authority and outgrow the secure store's value limit. The module headers give the reasoning; the reference app's `src/cadre-phone.ts` is the worked example.

Use the same options object for the key store and the anchor slot. `keychainAccessible: AFTER_FIRST_UNLOCK` lets iOS read the identity while the device is locked, which a background or push-wake start needs. `secureStoreSlot` refuses a gated (`requireAuthentication`) slot, because it reads `null` as absent.

### What the app must install

`@serfab/cadre-core` (an optional peer: only these two subpaths use it), and the secure-store module it passes in: `expo-secure-store` under Expo, or the bare app's own choice. The LevelDB store is the app's `@optimystic/db-p2p-storage-rn`, which it already has for strand storage.

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

### What the app must install

React Native links native modules only for the app's own direct dependencies, so the app lists these in its `package.json`:

- `react-native-quick-crypto` (`^1.1.7`)
- `react-native-nitro-modules` (`>=0.31.2`), quick-crypto's native bridge
- `react-native-quick-base64` (`>=3.0.0`), which quick-crypto imports

`react-native-quick-crypto` needs React Native's new architecture. `@craftzdog/react-native-buffer`, which this module imports, is installed by quick-crypto itself; under a package manager that does not hoist (pnpm's default layout), list it in the app too.

All four are optional peer dependencies of this package: an app that never imports `/noise-crypto` does not need them. This module imports only quick-crypto and the buffer; nitro and quick-base64 are peers so that `/metro` resolves them from the app as well, keeping one copy of each.
