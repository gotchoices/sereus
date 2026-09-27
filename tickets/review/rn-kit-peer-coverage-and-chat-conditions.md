description: The React Native kit now lists two native helper modules that its fast-encryption library uses, so the bundler keeps exactly one copy of each, and a new test runs Metro's real resolver with sereus-chat's settings to show the kit's bundler fixes still apply there.
architecture: packages/cadre-rn/README.md
files:
  - packages/cadre-rn/package.json (two optional peers; metro-resolver dev dependency)
  - yarn.lock (kit workspace entry only)
  - packages/cadre-rn/metro/index.cjs (comments only: rule 1's peer list, rule 3's "why by hand")
  - packages/cadre-rn/test/metro/with-cadre-metro.spec.ts (sereus-chat cases, fixture change)
  - packages/cadre-rn/README.md (noise-crypto install list)
  - docs/reference-app-rn.md (rule 1 peer list, rule 3 reasoning, spec coverage line)
  - knip.ts (cadre-rn ignoreDependencies)
  - tickets/blocked/report-rn-kit-to-app-projects.md (adoption condition, resolver-settings note, ranges)
----
# Review: RN kit peer coverage and sereus-chat conditions

From sereus-rn's review of the kit (2026-09-27). Three parts, all done.

## 1. quick-crypto's native helpers are kit peers

`react-native-nitro-modules` (`>=0.31.2`) and `react-native-quick-base64` (`>=3.0.0`) are now optional peers of `@serfab/cadre-rn`. The ranges are exactly what `react-native-quick-crypto` 1.1.7 declares. A caret on nitro would have been wrong: `^0.31.2` stops below 0.32, and the reference app runs 0.37.1. Rule 1 in `metro/index.cjs` (peers resolve from the app) reads the peer list from the manifest, so the rule needed no code change. Its comment now says why two modules the kit never imports are on the list, so nobody later removes them as unused.

- The reference app already listed both (`packages/reference-app-rn/package.json:45-46`), so autolinking was already covered. No change there.
- The lockfile was updated with `yarn install --mode=update-lockfile`. Only the kit's peer block changed.
- The kit README's noise-crypto install list now has the ranges and says all four noise-crypto modules are optional peers, and why nitro and quick-base64 are peers at all. `docs/reference-app-rn.md` rule 1 lists the two new names.
- `knip.ts`: both names were added to the kit's optional-peer ignore group. Without that, knip reported them as "Referenced optional peerDependencies", a finding that fails the `dep-check` gate.
- Not done: silencing yarn's existing `YN0002` warning (the kit doesn't provide nitro and quick-base64 to its own types-only dev copy of quick-crypto). A devDependency would silence it but would put a second nitro copy at the repo root, the situation this part exists to prevent.

## 2. `withCadreMetro` under sereus-chat's resolver settings

Two new cases in `test/metro/with-cadre-metro.spec.ts`, under `describe('withCadreMetro under sereus-chat's resolver settings, through Metro's resolver')`. The settings are `unstable_enablePackageExports: true`, `unstable_conditionNames: ['import','require','default']`, and `unstable_conditionsByPlatform` with `['react-native','import','require','default']` for ios and android, copied from `../sereus-chat/apps/mobile/metro.config.js`.

The existing cases use a fake upstream resolver that ignores conditions, so a case built on it could not show anything about sereus-chat's condition list. The new cases run **Metro's own resolver** (`metro-resolver`, now a dev dependency pinned to `0.82.5`, the version the reference app's Metro runs; the lockfile entry already existed). They build the resolution context by hand from the fields Metro's `ModuleResolution` passes, with `redirectModulePath` coming from Metro's own `createDefaultContext`.

| Test | Verifies |
|---|---|
| `still resolves an @babel/runtime helper to its CommonJS file` | Rule 2 under `import`-first conditions. First asserts that without the kit Metro picks `helpers/esm/interopRequireDefault.js` (the startup crash), then that with the kit it picks `helpers/interopRequireDefault.js`. |
| `still swaps an @libp2p/crypto file reached through exports for its browser variant` | Rule 3 under the same settings. Without the kit, `@libp2p/crypto/hmac` resolves to the Node `hmac/index.js`; with the kit, to `hmac/index.browser.js`. |

A Metro warning fails the resolution (the context's `unstable_logWarning` throws), so a fixture change that made Metro fall back quietly would fail the test instead of passing unnoticed.

**Mutation check done:** with rule 2's guard forced off and `BROWSER_REWRITTEN_PACKAGES` emptied, both new cases failed on the with-kit assertion, and each received exactly the file its rule replaces. The helper was then restored.

**Fixture change to an existing case:** the fixture's `@libp2p/crypto` now mirrors the real 5.1.13 manifest's shape (`exports` with an `import` condition only; `hmac/index.js` mapped to `hmac/index.browser.js`). The existing "ignoring false targets" case therefore moved its `false` entry from `hmac` to `ciphers/aes-gcm.js`. It still tests the same behaviour.

**What the check found, and the comments corrected to match it:** before writing the spec I ran a probe with the same hand-built context over the *real* installed `@libp2p/crypto` and `@babel/runtime` (under `packages/reference-app-rn/node_modules`). It showed that Metro 0.82.5 **does** apply the `browser` map to relative imports inside a package (`./ed25519/index.js` came back as `index.browser.js` without the kit). What it skips is a file reached through `exports`. The old comment in `metro/index.cjs` and `docs/reference-app-rn.md:542` said the opposite ("does not reliably apply the browser rewrite to their internal relative imports"). Both now state what was measured, and name the version. `packages/reference-app-rn/README.md:380` makes the same claim in vaguer terms ("not reliably applied"); it isn't wrong, so it was left alone.

## 3. Adoption condition in the blocked report

`tickets/blocked/report-rn-kit-to-app-projects.md` now tells sereus-chat to upgrade `@serfab/cadre-core` together with the kit, to the kit's own version or later. The reason: their `sign()` stub exists because in 0.8.x the FCM notifier was in cadre-core's root import graph; push moved behind `./push-node` in 0.9.0 (released 2026-07-27, confirmed from git history); and the kit drops the stub. All six Sereus packages ship at one version (1.5.0 today), so the paired cadre-core is the kit's first published version. That number is not known until release, so the text uses the report's existing placeholder, "the next release after 1.5.0". The "Before sending" note now says that placeholder appears twice and both must be replaced.

Two additions beyond the ticket's wording, which the reviewer may trim:
- A short paragraph telling sereus-chat to keep its own resolver settings (package exports, condition lists, `.qsql` extensions, transformer), drop the `@babel/runtime` branch of its `resolveRequest`, and that the kit's tests cover its condition lists.
- Ranges added to the report's native-modules line.

## Validation run

- `yarn workspace @serfab/cadre-rn test`: 5 files, 44 tests pass (both projects; the stale-build guard passed).
- `yarn workspace @serfab/cadre-rn typecheck`, `yarn eslint packages/cadre-rn knip.ts`, `yarn check:dep-ranges`, `yarn check:test-file-typecheck-coverage`, `yarn check:vitest-typecheck-coverage`: clean.
- `yarn knip --workspace packages/cadre-rn`: only the existing warn-level `runPolyfillAudit` unused export.
- `packages/reference-app-rn`: `vitest run --project polyfills --project metro-babel` passes (8 tests). These load the app's `metro.config.js`, and therefore `withCadreMetro` and the new peer list.
- A full `yarn install` was run (link step) to make `metro-resolver` resolvable from the kit. It added only that package at the root; the sibling `../optimystic` and `../quereus` `dist` folders were checked before and after.

## Known gaps

- Rule 3's `@libp2p/webrtc` half is not exercised under sereus-chat's settings. It is the same code with a different name in `BROWSER_REWRITTEN_PACKAGES`, and a second fixture would only test that constant.
- The spec's Metro context is hand-built. It follows Metro 0.82.5's `ModuleResolution` (closest-package lookup stopping at `node_modules`, `assetExts` as a `Set` although the published `.d.ts` says array), and the probe over real packages gave the same answers. But if real Metro builds the context differently in some detail, the spec measures the hand-built version.
- Nothing ties the `metro-resolver` pin to the reference app's Metro version. This is recorded as a `NOTE:` in the spec header.
- No Metro bundle was run for this ticket. The single-copy claim for nitro and quick-base64 rests on rule 1, which the existing `resolves a kit peer from the app` case covers generically.
