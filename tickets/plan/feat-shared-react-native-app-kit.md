description: Every Sereus phone app built with React Native currently copies the same startup code: the missing-browser-feature patches, the bundler settings, and now the fast native encryption. The copies are already drifting apart, so this code should ship once as a shared package that apps import.
architecture: docs/reference-app-rn.md
files: packages/reference-app-rn/polyfills/, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/index.js, packages/reference-app-rn/package.json, packages/reference-app-rn/src/secure-key-store.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/test/polyfills/, packages/cadre-core/src/types.ts, docs/reference-app-rn.md, ../sereus-chat/apps/mobile/src/cadre/noise-crypto.ts, ../sereus-chat/apps/mobile/src/cadre/CadreService.ts, ../sereus-chat/apps/mobile/metro.config.js, ../sereus-chat/apps/mobile/polyfills/, ../sereus-chat/apps/mobile/shims/, ../sereus-chat/design/specs/mobile/STATUS.md
tradeoffs: A published package can only fix versions of React Native, Expo and the native crypto library if every app agrees on them. Today reference-app-rn is Expo 53 / RN 0.79 and sereus-chat is bare RN 0.82, so the kit has to work with a range of versions, which costs more to maintain than letting each app own its copy.
----
# A shared React Native kit for Sereus apps

## Problem

A React Native app that runs a cadre node needs three kinds of setup before any Sereus code loads. None of it is app-specific, and today each app carries its own copy.

**Polyfills for Hermes.** Hermes is the JavaScript engine that React Native uses. It lacks several browser globals that libp2p, multiformats and yamux use, some of them while their modules load. The reference app installs about 1,500 lines of patches from `packages/reference-app-rn/polyfills/`, and they must load in a specific order from `index.js`: random values, `crypto.subtle.digest`, TextDecoder, streams, AbortSignal, DOMException, the WebRTC globals, and a boot audit that lists which globals are native, polyfilled or missing.

**Metro settings.** Metro is React Native's bundler. The app needs aliases so Node built-ins (`crypto`, `os`, `net`, `tls`, `stream`, `buffer`) resolve to replacements, and it must force the `browser`-field variants of `@libp2p/crypto` and `@libp2p/webrtc`.

**Native Noise crypto.** Noise is the encryption protocol libp2p uses between peers. Metro resolves `@chainsafe/libp2p-noise`'s browser build, which does its cryptography in pure JavaScript. sereus-chat measured the cost against Node on the same machine (`../sereus-chat/test/stack/handshake-cost.mjs`):

| Operation | Node (native) | Emulator (Hermes) | Galaxy S7 |
|---|---|---|---|
| x25519 shared secret | 2.6 ms | 29 ms | 58 ms |
| chacha20-poly1305, 512 bytes | 0.05 ms | 2.7 ms | 7.8 ms |
| sha256, 512 bytes | 0.03 ms | 5.3 ms | 15 ms |

At these rates, bringing up a strand keeps the JavaScript thread busy long enough that libp2p's connection monitor misses its own pings and closes connections (gotchoices/sereus#13). cadre-core 1.3 added `CadreNodeConfig.network.noiseCrypto` (`packages/cadre-core/src/types.ts`) so an app can supply a faster implementation, but no implementation ships. `docs/reference-app-rn.md` still says the native crypto is "not wired yet".

## Evidence the copies drift

- **sereus-chat** (`../sereus-chat/apps/mobile/`) copied `polyfills/` and `shims/`, and every copied file now differs from the reference app. Its `hermes.js` still points at an `AbortSignal.any` leak ticket that this repo has since resolved differently.
  - Its `metro.config.js` handles the Node built-ins differently from the reference app.
  - It adds its own `@babel/runtime` fix, which forces the CommonJS helpers so `_interopRequireDefault` is a function when imports resolve through the ESM `exports` field.
- **sereus-health** (`../sereus-health/apps/mobile/polyfills/`) has another copy. Its completed ticket `6-full-polyfill-alignment-with-sereus-reference-app` asked for exactly this package.
- **The copying is by design.** `packages/reference-app-rn/polyfills/registry.js` says it is a deliberate copy of the NativeScript app's registry. The optimystic `db-p2p` readme tells app authors to copy the reference app's polyfills.

## Working native crypto implementation (sereus-chat)

`../sereus-chat/apps/mobile/src/cadre/noise-crypto.ts` (sereus-chat commits `72d05be`, `b84ee82`) is a working implementation on devices. It does no cryptography itself.

- **What it ports.** It takes the Node `ICryptoInterface` inside `@chainsafe/libp2p-noise` and runs it on `react-native-quick-crypto`, which implements Node's crypto API in C++ over JSI (React Native's direct native-call interface). quick-crypto 1.x also requires `react-native-nitro-modules`.
- **The mode switch.** `buildNoiseCrypto(mode)` takes one of three modes:
  - `off`: returns `undefined`, which keeps the stock pure-JS behaviour so the timeout problem can still be reproduced.
  - `symmetric` (the default): replaces sha256 and chacha20-poly1305, the per-frame costs.
  - `full`: also replaces the x25519 key operations.

  Every mode spreads `noisePureJsCrypto` first, so anything not overridden (for example HKDF, the key-derivation function) runs slowly instead of failing.
- **Details that must be preserved:**
  - The PKCS8 and X25519 DER prefixes are copied from noise's Node implementation. If they are wrong, key handling fails without a clear error.
  - Buffers come from `@craftzdog/react-native-buffer`, the Buffer that quick-crypto is typed against, and not from the global Buffer.
  - Wrapping uses zero-copy views.
  - Results from `generateKeyPairSync` and `diffieHellman` are checked at runtime.
- **How it is wired in.** `CadreService.ts` passes `buildNoiseCrypto(mode)` as `network.noiseCrypto`. A mode change rebuilds the node, because cadre-core reads the value only when it constructs the node.
- **Test run.** A device joined a Node host over the local relay with native crypto on: five of seven attempts attached (`STATUS.md`, "Pass 3 results"). The two failures were `StrandAwaitingFirstSyncError`, which that file attributes to a separate, still-unexplained intermittent problem.

sereus-chat's `STATUS.md` ("Offer our RN native-crypto module upstream") proposes putting this adapter in `@optimystic/db-p2p/rn`, next to `noisePureJsCrypto`, with `react-native-quick-crypto` as an optional peer dependency.

## Expected shape

This is a starting point for the plan stage, not a settled design.

One package in this monorepo, for example `@serfab/cadre-rn`, that a React Native app depends on instead of copying files:

- **`@serfab/cadre-rn/polyfills`**: a module the app imports first, for its side effects. It installs every polyfill in the required order and runs the development-mode boot audit. The app's `index.js` shrinks to that one import followed by its router entry.
- **A Metro helper**, e.g. `withCadreMetro(config, options)`. It adds the Node built-in aliases, the `browser`-field redirect for libp2p, and the `@babel/runtime` fix that sereus-chat found. Options cover what differs between apps: linking to sibling repos from local source versus installing from npm, and extra `watchFolders`.
- **The native Noise crypto adapter**: `buildNoiseCrypto(mode)` and `NoiseCryptoMode`, ported from sereus-chat with its reasoning comments kept. It lives behind its own subpath so that an app without quick-crypto installed never loads it.
- **Optionally**, `SecureStoreKeyStore` and the phone-node construction helper from `reference-app-rn/src/`, if the plan finds them independent of any app.

`reference-app-rn` becomes the first consumer and turns native crypto on, which settles the "not wired yet" note in `docs/reference-app-rn.md`. The existing polyfill tests (`test/polyfills/*.spec.ts`, including the Metro resolution check) move to the package.

## Requirements and constraints

- **The app must still list the native modules.** React Native autolinking only links native modules that the app lists as its own dependencies, not ones pulled in by a package. So `react-native-get-random-values`, `react-native-webrtc`, `react-native-quick-crypto`, `react-native-nitro-modules`, `rn-leveldb` and `expo-secure-store` are peer dependencies of the kit. `react-native-quick-crypto` and `react-native-nitro-modules` are optional peers, needed only by apps that use native crypto. Without a missing optional peer, the kit must still bundle and run on pure-JS crypto.
- **The polyfill module must work when it is the first import.** The kit can guarantee the order inside its own polyfill module, but not where the app imports it. Import the polyfills first is the one rule every app has to follow, and the docs must say so.
- **Expo is optional.** sereus-chat is bare React Native, and the reference app uses Expo. Anything Expo-only (`expo-secure-store`) stays behind its own subpath.
- **Where the crypto adapter belongs is still open.** The choice is between this kit and `@optimystic/db-p2p/rn`, as sereus-chat proposes. Optimystic is a read-only sibling here (see `tickets/rules/sibling-repos.md`), so putting it there means asking optimystic to take it. The plan should settle this. It is reasonable to ship the adapter here now and move it if optimystic adopts it.
- **The mode switch stays.** Apps need `off` to reproduce connection-monitor timeouts without reinstalling.
- **Docs:** `docs/reference-app-rn.md` changes from "copy these files" to "depend on the kit". sereus-chat and sereus-health should be told the package exists, but changing their code is up to those projects.

## Gardener notes for the plan stage (2026-09-27)

The maintainer wants this in the next sereus release.
- **Read-only siblings:** `../sereus-chat` and `../sereus-health` are read-only too, the same as `../optimystic` (`tickets/rules/sibling-repos.md`). Read and port from them; never write, build or install there.
- **Adapter placement, decided for now:** ship the Noise crypto adapter in this kit. Offering it to optimystic is a later, separate step.
- **Publishing:** the new package must be publishable and part of the release chain:
  - `publishConfig`, `files`, and `exports` for each subpath;
  - covered by `yarn smoke:published` (today 5 publishable workspaces) and by `yarn check:dep-ranges`;
  - included in the release scripts' package list.

  Match how `@serfab/cadre-core` is set up.
- **What headless checks can prove:** that the package builds and packs, that the Metro resolution test passes, that the polyfill specs pass from the package, and that the reference app bundles with Metro (`expo export` or an equivalent bundle-only command, if one runs here) with native crypto on and with the optional peers missing.
- **Device runs are human tasks:** a native build and a device run of the reference app with `full` and `symmetric` modes can't be done by an agent here. File them as one blocked device-run ticket, like `blocked/rn-host-node-request-device-run`, not as a gate on completing this ticket.
- **Split** into ordered implement tickets small enough for one runner pass each, for example: package skeleton and publishing; polyfills and tests move; Metro helper; crypto adapter; reference app switches over and turns native crypto on; docs.

## Context from sereus-rn (the ticket's author), 2026-09-27

**Sources** (read-only, under `../sereus-chat/apps/mobile/`):
- `src/cadre/noise-crypto.ts`: the adapter, about 200 lines (sereus-chat commits `72d05be` and `b84ee82`).
- `src/cadre/CadreService.ts`: the wiring near line 416. `setNoiseCryptoMode` (about lines 519–550) rebuilds the node when the mode changes.
- `package.json`: `react-native-quick-crypto` ^1.1.7 and `react-native-nitro-modules` ^0.37.1. `@craftzdog/react-native-buffer` is imported but arrives only through quick-crypto, so the kit should declare it explicitly.
- Measurements: `../sereus-chat/design/specs/mobile/STATUS.md` (upstreaming proposal around lines 364–376; device figures around 395 and 1100–1270) and `../sereus-chat/test/stack/handshake-cost.mjs`.

**Differences the plan must reconcile:**
- **Metro.** sereus-chat does not force the libp2p `browser`-field variants. It sets `unstable_conditionsByPlatform` (react-native, import, require, default) with `unstable_enablePackageExports`, and adds a `@babel/runtime` redirect to its CommonJS helpers; without that redirect `_interopRequireDefault is not a function`. Find out whether reference-app-rn needs that redirect or avoids the problem another way.
- **`crypto` shim.** sereus-chat's exports a `sign()` that throws a clear error, because cadre-core's `push-notifier-fcm` imports `node:crypto`'s `sign` when installed from npm. Compare it with reference-app-rn's `polyfills/node-crypto.js`.
- **Other stubs.** sereus-chat stubs `http2` when installed from npm (for `push-notifier-apns`), and stubs `path` and `fs` when linked to local source. These may be obsolete now that push lives in its own package. Check before carrying them over.
- **Versions.** sereus-chat is bare RN 0.82 without Expo; reference-app-rn is Expo ~53 with RN 0.79.6. quick-crypto 1.x runs on nitro modules and **requires the new architecture**. Check that reference-app-rn has it enabled (`app.json` / `newArchEnabled`). If it doesn't, turning it on is its own implement step, with its own device-run task.

**Ruled out:**
- Writing any cryptography. The adapter only ports `@chainsafe/libp2p-noise`'s own Node `ICryptoInterface` onto quick-crypto.
- Changing the DER prefixes (keep them byte-for-byte), or dropping the spread of `noisePureJsCrypto` first, which makes gaps fall back to the slow path rather than fail.
- Dropping the `off` / `symmetric` / `full` switch. `symmetric` stays the default because `full` has had less device time.
- Hard dependencies on native modules.

**Suggested test (headless):** run the adapter under Node with `react-native-quick-crypto` aliased to `node:crypto`, which implements the same API. Check that handshake and encrypt/decrypt results match `noisePureJsCrypto`. That covers the DER prefixes and output shapes without a device, and mocks nothing this repo owns.

**Suggested split** (alongside the gardener's above): (1) skeleton, polyfills module and Metro helper; (2) crypto adapter, with reference-app-rn switched over and `noiseCrypto` turned on; (3) docs. The gardener's finer split is fine too, as long as each step fits one runner pass.
