description: Review the new publishable React Native kit package for Sereus apps, and its first piece: the adapter that lets a phone app run connection encryption in fast native code instead of slow JavaScript.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/ (new: package.json, tsconfig*.json, vitest.config.ts, README.md, src/noise-crypto.ts, test/noise-crypto.spec.ts, test/global-setup.ts, test/build-targets.spec.ts), package.json, yarn.lock, knip.ts, scripts/lib/published-smoke-support.mjs, scripts/smoke-published-install.mjs, scripts/smoke-published-install.test.mjs, scripts/publish-package.mjs, scripts/release-guard.mjs, docs/releasing.md, docs/architecture.md, docs/reference-app-rn.md, docs/testing.md, AGENTS.md, README.md
----
# Review: `@serfab/cadre-rn` package and native Noise crypto adapter

First of four chained tickets (`rn-kit-polyfills`, `rn-kit-metro-helper`, `reference-app-rn-native-noise-crypto` follow). This one creates the package, wires it into the release chain, and ports the Noise crypto adapter from sereus-chat. The package plan (subpath-only exports, all peers optional, `rn-leveldb` / `expo-secure-store` not peers) was settled in the plan stage and is recorded in the kit's README and `docs/architecture.md`.

## What landed

**Package** `packages/cadre-rn`, `@serfab/cadre-rn@1.5.0`, `"type": "module"`. Exports only `./noise-crypto` (types + import) and `./package.json`; no `"."` entry, so an app importing a later subpath never evaluates the adapter. `files`: `src`, `dist`, `!dist/test`, `!**/*.tsbuildinfo`, `README.md` (pack dry-run ships exactly README, the three `dist/noise-crypto.*` files, `package.json`, `src/noise-crypto.ts`).

- `dependencies`: `@optimystic/db-p2p ^1.6.0` (same range as cadre-core).
- `peerDependencies`, both optional: `react-native-quick-crypto ^1.1.7`, `@craftzdog/react-native-buffer ^6.1.2`.
- `devDependencies`: `react-native-quick-crypto` and `@craftzdog/react-native-buffer` (types for build/typecheck), `uint8arraylist ^2.4.8` (same major as `@chainsafe/libp2p-noise`), `@types/node`, `rimraf`, `typescript`, `vitest`. **Deviation from the ticket:** the ticket listed only quick-crypto as a types-only dev dependency; the buffer package is added too because `src` imports it directly and relying on quick-crypto's hoisted copy would be a phantom resolution. `react-native-nitro-modules` is *not* added: a probe confirmed quick-crypto's public declarations (`Cipheriv`, `Buffer`, `diffieHellman`, `createPublicKey`) resolve to real types without it.

**Adapter** `src/noise-crypto.ts`: ported from `../sereus-chat/apps/mobile/src/cadre/noise-crypto.ts` with its comments, reindented to tabs. DER prefixes, spread order (`noisePureJsCrypto` first), `DEFAULT_NOISE_CRYPTO_MODE = 'symmetric'`, the `@craftzdog` Buffer, zero-copy `asBuffer`, and both runtime checks are unchanged. Two comment edits: the `NoiseCryptoMode` doc now points at `CadreNodeConfig.network.noiseCrypto` (and notes a mode change means rebuilding the node) instead of sereus-chat's `CadreService.setNoiseCryptoMode`; the measurement-table citation now names sereus-chat's `test/stack/handshake-cost.mjs` and `design/specs/mobile/STATUS.md`.

**Release chain**: `pub:cadre-rn` added and appended last to `pub`. `publishableWorkspaces()` picked it up automatically (smoke reported six workspaces). Hand-written "five" counts updated to six in `docs/releasing.md` (list, order, and the `--tag` paragraph), `scripts/publish-package.mjs` (three comments) and `scripts/release-guard.mjs` (one comment). `docs/releasing.md` line 40's "five separate commands" is about `yarn release`'s steps, not packages, and was left alone.

**Export-target check** in `yarn smoke:published`: `missingExportTargets(projectDir, workspaces)` in `scripts/lib/published-smoke-support.mjs` reads each *installed* publishable package's manifest, flattens `exports` (strings, fallback arrays, nested subpath/condition objects; `null` exclusions skipped) and returns every target missing on disk, labelled with its key path (e.g. `./nested → react-native → import`). `smoke-published-install.mjs` calls it right after `reportProvenance` and fails the run on any miss. Subpath-pattern targets (`*`) are skipped with a `NOTE:` tripwire; no workspace uses one.

**Docs**: kit README (subpath table with only the entry that exists, modes, the three native modules an app must list, new-architecture requirement, `network.noiseCrypto` read-at-build). Added the package to `AGENTS.md` orientation, the root `README.md` package table, `docs/testing.md`'s two per-package typecheck lists, `knip.ts` (explicit `{}` entry; comment's "nine" → "ten"), and a paragraph in `docs/architecture.md` under "React Native Polyfills". The reference-app table there lists apps (App / Platform / Storage / Coverage), so the kit went in as a paragraph rather than a row. `docs/reference-app-rn.md`'s "Native crypto for Noise (not wired yet)" paragraph now points at `buildNoiseCrypto`. `packages/README.md` lists no packages, so it is unchanged.

## Tests added

- `packages/cadre-rn/test/noise-crypto.spec.ts` (16 cases). Runs the adapter under Node with Vitest `resolve.alias` mapping `react-native-quick-crypto` → `node:crypto` and `@craftzdog/react-native-buffer` → `node:buffer`, checked against `noisePureJsCrypto`:
  - `off` → `undefined`; `symmetric` keeps the three x25519 functions `===` pure-JS; `full` replaces them.
  - For `symmetric` and `full`: SHA-256 of a `Uint8Array` and of a 3-chunk `Uint8ArrayList` equals pure JS; encrypt equals pure JS byte-for-byte; decrypt opens pure-JS ciphertext; a flipped tag byte makes decrypt throw.
  - For `full`: key pair from seed equals pure JS; shared key equals pure JS for the same key pairs; a native `generateX25519KeyPair()` key pair and a pure-JS peer agree on Diffie-Hellman in both directions.
  - Mutation-checked by hand: moving the auth tag before the ciphertext failed both encrypt cases; changing one byte of `PKCS8_PREFIX` failed all three x25519 cases. Source restored afterwards.
- `packages/cadre-rn/test/build-targets.spec.ts` (3 cases, the shared `describeBuildTargets` pattern) plus `test/global-setup.ts` guarding `@optimystic/db-p2p`, required by `check:stale-build-guard-wiring`.
- `scripts/smoke-published-install.test.mjs`: one case, a fixture manifest with present targets and one missing target under a nested `react-native` condition; asserts only the missing one is reported, with its key path.

## Validation run

All passed: `yarn install`; `yarn lint`; `yarn workspace @serfab/cadre-rn build` / `typecheck` / `test` (19 tests); `yarn check:dep-ranges`; `yarn check:vitest-typecheck-coverage`; `yarn check:test-file-typecheck-coverage`; `yarn check:stale-build-guard-wiring`; `yarn test:published-smoke-support` (24); `test:release-guard`, `test:release-support`, `test:release-preflight`, `test:publish-package`, `test:published-check-support`, `test:stale-build-guard-wiring`; `npx knip` (exit 0, nothing reported for cadre-rn); `yarn smoke:published --skip-build` (six tarballs packed, npm installed 334 packages with no React Native pulled in, "every `exports` target of the installed packages is present", scenario 5/5).

Not run: root `yarn typecheck` / `yarn test` across every workspace (only the new package and the gate scripts were exercised), and `yarn check:published` (it builds a scratch worktree, outside this ticket's needs).

## Known gaps / things for the reviewer to weigh

- **No on-device run.** The spec proves the DER framing and output shapes against Node's crypto, which quick-crypto mirrors; it cannot prove quick-crypto's JSI implementation matches Node on Hermes. That is covered only when `reference-app-rn-native-noise-crypto` wires it into the app. sereus-chat has run this code on devices.
- **Duplicate quick-crypto copies in the monorepo** (expected, from the plan): the root-hoisted dev copy would win over the app's copy under Metro. Harmless until the adapter is wired into the reference app; `rn-kit-metro-helper` fixes it.
- **Export-target check sees only exports.** It does not cover `main`/`types`/`bin` fields; all current publishable packages' `main`/`types` point into `dist`, which the scenario exercises for cadre-core only.
