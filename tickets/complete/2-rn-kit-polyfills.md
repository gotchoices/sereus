description: Move the React Native reference app's startup patches for missing browser features into the shared kit package, so other Sereus phone apps import them instead of keeping their own drifting copies.
prereq: rn-kit-package-and-native-noise-crypto
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/polyfills/ (index.js, boot-check.js new; hermes.js, event.js, intl-pluralrules.js, registry.js, webrtc.js, audit.js, reload-reason.js moved), packages/cadre-rn/package.json, packages/cadre-rn/vitest.config.ts, packages/cadre-rn/tsconfig.typecheck.json, packages/cadre-rn/test/polyfills/ (hermes-polyfills.spec.ts, reload-reason.spec.ts moved), packages/cadre-rn/README.md, packages/reference-app-rn/index.js, packages/reference-app-rn/metro.config.js, packages/reference-app-rn/package.json, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts, packages/reference-app-rn/test/polyfills/metro-resolution.ts, packages/reference-app-rn/README.md, knip.ts, yarn.lock, docs/reference-app-rn.md, docs/architecture.md, docs/testing.md, eslint.config.mjs (comment), tickets/implement/3-rn-kit-metro-helper.md, tickets/blocked/rn-native-noise-crypto-device-run.md, packages/reference-app-ns/src/polyfills/ (audit, event, hermes, intl-pluralrules, websocket comments), ops/docker/libp2p-infra/README.md
----
# Complete: polyfills move into `@serfab/cadre-rn`

Second of the four kit tickets (design context: `rn-kit-package-and-native-noise-crypto`). The seven runtime-global polyfill files moved (`git mv`) from `packages/reference-app-rn/polyfills/` to `packages/cadre-rn/polyfills/`. The three Node built-in shims (`node-crypto.js`, `node-os.js`, `empty.js`) stay in the app until `rn-kit-metro-helper`.

**Where the diff is:** `git mv` staged the nine renames, and a concurrent unrelated commit (`1009852e`, "tickets: re-attach over a slow relayed link…") swept them up as pure renames with no content change. This ticket's own commit therefore shows the moved files as modifications in place. To see a moved file's full change, diff it against its old path at `5f3279b9`.

## What the kit now exports

| Subpath | File | Loads |
|---|---|---|
| `@serfab/cadre-rn/polyfills` | `polyfills/index.js` | `./hermes`, `./intl-pluralrules`, `./event`, in that order |
| `@serfab/cadre-rn/polyfills/webrtc` | `polyfills/webrtc.js` | `react-native-webrtc` `registerGlobals()` |
| `@serfab/cadre-rn/boot-check` | `polyfills/boot-check.js` | `./audit`, then `./reload-reason` (both `__DEV__` only) |

`package.json`: `polyfills` added to `files`; the three exports are plain string targets (Metro consumes the source as-is); `@noble/hashes ^2.0.0`, `@ungap/structured-clone ^1.3.0`, `event-target-polyfill ^0.0.4`, `web-streams-polyfill ^4.1.0` are dependencies; `react-native >=0.79.0`, `react-native-get-random-values ^1.11.0`, `react-native-webrtc ^124.0.6` are **optional** peers; `abort-controller 3.0.0` and `@libp2p/websockets ^10.1.3` are dev dependencies for the spec. No `react-native` dev dependency. `yarn pack --dry-run` lists all nine `polyfills/*.js`.

The app's `index.js` is now the three kit imports (one comment line each), then `expo-router/entry` and the unchanged wake-task block. App dependencies dropped: `@ungap/structured-clone`, `event-target-polyfill`, `web-streams-polyfill`. Kept: `@noble/hashes` (the app's `polyfills/node-crypto.js` imports it), `react-native-get-random-values` and `react-native-webrtc` (autolinking). Added `@serfab/cadre-rn: workspace:^`.

In-file changes: `audit.js` gives the `RTCPeerConnection` probe a `gap` reason, logs under `[cadre-rn]`, and its MISSING warning points at the kit's files and README. Comments that named app paths or `index.js` now describe the kit's entry order. `registry.js` keeps its "deliberate copy of the NativeScript registry" note.

## Deviations from the ticket, and why

- **Interim peer rule in the app's `metro.config.js`** (`isKitPeerImport`, about 15 lines, not in the ticket). The ticket's edge case said the kit's bare imports of `react-native`, `react-native-get-random-values` and `react-native-webrtc` find nothing above `packages/cadre-rn/`. That holds for the first two, but **`react-native-webrtc` is hoisted to the repo root** (for the root copy of `@libp2p/webrtc`). Measured from the Android export's source map: before the move, one copy (the app's); after the move without the rule, two (root and app, 39 modules each), because `@libp2p/webrtc`'s `webrtc/index.react-native.js` still imports the app's copy. The globals and the transport classes then came from different copies, each numbering peer connections from its own `nextPeerConnectionId = 0`. The rule resolves the kit's `peerDependencies` (read from the kit's `package.json`) as if the app imported them. With it, the export is back to one copy each of `react-native`, `react-native-webrtc` and `react-native-get-random-values`. `rn-kit-metro-helper`'s rule 1 supersedes it; that ticket now says so and asks it to count all three in its one-copy check.
- **Knip**: the ticket asked for `ignoreDependencies` entries for `react-native-get-random-values` / `react-native-webrtc` in the app. Knip already counts them as used and reported "Remove from ignoreDependencies", so they are not added. Two things knip did flag are handled instead. `@noble/hashes` read as unused in the app, because its only importer (`polyfills/node-crypto.js`) is reached only through `metro.config.js`. Fixed with `entry: ['polyfills/*.js']` on the app, which also clears the three shims from "unused files". And on the kit: its three optional peers ("Referenced optional peerDependencies") and the two dev dependencies the spec loads through `createRequire` / a path lookup. Both are ignored with one-line reasons.
- **App stale-build targets**: `test/build-targets.spec.ts` requires every workspace dependency in `TARGETS`, with no exemption mechanism, so `@serfab/cadre-rn` (`dist/noise-crypto.js`) is listed. No app spec loads it yet; the comment says so.
- **Kit typecheck**: the kit's `lib` is ES2022, so the moved spec types the polyfilled `Promise` locally (`PolyfilledPromiseCtor`) instead of relying on `Promise.withResolvers`. `tsconfig.typecheck.json` gains `allowJs` (checkJs off) so the spec's `import('../../polyfills/reload-reason.js')` resolves. The app got both from Expo's base config.
- **`reload-reason.spec.ts` needed no `react-native` stub.** `vi.mock('react-native', factory)` works with the module unresolvable; no alias was added.
- **`webrtc.js` header corrected**, beyond the path edits. It claimed Metro resolves `@libp2p/webrtc` to its `browser` variant and that `webrtc/index.browser.js` captures the global at module scope. The source map (before and after this change) shows `webrtc/index.react-native.js` is bundled, which imports `react-native-webrtc` directly. Only the private-to-public `transport` / `get-rtcpeerconnection` get `browser` variants, and those read the bare global at call time. The header now says that. The same overstatement in `metro.config.js` is left for `rn-kit-metro-helper`, which ports that comment; its ticket has the evidence.

## Load-order change (for the device run)

`webrtc.js` now loads after `intl-pluralrules.js` and `event.js`. The one effect found: `react-native-webrtc`'s own `event-target-shim` checks for a global `Event` / `EventTarget` when it loads and, when present, chains its classes' prototypes onto them. React Native 0.79 bundles `Event`/`EventTarget` classes for its own use but installs neither as a global (no `polyfillGlobal` for them in `Libraries/Core` or `src/private/setup`), and Expo 53's runtime installs only `TextDecoder`, `URL`, `URLSearchParams`. So before, the shim found none; now it finds `event-target-polyfill`'s. That is the shim's normal browser path. Recorded in `webrtc.js`, `docs/reference-app-rn.md` § Polyfills, and step 2 of `blocked/rn-native-noise-crypto-device-run`.

## Tests

No tests added. Moved: `hermes-polyfills.spec.ts` and `reload-reason.spec.ts` into the kit's new `polyfills` Vitest project (no stale-build guard). The kit's existing specs are now the `node` project, which keeps the guard and the crypto aliases. `hermes-polyfills.spec.ts` uses the kit's own `createRequire` and an inline `resolvePackageDir` over the kit's and the repo root's `node_modules`, so `@libp2p/websockets` is now the kit's dev copy (10.1.3 at the root, the same version as the app's). Kept in the app and repointed: `dependency-globals.spec.ts` reads the kit's `polyfills/` through `resolvePackageDir('@serfab/cadre-rn')`; `metro-resolution.ts` no longer exports `appDir`.

## Validation run

- `yarn lint`: clean.
- `yarn workspace @serfab/cadre-rn build`, `typecheck`, `test`: 39 pass (`--project polyfills`: 25).
- `yarn workspace @serfab/reference-app-rn typecheck`, `test`: 294 pass across 20 files (`--project polyfills`: 5).
- `yarn dep-check` (knip + dep ranges): pass. `yarn check:vitest-typecheck-coverage`, `check:test-file-typecheck-coverage`, `check:stale-build-guard-wiring`: pass.
- `yarn workspace @serfab/reference-app-rn test:bundle`: succeeds (4713 modules). Separately, `expo export --platform android --source-maps` was compared before and after. Before: 4487 source-map modules, 8.80 MB `.hbc`. After: 4493, 8.81 MB. The polyfill files map to `packages/cadre-rn/polyfills/`. Method: read `sources` from the `.hbc.map` and group by the `node_modules/<pkg>` root.
- **Not run:** `yarn smoke:published` (network); its export-target check would cover the three new targets. Root `yarn test` across every workspace (only the two touched packages and the root gates were run). No EAS build: `scripts/eas-build-pre-install.sh` lists no workspaces (it runs a monorepo `yarn install`), and the kit's polyfills need no build, so nothing was added there.

## Known gaps and things worth a second look

- **No device run.** Babel over the kit's files (including `hermes.js`'s `require` of `registry.js`'s ESM exports) is proven only by the bundle building. Whether the audit reads `polyfilled` for `RTCPeerConnection`, and whether WebRTC still works after the order change, is `blocked/rn-native-noise-crypto-device-run`.
- **`@noble/hashes` hoisting shift.** `yarn install` moved the root `@noble/hashes` from 2.0.1 to 2.2.0 (the kit's `^2.0.0` resolves to 2.2.0). The root `@libp2p/crypto` and `@noble/curves` now nest their own 2.0.1, which adds nine source-map modules to the bundle. That accounts for most of the +6 net and the ~0.01 MB. Left as is.
- **Possibly wrong claim, not changed:** `dependency-globals.spec.ts`'s `PROVIDED.EventTarget` says "Hermes provides it" (`by: 'react-native'`). Per the load-order finding above, React Native 0.79 and Expo 53 install no global `EventTarget`, so the audit's `native` reading is probably `event-target-polyfill`'s (which marks no registry key). I changed only the path in that line.
- The `react-native` peer range `>=0.79.0` is my choice (the ticket gave none): the reference app runs 0.79.6 and sereus-chat 0.82.
- Knip warns (not an error) that `runPolyfillAudit` in `audit.js` is an unused export. It was already exported and unused in the app.
- A git-ignored `packages/reference-app-rn/dist` from an earlier export was overwritten by the comparison exports and removed by `test:bundle`, as that script always does.

## Other tickets touched

Paths only: `backlog/bug-rn-debug-placeholders-printed-raw`, `backlog/debt-verify-reload-diagnostics-on-device`, `blocked/report-libp2p-websockets-buffered-amount`. Added evidence: `implement/3-rn-kit-metro-helper` (the interim rule it replaces, the one-copy check list, the `webrtc/index.js` resolution fact) and `blocked/rn-native-noise-crypto-device-run` step 2 (the `event-target-shim` effect).

## Review findings

Read the implement diff (`3242e8be`, with the renames in `1009852e`) before the handoff. Ran `yarn lint` (clean), `yarn dep-check` (pass; the only kit warning is the pre-existing unused `runPolyfillAudit` export), kit `typecheck` + `test` (39 pass), app `typecheck` + `test` (294 pass), and `yarn workspace @serfab/reference-app-rn test:bundle` (succeeds, after the `event.js` change below).

**Fixed in this pass**

- **Broken table in `docs/reference-app-rn.md` § Other global polyfills.** The `event.js` row had lost its Notes cell, and that text had become a fifth cell on the new `webrtc.js` row. Each row now has its own four cells.
- **`EventTarget` was misreported.** The drift guard's entry said "Hermes provides it" (`by: 'react-native'`), and the boot audit always read `native`. The implementer suspected this; it is wrong. React Native 0.79.6's `Libraries/Core` installs no `EventTarget` (every `polyfillGlobal` name was checked), Expo 53's `src/winter` installs none, and Hermes has no DOM APIs. On the phone it is always `event-target-polyfill`'s. The fix is at the source, not only in the text: `event.js` now records whether `EventTarget` existed, loads the package with `require` so that check runs before it, and then marks `EventTarget` in the registry. The audit probe has `key: 'EventTarget'`, the drift guard lists it as `by: 'polyfill', file: 'event.js'` (so its existing "file still marks the key" test covers it), and the "always reads `native`" limit is gone from `docs/reference-app-rn.md` § Guards. Checked in Node with `EventTarget`/`Event`/`CustomEvent` deleted (both keys marked, `CustomEvent` works), and by the bundle build. Step 2 of `blocked/rn-native-noise-crypto-device-run` now expects `EventTarget` to read `polyfilled`.
- **Stale paths to the moved files.** The NativeScript app's `src/polyfills/{audit,event,hermes,intl-pluralrules,websocket}.ts` and `ops/docker/libp2p-infra/README.md` pointed at `packages/reference-app-rn/polyfills/…`. They now point at `packages/cadre-rn/polyfills/…`. The `node-crypto.ts` / `node-os.ts` references are still correct, because those shims stayed in the app. The built `reference-app-ns/platforms/**/bundle.js` copies are generated output and were not touched.

**Checked, no change**

- Exports and packaging: the three subpaths are plain string targets on files in `files`. None has `types`, which is fine for side-effect imports from JS or TS. Optional peers match what the files import (`hermes.js` → get-random-values, `webrtc.js` → webrtc, `reload-reason.js` → react-native).
- The interim `isKitPeerImport` rule in `metro.config.js`: it rewrites only bare peer specifiers from files under the kit's real path. `path.relative` plus the `isAbsolute` check covers other Windows drives. `packages/cadre-rn/node_modules` holds only Vite caches, so no nested dependency is redirected. `rn-kit-metro-helper` already records that it replaces this rule.
- Entry order: `index.js` loads `hermes` → `intl-pluralrules` → `event`. `event.js`'s `CustomEvent extends Event` runs after the package installs `Event`. The `webrtc.js` load-order note matches what the source shows.
- Tests: the two moved specs are unchanged apart from the path and type edits described above. The kit's inline `resolvePackageDir` is similar to the app's `metro-resolution.ts` but walks different roots (the kit's, not Metro's `nodeModulesPaths`), so it is not duplicated logic. No tests added: the `EventTarget` fix is covered by the drift guard's existing marks check, and the other fixes are comments and docs.
- Docs: `architecture.md`, `testing.md`, `reference-app-rn.md`, and both READMEs were read against the new layout. Apart from the table and the `EventTarget` limit above, they match.

**Not verified (unchanged from the handoff):** no device run (`blocked/rn-native-noise-crypto-device-run`), no `yarn smoke:published`, no root `yarn test` across every workspace.

**Tickets and tripwires:** none filed. Nothing found here is major or conditional.
