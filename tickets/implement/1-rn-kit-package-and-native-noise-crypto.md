description: Create the new publishable React Native kit package for Sereus apps, and put its first piece in it: the adapter that lets a phone app run the connection encryption in fast native code instead of slow JavaScript.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/ (new), package.json, docs/releasing.md, packages/README.md, AGENTS.md, docs/architecture.md, knip.ts, packages/cadre-core/package.json (pattern to copy), packages/cadre-core/test/global-setup.ts (pattern), packages/cadre-core/test/build-targets.spec.ts (pattern), scripts/lib/published-smoke-support.mjs, scripts/smoke-published-install.mjs, scripts/smoke-published-install.test.mjs, ../sereus-chat/apps/mobile/src/cadre/noise-crypto.ts (read-only source), ../optimystic/packages/db-p2p/src/noise-crypto.ts (read-only)
----
# The `@serfab/cadre-rn` package, and the native Noise crypto adapter

This is the first of four chained tickets that turn the copied React Native startup code into one package. The plan and the reasons behind each choice are recorded here; the later tickets (`rn-kit-polyfills`, `rn-kit-metro-helper`, `reference-app-rn-native-noise-crypto`) refer back to it.

## The package, as a whole

`packages/cadre-rn`, published as **`@serfab/cadre-rn`**. A React Native app depends on it instead of copying files. When all four tickets have landed it has these entry points:

| Subpath | What it is | Lands in |
|---|---|---|
| `@serfab/cadre-rn/noise-crypto` | `buildNoiseCrypto(mode)`, `NoiseCryptoMode`, `DEFAULT_NOISE_CRYPTO_MODE` | this ticket |
| `@serfab/cadre-rn/polyfills` | side-effect module, imported first: Hermes globals, `Intl.PluralRules`, EventTarget | `rn-kit-polyfills` |
| `@serfab/cadre-rn/polyfills/webrtc` | side-effect module: `react-native-webrtc` globals, for apps that use `@libp2p/webrtc` | `rn-kit-polyfills` |
| `@serfab/cadre-rn/boot-check` | side-effect module, after every polyfill: the development-build audit table and reload-reason logger | `rn-kit-polyfills` |
| `@serfab/cadre-rn/metro` | CommonJS `withCadreMetro(config, options)` for `metro.config.js` | `rn-kit-metro-helper` |

**Decisions already made (do not reopen):**

- **The Noise crypto adapter lives here**, not in `@optimystic/db-p2p/rn`. Offering it to optimystic is a later, separate step (the maintainer's call, 2026-09-27).
- **Peer dependencies are only the modules the kit itself imports, and all are optional** (`peerDependenciesMeta.<name>.optional: true`). Two reasons. Each peer is needed only by one subpath, so an app that skips that subpath must not be forced to install it. And npm 7+ installs non-optional peers automatically, which would pull React Native into `yarn smoke:published`'s Node-only scratch install. The README says which subpath needs which peer and which native modules the *app* must list for autolinking (React Native links only an app's own direct dependencies).
- **`rn-leveldb` and `expo-secure-store` are not peers.** The kit imports neither; the phone-node and key-store helpers in `reference-app-rn/src/` stay in the app for now (see `backlog/feat-rn-kit-secure-key-store`).
- **Versioning:** the monorepo shares one version, so the package starts at the current workspace version (`1.5.0` at the time of writing — read the root `package.json`). `scripts/release-guard.mjs` refuses a release where a publishable workspace differs.
- **Layout:** TypeScript under `src/` compiled to `dist/` (the adapter). Polyfills ship as plain JS under `polyfills/` and the Metro helper as `.cjs` under `metro/`, both uncompiled, because Metro and Node consume them as they are. `"type": "module"`.

## This ticket: skeleton, publishing, and the adapter

### Package manifest

Match `packages/cadre-core/package.json`: `type`, `description`, `license`, `author`, `repository` (with `directory: packages/cadre-rn`), `keywords`, `scripts` (`clean`, `build` via `tsconfig.build.json`, `typecheck` via `tsconfig.typecheck.json` or `tsconfig.json`, `test`, `dev:test`). `files`: `dist`, `src`, `!dist/test`, `!**/*.tsbuildinfo`, `README.md` (the later tickets add `polyfills` and `metro`). `exports`:

```json
"./noise-crypto": { "types": "./dist/noise-crypto.d.ts", "import": "./dist/noise-crypto.js" },
"./package.json": "./package.json"
```

There is no `"."` entry: every entry point is a subpath on purpose, so an app that imports only the polyfills never evaluates the crypto adapter (which loads native modules at module scope).

- `dependencies`: `@optimystic/db-p2p` with the same range `@serfab/cadre-core` declares (for `noisePureJsCrypto` and the `NoiseCryptoInterface` type). `yarn check:dep-ranges` covers it automatically.
- `peerDependencies` (all optional): `react-native-quick-crypto` `^1.1.7`, `@craftzdog/react-native-buffer` `^6.1.2` (the Buffer quick-crypto is typed against; quick-crypto installs it itself, but the adapter imports it directly, so declare it).
- `devDependencies`: `typescript`, `vitest`, `@types/node`, `uint8arraylist` (for the list-input test case), and `react-native-quick-crypto` **for its types only** (the build and typecheck need them). Add `react-native-nitro-modules` only if `tsc` needs it to resolve quick-crypto's declarations. See the duplicate-copy edge case below: this dev install is exactly why `rn-kit-metro-helper` pins peers to the app's root.

### Release chain

- Root `package.json`: add `"pub:cadre-rn": "node scripts/publish-package.mjs cadre-rn"` and append `&& yarn pub:cadre-rn` to `pub`, last in the chain (the kit depends on no `@serfab/*` package, so order is free; last keeps the existing five untouched). `publishableWorkspaces()` reads the `pub:*` scripts, so `yarn smoke:published` and `scripts/release-guard.mjs` pick it up with no further change.
- `docs/releasing.md`: "Five workspaces" → six, add it to the list and the publish order.
- **Export-target check in `yarn smoke:published`.** The kit's non-`dist` directories are listed by hand in `files`, so the likeliest publishing defect is an `exports` target that is not in the tarball. The smoke's scenario cannot catch that: it runs a Node control-DB scenario and never imports the kit. Add one pure function to `scripts/lib/published-smoke-support.mjs`: for every installed publishable workspace, walk its `exports` map (strings and nested condition objects) and return every target path missing on disk. Call it from `smoke-published-install.mjs` after install, next to `reportProvenance`, and fail the run on any miss. It applies to all six packages, not only the kit. Add one case to `scripts/smoke-published-install.test.mjs` with a fixture manifest that has one present and one missing target (nested condition included).

### The adapter: `src/noise-crypto.ts`

Port `../sereus-chat/apps/mobile/src/cadre/noise-crypto.ts` (sereus-chat commits `72d05be`, `b84ee82`) **with its reasoning comments**, reformatted to tabs (`.editorconfig`). Things that must survive the port byte-for-byte or behaviour-for-behaviour:

- The `PKCS8_PREFIX` and `X25519_PREFIX` DER bytes.
- `buildNoiseCrypto(mode)`: `off` → `undefined`; `symmetric` → `{ ...noisePureJsCrypto, ...symmetric }`; `full` → also `...asymmetric`. The `noisePureJsCrypto` spread always comes first.
- `DEFAULT_NOISE_CRYPTO_MODE = 'symmetric'` (`full` has had less device time).
- Buffers from `@craftzdog/react-native-buffer`, not the global `Buffer`; zero-copy `asBuffer` views; the runtime checks on `generateKeyPairSync` and `diffieHellman` results.
- Imports `noisePureJsCrypto` / `NoiseCryptoInterface` from `@optimystic/db-p2p` (which also resolves under the `react-native` condition: `rn.ts` re-exports `noise-crypto.js`).

The measurement table in the header comment stays; cite sereus-chat's `test/stack/handshake-cost.mjs` and `design/specs/mobile/STATUS.md` as its source.

### Test: `test/noise-crypto.spec.ts` (the one test this ticket adds besides the smoke-support case)

Runs the adapter under Node with Vitest `resolve.alias` mapping `react-native-quick-crypto` → `node:crypto` and `@craftzdog/react-native-buffer` → `node:buffer`. Both are third-party modules implementing Node's API, so nothing this repo owns is mocked. It proves the DER prefixes and the output shapes against `noisePureJsCrypto` as the reference:

- `off` returns `undefined`; `symmetric` leaves the three x25519 functions identical (`===`) to `noisePureJsCrypto`'s; `full` replaces them.
- For `symmetric` and `full`: `hashSHA256` equals pure-JS output for a `Uint8Array` and for a multi-chunk `Uint8ArrayList`; `chaCha20Poly1305Encrypt` output equals pure-JS output byte-for-byte; `chaCha20Poly1305Decrypt` opens pure-JS ciphertext; a flipped tag byte makes decrypt throw.
- For `full`: `generateX25519KeyPairFromSeed(seed)` equals pure-JS's for the same seed; `generateX25519SharedKey` equals pure-JS's for the same key pair; a key pair from `generateX25519KeyPair()` agrees with pure JS on a Diffie-Hellman in both directions.

The spec runs `@optimystic/db-p2p`'s compiled `dist`, so the package needs the stale-build guard: a `test/global-setup.ts` naming its build targets, wired as `globalSetup` in `vitest.config.ts`, and a `test/build-targets.spec.ts` (copy the `cadre-core` pattern; `yarn check:stale-build-guard-wiring` enforces the wiring). `vitest.config.ts` and every spec must be inside a `tsc` program (`yarn check:vitest-typecheck-coverage`, `yarn check:test-file-typecheck-coverage`).

### Docs

- `packages/cadre-rn/README.md`: what the package is; the subpath table above (mark the three later ones "coming" only if you must; better to list just what exists and let each ticket add its row); for `/noise-crypto`, the app must list `react-native-quick-crypto`, `react-native-nitro-modules` and `react-native-quick-base64`, needs React Native's new architecture, and passes `buildNoiseCrypto(mode)` as `CadreNodeConfig.network.noiseCrypto`, which cadre-core reads only when it builds the node (so a mode change means rebuilding the node).
- `AGENTS.md` repo orientation, `packages/README.md` if it lists packages, and the package table in `docs/architecture.md` (around the `packages/reference-app-rn` row): add `@serfab/cadre-rn`.

## Edge cases & interactions

- **An app without quick-crypto installed** must still bundle. Holds because nothing but `dist/noise-crypto.js` imports quick-crypto and there is no `"."` entry. Verified by inspection here, and by the reference-app bundle in `rn-kit-metro-helper`, which runs before the app installs quick-crypto.
- **Duplicate copies in the monorepo.** The kit's real path is `packages/cadre-rn`, outside the app. Metro looks up a bare import in the `node_modules` directories above the importing file first, so the root-hoisted dev copy of quick-crypto would win over the app's own copy. Harmless until `reference-app-rn-native-noise-crypto` wires the adapter; `rn-kit-metro-helper` fixes it for every peer. Do not "fix" it here by dropping the dev dependency: the types are needed.
- **`Uint8ArrayList` input.** Noise passes either a `Uint8Array` or a list, and `flatten` handles both. That is covered by the spec.
- **Knip.** The new workspace's entries come from `exports`; if `knip` flags the types-only dev dependency, add it to that workspace's `ignoreDependencies` with a one-line reason.
- **Smoke install.** With every peer optional, `npm install` of the tarball pulls only `@optimystic/db-p2p` (already present). Run `yarn smoke:published` if the network is available; if it is not, say so in the handoff.

## TODO

- Create `packages/cadre-rn` (package.json, tsconfig.json / tsconfig.build.json / typecheck program, vitest.config.ts, README.md) per the manifest section.
- Port `src/noise-crypto.ts` from sereus-chat with its comments; build it.
- Write `test/noise-crypto.spec.ts` with the aliases; add `test/global-setup.ts` + `test/build-targets.spec.ts`.
- Add `pub:cadre-rn` and extend `pub`; update `docs/releasing.md`.
- Add the export-target check to `published-smoke-support.mjs` + its call in `smoke-published-install.mjs` + one test case.
- Update `AGENTS.md`, `packages/README.md`, `docs/architecture.md` package table.
- `yarn install`, then run `yarn lint`, `yarn workspace @serfab/cadre-rn build`, `typecheck`, `test`, `yarn check:dep-ranges`, the three `check:*-coverage`/`wiring` gates, `yarn test:published-smoke-support`, and `yarn smoke:published` when the network allows.
