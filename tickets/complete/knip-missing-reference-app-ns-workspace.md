---
description: The command that checks for unused and missing package dependencies had been failing ever since the NativeScript reference app was added; it now passes, and two packages that app secretly relied on are properly declared.
prereq:
files: knip.ts, package.json, packages/reference-app-ns/package.json, packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/src/shims/noise-crypto.js, packages/cadre-core/package.json, packages/integration-tests/package.json, docs/STATUS.md, yarn.lock
difficulty: medium
---

# Complete: `yarn dep-check` restored to a green, trustworthy gate

## What shipped

**`knip.ts`** — new `packages/reference-app-ns` workspace block declaring the entry points knip
cannot infer. NativeScript resolves page modules by *string*, not by import (`app/app-root.xml` sets
`defaultPage="chat/chat-page"`; `app/chat/chat-page.ts:32` reaches Settings via
`Frame.topmost()?.navigate('settings/settings-page')`), so knip's single auto-detected entry
(`app/app.ts`, from the package `main`) reached only the polyfill barrel and 13 real dependencies
plus most of `src/` looked dead. Entries: `app/**/*-page.ts`, `nativescript.config.ts`,
`src/polyfills/node-*.ts`, `src/shims/*.js`, `src/solo-smoke.ts`. Same block adds
`ignoreBinaries: ['ns']` and `ignoreDependencies` for `@nativescript/android`, `esbuild-loader`,
`util`, `buffer`. Five stale `ignoreDependencies` entries removed across `cadre-host`,
`reference-app-web` and `reference-app-rn` (knip was emitting a "Remove from ignoreDependencies"
hint for each).

**Phantom deps declared** — `packages/reference-app-ns/src/shims/noise-crypto.js` imports
`@noble/ciphers/chacha.js` and `@noble/curves/ed25519.js` but the package declared neither; it only
built because `@chainsafe/libp2p-noise@17` happens to install both, and that package sets
`installConfig.hoistingLimits: "workspaces"` so it deliberately does not lean on root hoisting. Both
are now direct `dependencies` at `^2.0.1` — the range that dedupes onto the existing lock entries
(the ticket's originally-specified `^2.1.1` would have added a second `@noble/ciphers` resolution).

**Unused deps removed** — root `svelte-eslint-parser`, `cadre-core` `@libp2p/peer-id-factory`,
`integration-tests` `@noble/hashes`. `yarn.lock` regenerated with no version or resolution changes.

**`docs/STATUS.md`** — "Dependency-check coverage" rewritten to the green post-fix state.

## Review findings

### Verified claims (all confirmed)

- **Entry globs cover every string-referenced page.** Grepped `app/**/*.xml` for `defaultPage=` and
  the `app/`+`src/` trees for `navigate`/`moduleName`. Exactly two string references exist —
  `chat/chat-page` and `settings/settings-page` — and both files are named `*-page.ts`, so
  `app/**/*-page.ts` covers them. `app/app.ts`'s `Application.run({ moduleName: 'app-root' })` names
  an XML file, not a TS module.
- **The `ignoreDependencies` are honest, not convenient.** `esbuild-loader` is named by string at
  `packages/reference-app-ns/webpack.config.js` in the `.use('esbuild-loader').loader('esbuild-loader')`
  webpack-chain call — knip cannot read it. `util` is not merely plausible: the emitted
  `platforms/android/app/src/main/assets/app/vendor.js` contains four `node_modules/util/util.js`
  module records, so a transitive dep really does resolve it (`externalsPresets.node:false`).
  `buffer` is imported bare at `src/polyfills/buffer-global.ts:9`. `@nativescript/android` is
  consumed by `ns prepare android`.
- **The `@noble/*` versions actually work at runtime** — this was the ticket's largest flagged gap
  (compiled but never executed). Executed the exact API surface `noise-crypto.js` uses against the
  installed `@noble/ciphers@2.1.1` / `@noble/curves@2.0.1` / `@noble/hashes`:
  `chacha20poly1305(k, nonce, ad)` encrypt→decrypt round-trips; `x25519.utils.randomSecretKey()`
  exists and a two-party `getSharedSecret` agrees; `extract`/`expand` yield the expected 96 bytes.
  The gap is closed for the shim's own call sites; full-stack Noise handshake on device still needs
  the deferred `test:bundle:native` / `test:e2e` runs (see *Not run* below).
- **Lock dedup is real.** `yarn.lock` holds exactly one `@noble/ciphers@npm:^2.0.1` (→ 2.1.1) and one
  `@noble/curves@npm:^2.0.1` (→ 2.0.1) entry. The deviation from the ticket's stated `^2.1.1` was
  correct.
- **The removed deps are genuinely unused.** `@libp2p/peer-id-factory` is imported only by
  `packages/strand-proto/test/**`, which declares it itself. `@noble/hashes` has no importer in
  `integration-tests`. `svelte-eslint-parser` is not referenced from `eslint.config.mjs` and arrives
  transitively via `eslint-plugin-svelte`; `yarn lint` passes without it.
- **`@nativescript-community/sqlite` is correctly left un-ignored** — knip resolves it as satisfying
  `@optimystic/db-p2p-storage-ns`'s peer requirement and does not flag it.
- **No `reference-app-ns` file appears in knip's "Unused files"**, confirming the entries genuinely
  reach the `src/` graph rather than the package being excluded.

### Fixed in this pass (minor)

- `knip.ts` described the Settings navigation as `Frame.navigate({ moduleName })`. That object form
  is what `app/app.ts` uses for the *root frame*; the actual Settings hop is a bare string argument.
  A reader grepping for `moduleName` in `chat-page.ts` would find nothing. Comment corrected to the
  real call, and the `defaultPage` attribute named explicitly.

### Filed as new tickets (major)

None. Nothing found in this diff warranted a follow-up ticket: the gate is green with zero
configuration hints, every ignore is backed by a verified call site, and the one dependency-hygiene
gap found (below) is conditional rather than presently broken.

### Tripwires recorded

- **`webpack` is required but not declared by `reference-app-ns`.** Both
  `packages/reference-app-ns/webpack.config.js:4` and `scripts/bundle-check.js` do
  `require('webpack')`, yet the package declares neither `webpack` nor `webpack-cli`. It resolves
  only because `@nativescript/webpack` lists `webpack` under `dependencies` (not peers), which pins
  it into the workspace's own `node_modules` — so it works today and is not a latent break. Notably
  `yarn dep-check` structurally *cannot* catch this class: knip's webpack plugin declares `webpack`
  as its own enabler, so it is exempt from the unlisted rule. Confirmed empirically — a probe
  `require('semver')` added to the same file was reported as unlisted, while `webpack` never is.
  Declaring it was deliberately **not** done: yarn keys lock entries by range string, so any range
  other than `@nativescript/webpack`'s exact `"^5.30.0 <= 5.50.0 || ^5.51.2"` would resolve
  independently and risk a second webpack copy — the same trap the `@noble/ciphers` deviation
  avoided. Parked as a `NOTE:` comment at the require site in `webpack.config.js` with the condition
  that would make it real and the range guidance for whoever acts on it.
- The `app/**/*-page.ts` glob under-analyses if a page is ever named outside the `*-page.ts`
  convention. Already parked by the implementer as a `NOTE:` on the `entry` array in `knip.ts`;
  verified present and accurate.

### Checked, nothing found

- **Source hygiene** — the diff is config and `package.json` edits only; no new functions, files, or
  control flow. `knip.ts` is 156 lines, one flat config object, every non-obvious ignore carries a
  one-to-three-line rationale. Nothing to decompose.
- **Documentation** — read `docs/STATUS.md`'s rewritten section against the actual green run: the
  checkbox flip, both `@noble/*` additions, all three removals, the `reference-app-ns` ignores, and
  the "only `warn`-class output remains" bullet all match observed output.
  `docs/reference-app-ns.md` already documents the noise shim and its noble backend
  (§ "Why the browser rewrite matters" and the polyfill tables) and needed no change — the diff
  altered which `package.json` declares those imports, not the runtime behaviour it describes.
- **Type safety / error handling / resource cleanup** — not applicable; no runtime code changed.

### Not run (unchanged from the implement handoff, and why)

- `test:bundle:native` (`ns prepare android`) and `test:e2e` need an Android toolchain or a device —
  not available here. The runtime verification above covers the shim's noble call sites directly,
  which was the specific risk those runs were flagged for; a full on-device Noise handshake remains
  unproven.
- `integration-tests`' vitest suite spins up real networking; its build and typecheck pass, which is
  the floor rather than a guarantee. Matches the ticket's stated scope.

### Pre-existing, untouched

- `reference-app-ns` exports now surface in knip's `warn`-class dead-code list (`applySeed`,
  `decodeSeed`, `getConnectionPaths`, `addStrand`, `getChatSAppConfig`, `joinChatStrand`) — newly
  *visible*, not newly dead, and mirroring the identical set already reported for `reference-app-rn`.
- One `Duplicate exports` warning on `noise-crypto.js` — intentional; the shim binds all four
  upstream export names to the same pure-JS object.
- `yarn install` peer-dependency warnings (`@nano-sql/core` / `typeorm` for
  `@nativescript-community/sqlite`, `webpack` for `esbuild-loader`, `@react-native/gradle-plugin`).
  `dep-check` does not gate on them.

## Validation

All commands run from a clean tree at review time, after the two edits above.

| command | result |
| --- | --- |
| `yarn dep-check` | **exit 0**, zero configuration hints, zero dependency-class findings |
| `yarn lint` | exit 0 |
| `yarn workspace @serfab/cadre-core build` | exit 0 |
| `yarn workspace @serfab/cadre-core test` | exit 0 — 54 files, 732 passed, 1 skipped |
| `yarn workspace @serfab/integration-tests build` | exit 0 |
| `yarn workspace @serfab/integration-tests typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns typecheck` | exit 0 |
| `yarn workspace @serfab/reference-app-ns test:bundle` | exit 0 — 0 errors, 0 warnings |
| noble API execution probe (`chacha20poly1305`, `x25519`, `hkdf`) | pass |

No pre-existing test failures surfaced; `tickets/.pre-existing-error.md` not written.
