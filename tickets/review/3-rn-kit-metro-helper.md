description: The shared React Native kit now provides a one-call bundler setup, and the reference phone app's bundler configuration is reduced to that single call; review the helper, its three resolution rules and the measurements behind them.
prereq: rn-kit-polyfills
architecture: docs/reference-app-rn.md#metro-configuration
files: packages/cadre-rn/metro/index.cjs (new), packages/cadre-rn/shims/ (moved from packages/reference-app-rn/polyfills/), packages/cadre-rn/test/metro/with-cadre-metro.spec.ts (new), packages/cadre-rn/package.json, packages/cadre-rn/vitest.config.ts, packages/cadre-rn/README.md, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/package.json, packages/reference-app-rn/README.md, knip.ts, yarn.lock, docs/reference-app-rn.md, docs/architecture.md, docs/testing.md, docs/reference-app-ns.md
----
# `withCadreMetro`: review handoff

Third of the four kit tickets (design context: `rn-kit-package-and-native-noise-crypto`). Metro is React Native's bundler; `metro.config.js` is CommonJS loaded by Node.

## What was built

- **`packages/cadre-rn/metro/index.cjs`**, exported as `@serfab/cadre-rn/metro` (`require` / `default` conditions, no `types`). Plain CommonJS with JSDoc and `// @ts-check`; it is type-checked because the spec imports it into the kit's `tsconfig.typecheck.json` program (confirmed with `tsc --listFiles`). It imports nothing from `metro`, `expo` or `@react-native/metro-config`.
- `withCadreMetro(config, { projectRoot, linkedRoots = [] })` mutates and returns `config`:
  - `resolver.unstable_enableSymlinks = true`;
  - `watchFolders`: existing, then `linkedRoots`;
  - `resolver.nodeModulesPaths`: existing, then `<projectRoot>/node_modules`, then each linked root's `node_modules`. For the reference app this is exactly the list the old config produced (Expo's two defaults, then the five), so `test/polyfills/metro-resolution.ts` sees the same roots;
  - `resolver.extraNodeModules`: `os`/`crypto` → `shims/node-os.js`/`shims/node-crypto.js`, `net`/`tls` → `shims/empty.js`, `stream` → `readable-stream`, `buffer` → `buffer`, each under the bare and the `node:` name. **An entry the incoming config already has wins over the kit's** (the old app config did the reverse; the ticket's "keeps whatever the incoming config already set" decided it);
  - `resolver.resolveRequest`: a wrapper calling the incoming `resolveRequest` (or `context.resolveRequest` with `resolveRequest: undefined`; Expo's default config has none) with three rules. **Rule 1** resolves any import of a kit `peerDependencies` name (or subpath) with `originModulePath` = `<projectRoot>/package.json`. **Rule 2** returns `require.resolve(moduleName, { paths: [projectRoot] })` for `@babel/runtime/*`, falling through only on `MODULE_NOT_FOUND` / `ERR_PACKAGE_PATH_NOT_EXPORTED`. **Rule 3** swaps a resolved `sourceFile` inside `node_modules/@libp2p/crypto` or `node_modules/@libp2p/webrtc` for its `browser`-field target. The map is read from that file's own package directory: the package after the *last* `node_modules` segment, cached per directory, with non-string targets skipped. Rule 3 applies to the result of rule 1's resolution as well. `null` and non-`sourceFile` results, and upstream throws, pass through unchanged.
- The three shims moved by `git mv` to `packages/cadre-rn/shims/`. Only `node-crypto.js` changed: one comment path. The kit's `files` gained `shims` and `metro`, and `yarn pack --dry-run` lists all four files. The kit gained `buffer ^6.0.3` and `readable-stream ^4.7.0` dependencies (same ranges as the web and NativeScript apps).
- `packages/reference-app-rn/metro.config.js` is now the four roots plus the helper call, with the two `NOTE:` comments kept beside `linkedRoots`. The interim `isKitPeerImport` rule is gone.
- App dependencies dropped: `buffer`, `readable-stream`, `@noble/hashes` (its only importer was the moved crypto shim) and `@types/readable-stream`. Nothing else in the app imports them.
- `knip.ts`: the `shims/*.js` entry moved from the app to the kit. `buffer` is ignored on the kit, because knip does not read `require.resolve('buffer/')` as the npm package. `buffer` was removed from the app's ignore list (knip asked).
- Docs: `docs/reference-app-rn.md` § Metro Configuration rewritten around `withCadreMetro` (options, what it sets, the three rules); § Metro module aliases, § Polyfills, § Package Structure and § Key Dependencies were repointed. The kit README has the `/metro` row and a section with Expo and bare React Native examples. The app README, `docs/architecture.md`, `docs/testing.md` and `docs/reference-app-ns.md` have path and wording updates.

## Deviations and decisions worth a second look

- **Rule 1 applies to every importer, not only the kit's files.** The ticket's rule text says "when `moduleName` is one of the kit's peerDependencies", with no importer condition. The interim rule was kit-only. Effect: every `react-native`, `react-native-webrtc`, `react-native-get-random-values`, `react-native-quick-crypto` and `@craftzdog/react-native-buffer` import in the graph resolves from the app root. That includes ones from `../optimystic`, from root-hoisted packages, and from nested copies. Native code is linked only for the app's direct dependencies, so collapsing to the app's copy is what we want. One consequence: under pnpm's non-hoisting layout an app must list `@craftzdog/react-native-buffer` itself, which the kit README's noise-crypto section already tells it to do.
- **Rule 1 error text (inferred from reading Metro's code, not run):** when a peer is missing, Metro's "Unable to resolve module X from <origin>" will name the app's `package.json` as the origin, not the file that really imported it. The module name is still right. A wrapper that rethrows naming the original importer would fix this if it confuses anyone.
- **`buffer` alias was a no-op before.** `require.resolve('buffer')` returns Node's built-in name `'buffer'`, not a path (checked in Node 24). The old config therefore mapped `buffer`/`node:buffer` to the string `'buffer'`. The helper uses `require.resolve('buffer/')`, which gives the npm package's `index.js`. In this app nothing bundled imports `buffer` by that name, so there is no observable change here.
- **Spec placement:** it runs in the kit's existing unguarded Vitest project, still named `polyfills`: its `include` gained `test/metro/**` and the `node` project excludes it. That project now covers more than polyfills; a separate `metro` project is the alternative if the name bothers the reviewer.
- **No `types` condition on `./metro`.** The editor shows a "could not find a declaration file" hint on the `require('@serfab/cadre-rn/metro')` line of `metro.config.js`. It is only a hint: the config file is not in any typecheck program.

## Measurements (Android export of the reference app, 2026-09-26, after the change)

Taken with `yarn expo export --platform android --dump-sourcemap` in `packages/reference-app-rn`, reading `sources` from the `.hbc.map` and grouping by the path segment after the last `node_modules/`. The export was then deleted.

- Bundle: 4,696 modules. The app does **not** install `react-native-quick-crypto` / `@craftzdog/react-native-buffer` yet (that is `reference-app-rn-native-noise-crypto`), so this is the recorded proof that an app without the crypto peers bundles; neither appears in the source map.
- One copy each: `react-native` (425 modules; one `Libraries/Core/InitializeCore.js`), `react-native-webrtc` (35), `react-native-get-random-values` (1), `@babel/runtime` (37 modules, the app's; zero `helpers/esm/` files), `@libp2p/webrtc` (20).
- `@libp2p/crypto`: 15 installed copies are bundled: the app's, the repo root's, one nested under the app's `@libp2p/webrtc`, 10 under `../optimystic/packages/db-p2p/node_modules`, one under `db-p2p-storage-rn`, and one under `../Fret/packages/fret`. **Every** bundled key/hmac/webcrypto module is the `.browser.js` variant; no Node variant appears. The old code mapped only the app's copy. **Not measured:** whether the other 14 were already browser variants before this change (Metro's own `browser`-field handling may have covered them). Running the old config would have meant reverting the working tree.
- `@libp2p/webrtc`: `webrtc/index.react-native.js`, `private-to-public/transport.browser.js`, `private-to-public/utils/get-rtcpeerconnection.browser.js`, the same set the ticket recorded before the change. The ported comment now says that the `webrtc/index.js` browser entry never fires.
- Shims: only `shims/node-os.js` is bundled. Metro already picks the `browser` variants of multiformats' `sha2`, noise's `crypto/index` and websockets' `listener`, and nothing bundled imports `stream` or `buffer` by those names. So the `crypto`, `net`, `tls`, `stream` and `buffer` aliases are unreached in this app. The ticket kept them for other apps; the helper's comment and the doc now say this instead of claiming they are needed here.

## Tests

- **Added** `packages/cadre-rn/test/metro/with-cadre-metro.spec.ts` (kit Vitest project `polyfills`, no stale-build guard). It builds a fixture tree in a temporary directory (no links, removed recursively) and drives the returned `resolveRequest` over a fake upstream that records calls:
  - rule 3: a resolved `@libp2p/crypto` file listed in the `browser` map is swapped for its target, and a file whose target is `false` comes back unchanged;
  - rule 1: `react-native` imported from outside `projectRoot` reaches upstream with an origin inside `projectRoot`, while `@libp2p/crypto` from the same importer keeps its origin;
  - rule 2: `@babel/runtime/helpers/interopRequireDefault` resolves to the fixture's CommonJS file under `projectRoot` (not the `esm/` one), and upstream is never called.
- No other tests added. The pass-through cases (`null`, throws) and linked mode versus npm mode are checked by reading the code only.

## Validation run

- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-rn typecheck` / `test`: clean; 42 tests in 5 files, including the new spec.
- `yarn workspace @serfab/reference-app-rn typecheck` / `test`: clean; 294 tests in 20 files, including the `polyfills` project, which loads `metro.config.js` (and now the helper) through `metro-resolution.ts`.
- `yarn dep-check`: exit 0 (knip errors none, dep-ranges fine; the warn-level dead-code backlog is unchanged).
- `yarn check:test-file-typecheck-coverage`, `yarn check:vitest-typecheck-coverage`: pass.
- `yarn workspace @serfab/reference-app-rn test:bundle`: passes (4,696 modules), run after all edits, with `dist` removed by the script.

## Not done / out of scope

- No device run. A runtime check that the bundle still starts, and that key generation and WebRTC work, belongs with `blocked/rn-native-noise-crypto-device-run`.
- sereus-chat's adoption (`../sereus-chat/apps/mobile/metro.config.js`) is that project's decision. Linked mode versus npm mode (`linkedRoots` omitted) was checked by reading the code only.
