description: The shared React Native kit now provides a one-call bundler setup, and the reference phone app's bundler configuration is reduced to that single call.
prereq: rn-kit-polyfills
architecture: docs/reference-app-rn.md#metro-configuration
files: packages/cadre-rn/metro/index.cjs, packages/cadre-rn/shims/, packages/cadre-rn/test/metro/with-cadre-metro.spec.ts, packages/cadre-rn/package.json, packages/cadre-rn/vitest.config.ts, packages/cadre-rn/README.md, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/package.json, packages/reference-app-rn/README.md, packages/reference-app-ns/src/polyfills/node-crypto.ts, packages/reference-app-ns/src/polyfills/node-os.ts, knip.ts, yarn.lock, docs/reference-app-rn.md, docs/architecture.md, docs/testing.md, docs/reference-app-ns.md
----
# `withCadreMetro` (`@serfab/cadre-rn/metro`)

Third of the four kit tickets. Metro is React Native's bundler; `metro.config.js` is CommonJS loaded by Node.

## What landed

- `packages/cadre-rn/metro/index.cjs`, exported as `@serfab/cadre-rn/metro`. `withCadreMetro(config, { projectRoot, linkedRoots = [] })` mutates and returns the toolchain's config: symlinks on, `linkedRoots` appended to `watchFolders`, `<projectRoot>/node_modules` then each linked root's `node_modules` appended to `nodeModulesPaths`, the Node built-in aliases (`os`, `crypto`, `net`, `tls`, `stream`, `buffer`, bare and `node:`) added to `extraNodeModules` with the app's existing entries winning, and a `resolveRequest` wrapper with three rules:
  1. the kit's `peerDependencies` (and their subpaths) resolve as if the app imported them, whoever the importer is;
  2. `@babel/runtime/*` resolves to the CommonJS helper in the app's copy via Node's `require.resolve`;
  3. a resolved file in `@libp2p/crypto` or `@libp2p/webrtc` is swapped for its `browser`-field target, read from the package directory of the file actually resolved, so every installed copy is covered.
- The Node built-in shims moved from `packages/reference-app-rn/polyfills/` to `packages/cadre-rn/shims/`. The kit gained `buffer` and `readable-stream` dependencies; the app dropped `buffer`, `readable-stream`, `@noble/hashes` and `@types/readable-stream`.
- `packages/reference-app-rn/metro.config.js` is the four linked roots, the two existing `NOTE:` comments, and one `withCadreMetro` call.
- Docs: `docs/reference-app-rn.md` § Metro Configuration documents the helper and its rules; the kit README has a `/metro` section with Expo and bare React Native examples; the app README, `docs/architecture.md`, `docs/testing.md` and `docs/reference-app-ns.md` were repointed.
- Measured on an Android export (2026-09-26, 4,696 modules): one copy each of `react-native`, `react-native-webrtc`, `react-native-get-random-values` and `@babel/runtime`; all 15 bundled copies of `@libp2p/crypto` on their browser key modules; only `shims/node-os.js` of the shims is reached. Whether the 14 non-app `@libp2p/crypto` copies were already on browser variants before this change was not measured.

## Review findings

Read the implement diff (`c3b78bd1`) first, then the handoff; read Metro's `ModuleResolution.js` and `metro-resolver`'s `PackageResolve.js` in the app's `node_modules` to check two claims.

**Correctness.**
- Handoff worry that rule 1 makes Metro's "Unable to resolve" error name the app's `package.json` instead of the real importer: **not true.** Metro builds `UnableToResolveError` from `fromModule.path` (its own graph), not from the resolver context's `originModulePath`. The module name and the importer in the error are both right. Added one sentence to the `isKitPeer` comment saying so.
- Rule 1 swaps the origin to the app, and `metro-resolver`'s `redirectModulePath` reads the `browser` / `react-native` field from the origin's package. So a dependency that redirects a peer name in its own `browser` / `react-native` field would lose that redirect. No dependency does this today. Recorded as a `NOTE:` tripwire at `isKitPeer` in `packages/cadre-rn/metro/index.cjs`.
- Rule 3's package attribution (last `node_modules` segment, scoped names, pnpm `.pnpm/.../node_modules/@scope/name` layouts), the `false`-target skip, the `typeof null === 'object'` guard in `readBrowserMap`, and pass-through of `null` / non-`sourceFile` results: checked by reading; correct.
- Rule 2 rethrows everything except `MODULE_NOT_FOUND` / `ERR_PACKAGE_PATH_NOT_EXPORTED`, so exceptions are not swallowed. Node caches `require.resolve` lookups, so calling it per `@babel/runtime` import is not a repeated filesystem cost worth caching.
- Calling the upstream as `context.resolveRequest({ ...context, resolveRequest: undefined })` when the config has no resolver is carried over unchanged from the old app config, which bundled.
- The `buffer` alias fix (`require.resolve('buffer/')` instead of Node's built-in name) is right; unreached in this app.

**Hygiene / DRY.**
- `package.json` `./metro` export had identical `require` and `default` targets; reduced to a plain string (same resolution for every consumer). Re-ran the app's tests, which load `metro.config.js` and so the helper through that export, and `test:bundle`.
- `metro/index.cjs` is about 340 lines, most of it JSDoc explaining why each rule exists; functions are small and single-purpose. No split needed.
- The kit's peer list is read from its own manifest, not duplicated. Good.

**Docs.**
- Found two stale source comments the implementer missed: `packages/reference-app-ns/src/polyfills/node-crypto.ts` and `node-os.ts` still cited `packages/reference-app-rn/polyfills/...`. Repointed to `packages/cadre-rn/shims/...`. The only other hits were generated NativeScript build output under `platforms/`, which is not source.
- Read every doc the diff touched (`docs/reference-app-rn.md`, `docs/architecture.md`, `docs/testing.md`, `docs/reference-app-ns.md`, both READMEs); they match the code.

**Tests.** The three specs in `test/metro/with-cadre-metro.spec.ts` each pin one rule with real branching whose failure would only show on a phone; kept. The fixture tree has no links, so its recursive removal is safe under the sibling-repo rule. No tests added: the two findings above are, respectively, a non-issue and a conditional tripwire.

**Spec placement** (the `polyfills` Vitest project now also runs `test/metro/**`): accepted as is. The config's header comment says what the project covers, and a separate project would add configuration for one file.

**Declined / not done.**
- No `types` condition on `./metro`: the only consumer is an untyped `metro.config.js`; the helper is type-checked through the spec. Left as is.
- No device run (belongs with `rn-native-noise-crypto-device-run`); sereus-chat adoption and npm-mode (`linkedRoots` omitted) were checked by reading only.

**Validation (after the review edits).** `yarn lint` clean; `@serfab/cadre-rn` typecheck and test (42 tests, 5 files) pass; `@serfab/reference-app-rn` typecheck and test (294 tests, 20 files) pass; `yarn workspace @serfab/reference-app-rn test:bundle` exports; `yarn dep-check` reports no knip errors (the warn-level backlog is unchanged) and dep ranges pass.
