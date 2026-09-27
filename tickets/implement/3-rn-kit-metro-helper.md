description: Give the shared React Native kit a one-call bundler setup, so a Sereus phone app's bundler configuration shrinks to a single function call instead of a hand-copied page of settings.
prereq: rn-kit-polyfills
architecture: docs/reference-app-rn.md#metro-configuration
files: packages/cadre-rn/metro/ (new), packages/cadre-rn/shims/ (new), packages/cadre-rn/package.json, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/polyfills/node-crypto.js, packages/reference-app-rn/polyfills/node-os.js, packages/reference-app-rn/polyfills/empty.js, packages/reference-app-rn/package.json, packages/reference-app-rn/test/polyfills/metro-resolution.ts, knip.ts, docs/reference-app-rn.md, ../sereus-chat/apps/mobile/metro.config.js (read-only comparison)
----
# `withCadreMetro`: the Metro settings every Sereus RN app needs

Design context: `rn-kit-package-and-native-noise-crypto`. Metro is React Native's bundler; `metro.config.js` is CommonJS and loaded by Node, so the helper ships as `packages/cadre-rn/metro/index.cjs` (JSDoc-typed, no build), exported as `@serfab/cadre-rn/metro` (`"require"` / `"default"` condition). It must not import `metro`, `expo` or `@react-native/metro-config`: the app passes in the config its own toolchain produced.

## Interface

```js
const { getDefaultConfig } = require('expo/metro-config'); // or @react-native/metro-config
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), {
	projectRoot: __dirname,
	// Local checkouts whose packages are linked into this app (monorepo root, sibling repos).
	// Each is added to watchFolders and its node_modules to nodeModulesPaths. Omit when
	// everything comes from npm.
	linkedRoots: [workspaceRoot, optimysticRoot, quereusRoot, fretRoot],
});
```

It mutates and returns `config`, and keeps whatever the incoming config already set, appending to lists and chaining `resolveRequest`.

## What it sets

- `resolver.unstable_enableSymlinks = true`.
- `watchFolders`: existing, then `linkedRoots`.
- `resolver.nodeModulesPaths`: existing, then `<projectRoot>/node_modules`, then `<root>/node_modules` for each linked root, in that order. The app's `test/polyfills/metro-resolution.ts` reads this list, so the order must equal today's list.
- `resolver.extraNodeModules`, bare and `node:` forms, both: `os` → `shims/node-os.js`, `crypto` → `shims/node-crypto.js`, `net`/`tls` → `shims/empty.js`, `stream` → `readable-stream`, `buffer` → `buffer` (both resolved with the kit's own `require.resolve`, and both become kit `dependencies`). The three shim files move from `packages/reference-app-rn/polyfills/` to `packages/cadre-rn/shims/` (`git mv`); `node-crypto.js` keeps `@noble/hashes`. Add `shims` and `metro` to the kit's `files`. **Not carried over from sereus-chat:** its `sign()` stub on the crypto shim and its `http2`, `path`, `fs` stubs. They existed for cadre-core's push notifiers and file-based helpers, which now sit behind Node-only subpaths (`@serfab/cadre-core/push-node`, `/key-store-file`, …) that an RN app never imports; checked 2026-09-26, only `file-durable-slot.ts`, `fs-atomic.ts`, `key-store-file.ts` and the two push notifiers import those built-ins, and none is on the default entry. Say this in a comment beside the alias table, because the next reader of sereus-chat's config will wonder.
- A `resolveRequest` wrapper that calls the incoming `resolveRequest` (or `context.resolveRequest` with `resolveRequest: undefined`, as today) and applies three rules, in this order:
  1. **Peers resolve from the app.** When `moduleName` is one of the kit's `peerDependencies` (read from the kit's own `package.json`, not a second list) or a subpath of one, resolve it with `originModulePath` set to a file in `projectRoot`. The kit's real path is outside the app in a monorepo, and Metro looks in the `node_modules` directories above the importing file before `nodeModulesPaths`, so a root-hoisted copy (the kit's types-only dev install of `react-native-quick-crypto`, or any future one) would otherwise be bundled beside the app's. For an app installing the kit from npm this changes nothing, because the kit already sits inside the app's `node_modules`.
  2. **`@babel/runtime/*` resolves to its CommonJS helpers**, via `require.resolve` from `projectRoot` (not from the kit, so the app's copy is used). sereus-chat needs this because its condition list puts `import` ahead of `require`, and then `_interopRequireDefault is not a function`. The reference app does not need it today, because Expo's default conditions put `require` first. It is kept because it is harmless for the reference app and required by any app with sereus-chat's conditions. Fall through on a resolve failure.
  3. **`browser`-field redirects for `@libp2p/crypto` and `@libp2p/webrtc`.** Port today's logic and its long comment (why the `browser` variant and not `react-native`; why `exports` resolution skips the rewrite). One change: instead of loading one map up front from the first `nodeModulesPaths` entry that holds each package, derive the map from the package directory of the file actually resolved (the path segment ending in `node_modules/@libp2p/crypto` or `node_modules/@libp2p/webrtc`), cached per directory. Then every installed copy is covered, including a nested one, and an npm-installed app with no `nodeModulesPaths` needs no search roots. Skip non-string targets as today.

The helper does **not** set condition names or `unstable_enablePackageExports`. Both toolchains' defaults already enable package exports, and choosing condition order is the app's business. The README says the kit relies on those defaults.

## The reference app

`packages/reference-app-rn/metro.config.js` shrinks to computing its four roots and calling the helper. The two app-specific `NOTE:` comments stay there beside `linkedRoots`: the one about a fourth portaled sibling, and the accepted-tradeoff note on watching whole repo roots. Drop `readable-stream` and `buffer` from the app's dependencies if nothing else in the app imports them, and remove their `knip.ts` ignores if they no longer apply.

## Test: `packages/cadre-rn/test/metro/with-cadre-metro.spec.ts`

One spec, three cases, each a branch that fails silently on a phone if it breaks (a wrong key-generation variant, or a second React Native copy, shows up only at runtime):

- A file resolved inside `node_modules/@libp2p/crypto/` that the package's `browser` map lists is swapped for its browser target; a `false` target is ignored.
- A peer (`react-native`) imported from a file outside `projectRoot` is resolved with an `originModulePath` inside `projectRoot`.
- `@babel/runtime/helpers/interopRequireDefault` resolves to the CommonJS file under `projectRoot`.

Drive the wrapper with a fake `context.resolveRequest` that records its arguments, over a fixture tree built in a temporary directory at test time: `node_modules` is git-ignored, so the fixture cannot be committed. The fixture holds no links, so `rmSync(…, { recursive: true })` on it is safe (see `tickets/rules/sibling-repos.md`). Put it in the kit's non-guarded Vitest project.

## Edge cases & interactions

- **Bundle with the optional crypto peers missing.** This ticket runs before the app installs `react-native-quick-crypto`, so `test:bundle` here is the recorded proof that an app without the crypto peers bundles. Say so in the handoff.
- **An upstream `resolveRequest` that returns `null` or throws.** Pass both through unchanged; only a `sourceFile` result is ever rewritten.
- **A peer the app has not installed** (for example `react-native-webrtc` in an app without WebRTC, when a kit module that imports it is never imported): rule 1 only runs when something asks for that name, so it adds no new failure. If it is asked for, resolving from the app root fails with Metro's normal "unable to resolve" error, naming the module.
- **Linked mode vs npm mode.** With `linkedRoots` omitted, `watchFolders` and `nodeModulesPaths` get only the project's own entry. Verified by inspection; sereus-chat's adoption is its own project's call.
- **An interim rule 1 already exists in the app's `metro.config.js`** (`isKitPeerImport`, added by `rn-kit-polyfills`). The concrete case: `react-native-webrtc` is hoisted to the repo root for `@libp2p/webrtc`, so the kit's `polyfills/webrtc.js` resolved that copy while `@libp2p/webrtc`'s `index.react-native.js` resolved the app's, and the Android export carried both (39 modules each). The interim rule brought it back to one. The helper's rule 1 replaces it; delete it from `metro.config.js` when the file shrinks to the helper call. In the one-copy check, count `react-native-webrtc` and `react-native-get-random-values` as well as `react-native`.
- **The browser-field rewrite does not reach `@libp2p/webrtc`'s `webrtc/index.js`.** The Android export's source map (2026-09-26, before and after `rn-kit-polyfills`) holds `webrtc/index.react-native.js` and the `browser` variants of `private-to-public/transport` and `utils/get-rtcpeerconnection` only: the package's `react-native` field maps `webrtc/index.js` first, so the resolved path never equals the key the rewrite looks up. Nothing is broken by it (the `react-native` variant imports `react-native-webrtc` directly), but today's `metro.config.js` comment says the rewrite covers `webrtc/index`; when porting that comment, say what actually happens.
- **`metro-resolution.ts`** in the app still reads `config.resolver.nodeModulesPaths` from `metro.config.js`. Loading the config now also loads the helper, which is plain CommonJS with no Metro import, so the app's `polyfills` Vitest project keeps working. Run it.

## Docs

`docs/reference-app-rn.md` § Metro Configuration and "Metro module aliases (Node.js built-in shims)": describe `withCadreMetro` and its options, and keep the explanations (moved into the helper's comments, summarised in the doc). Kit README: add the `/metro` row and a `metro.config.js` example for Expo and for bare React Native.

## TODO

- `git mv` the three shims to `packages/cadre-rn/shims/`; write `metro/index.cjs`; update the kit's `files`, `exports` and dependencies.
- Rewrite `packages/reference-app-rn/metro.config.js` to call the helper; trim app dependencies and `knip.ts`.
- Write the spec.
- Update docs and README.
- Run `yarn lint`, both packages' `typecheck` and `test` (including the app's `polyfills` project), `yarn dep-check`, and `yarn workspace @serfab/reference-app-rn test:bundle`. The bundle must succeed; also confirm the exported bundle holds one `react-native` copy (for example, count `node_modules/react-native/Libraries/Core/InitializeCore` module paths in the source map, or run `expo export` with `--dump-sourcemap` and inspect), then delete the export output.
