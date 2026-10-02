description: A new publishable React Native kit package for Sereus apps, whose first piece lets a phone app run connection encryption in fast native code instead of slow JavaScript.
architecture: docs/reference-app-rn.md
files: packages/cadre-rn/ (package.json, tsconfig*.json, vitest.config.ts, README.md, src/noise-crypto.ts, test/noise-crypto.spec.ts, test/global-setup.ts, test/build-targets.spec.ts), package.json, yarn.lock, knip.ts, scripts/lib/published-smoke-support.mjs, scripts/smoke-published-install.mjs, scripts/smoke-published-install.test.mjs, scripts/publish-package.mjs, scripts/release-guard.mjs, docs/releasing.md, docs/architecture.md, docs/reference-app-rn.md, docs/testing.md, AGENTS.md, README.md
----
# Complete: `@serfab/cadre-rn` package and native Noise crypto adapter

First of four chained tickets (`rn-kit-polyfills`, `rn-kit-metro-helper`, `reference-app-rn-native-noise-crypto` follow).

## What landed

- **Package** `packages/cadre-rn`, `@serfab/cadre-rn@1.5.0` (same version as the other publishable workspaces), ESM. Exports only `./noise-crypto` and `./package.json`; no root entry, so an app importing a later subpath never evaluates the adapter. Depends on `@optimystic/db-p2p ^1.6.0`; `react-native-quick-crypto ^1.1.7` and `@craftzdog/react-native-buffer ^6.1.2` are optional peers (and dev dependencies for types and tests).
- **Adapter** `src/noise-crypto.ts`: `buildNoiseCrypto(mode)`, `NoiseCryptoMode` (`off` / `symmetric` / `full`), `DEFAULT_NOISE_CRYPTO_MODE = 'symmetric'`, ported from sereus-chat's `apps/mobile/src/cadre/noise-crypto.ts`. Every mode spreads `noisePureJsCrypto` first and overrides only its own functions.
- **Release chain**: `pub:cadre-rn` appended last to `yarn pub`; the hand-written package counts in `docs/releasing.md`, `scripts/publish-package.mjs` and `scripts/release-guard.mjs` went from five to six.
- **Export-target check** in `yarn smoke:published`: `missingExportTargets` flattens each installed publishable package's `exports` and fails the run on any target missing from the tarball.
- **Docs**: kit README; package added to `AGENTS.md`, root `README.md`, `docs/testing.md`, `knip.ts`, `docs/architecture.md` (React Native Polyfills section) and `docs/reference-app-rn.md` (Noise crypto paragraph now names `buildNoiseCrypto`).
- **Tests**: `test/noise-crypto.spec.ts` runs the adapter under Node with the two native modules aliased to `node:crypto` / `node:buffer` and compares it byte for byte with `noisePureJsCrypto` (mode wiring, SHA-256 of a flat array and a multi-chunk list, ChaCha20-Poly1305 encrypt/decrypt/tag tamper, X25519 seed / shared key / cross-implementation agreement); `test/build-targets.spec.ts` + `test/global-setup.ts` for the stale-build guard; one `missingExportTargets` case in `scripts/smoke-published-install.test.mjs`.

## Review findings

Read the implement diff (`463d1190`) first, then the handoff; ran `yarn workspace @serfab/cadre-rn build` / `typecheck` / `test` (14 pass after the cut below), `yarn lint`, `yarn test:published-smoke-support`, `yarn check:stale-build-guard-wiring`. All pass. Not re-run: `yarn smoke:published` (network, and nothing in this pass touched packaging or the scripts) and root `yarn test` across all workspaces (nothing outside `packages/cadre-rn` changed in this pass).

**Correctness of the port** — compared against sereus-chat's source: DER prefixes, spread order, tag placement (ciphertext then tag), trailing-tag split on decrypt, zero-copy `asBuffer`, and the two runtime checks are unchanged. The spec's alias approach genuinely exercises the adapter's framing (the implementer's mutation checks on tag order and `PKCS8_PREFIX` confirm it is not vacuous). No defect found.

**Fixed inline (minor)**:
- `src/noise-crypto.ts`: the comment on the asymmetric block said "~231 ms each on an S7". sereus-chat's `STATUS.md` records ~231 ms as the CPU cost of a whole Noise handshake; the file's own table gives ~58 ms per X25519 shared secret. Reworded to the per-call figure. Also "DER encodings are requested above" → "below" (the request is in the call that follows the comment); both errors were inherited from sereus-chat.
- `test/noise-crypto.spec.ts`: the symmetric-primitive block ran under both `symmetric` and `full`, but both modes spread the same `symmetric` object, so the `full` pass re-tested identical functions (5 duplicate cases). Collapsed to one pass under `symmetric` with a comment saying why; `full` still has its own replacement and X25519 cases.
- `packages/cadre-rn/README.md`: the adapter imports `@craftzdog/react-native-buffer` directly and the README said quick-crypto installs it. True under hoisting, but under a non-hoisting layout (pnpm's default) the kit could not resolve it. Added one clause telling such apps to list it.

**Checked, nothing found**:
- Package manifest: `import`-only condition matches cadre-core's subpath exports and is resolved by Metro with package exports enabled (the reference app's `metro.config.js` already relies on `unstable_enablePackageExports`). Version matches the monorepo's shared version, so `bumpp --recursive` and the release guard cover it. `!dist/test` in `files` is inert here (build `rootDir` is `src`) but matches the sibling packages' pattern.
- tsconfig: target/lib match the other library packages; the typecheck config's `rootDir: ../..` is the same pattern the other packages use for the shared `test-harness` import.
- `missingExportTargets`: handles strings, fallback arrays, nested condition objects, `null` exclusions, missing `exports`, and uninstalled workspaces (skipped, provenance reports those). The `*` pattern skip already carries a `NOTE:` tripwire. Short-circuiting after a provenance failure is fine — that run already fails.
- Docs: every file the change touches and the ones it should (`AGENTS.md`, root `README.md`, `docs/releasing.md`, `docs/testing.md`, `docs/architecture.md`, `docs/reference-app-rn.md`, `knip.ts` comment) reflect the new package. `docs/architecture.md` names `NetworkConfig.noiseCrypto`, which is the real type in `packages/cadre-core/src/types.ts`.
- Tests kept: the mode-wiring cases pin the README's mode table (which functions each mode replaces), and the tag-tamper case pins that authentication actually happens — both are specification, not restatement. The build-targets spec is required by `check:stale-build-guard-wiring`.

**Tickets filed**: none. **Tripwires added**: none new.

**Known gaps carried forward (from implement, still true)**:
- No on-device run: Node's crypto stands in for quick-crypto's JSI implementation; Hermes behaviour is covered only when `reference-app-rn-native-noise-crypto` wires the adapter into the app.
- The root-hoisted dev copy of quick-crypto would shadow the app's copy under Metro; `rn-kit-metro-helper` is scheduled to fix that before the adapter is wired in.
- The export-target check covers `exports` only, not `main` / `types` / `bin`; every current publishable package's `main`/`types` point into `dist`, which ships.
