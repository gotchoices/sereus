description: Move the React Native reference app's startup patches for missing browser features into the shared kit package, so other Sereus phone apps import them instead of keeping their own drifting copies.
prereq: rn-kit-package-and-native-noise-crypto
architecture: docs/reference-app-rn.md#polyfills
files: packages/cadre-rn/, packages/reference-app-rn/polyfills/, packages/reference-app-rn/index.js, packages/reference-app-rn/package.json, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/polyfills/, knip.ts, eslint.config.mjs, docs/reference-app-rn.md, docs/architecture.md
----
# Polyfills move into `@serfab/cadre-rn`

Design context: `rn-kit-package-and-native-noise-crypto` (the package-wide plan and its decisions). This ticket moves the runtime globals only. The three Node built-in shims (`node-crypto.js`, `node-os.js`, `empty.js`) are reached only through `metro.config.js` and move with the Metro helper in `rn-kit-metro-helper`; leave them in the app for now.

## What moves

From `packages/reference-app-rn/polyfills/` to `packages/cadre-rn/polyfills/` (use `git mv` so history follows): `hermes.js`, `event.js`, `intl-pluralrules.js`, `registry.js`, `webrtc.js`, `audit.js`, `reload-reason.js`.

New entry modules in the kit:

- `polyfills/index.js`: imports `./hermes`, `./intl-pluralrules`, `./event`, in that order. This is `@serfab/cadre-rn/polyfills`.
- `polyfills/webrtc.js`: unchanged, exported as `@serfab/cadre-rn/polyfills/webrtc`.
- `polyfills/boot-check.js`: imports `./audit` then `./reload-reason`. Exported as `@serfab/cadre-rn/boot-check`. Both are development-build-only diagnostics that must run after every polyfill and before the app tree evaluates.

`package.json`: add `polyfills` to `files`; add the three `exports` entries; add the polyfills' own imports as `dependencies` (`@ungap/structured-clone`, `web-streams-polyfill`, `event-target-polyfill`, `@noble/hashes`, with the ranges the app declares today) and `react-native`, `react-native-get-random-values`, `react-native-webrtc` as **optional** peers (see the peer-dependency decision in the first ticket). The app's `index.js` becomes:

```js
// Must be the first import: every later module may read these globals at load time.
import '@serfab/cadre-rn/polyfills';
import '@serfab/cadre-rn/polyfills/webrtc';
import '@serfab/cadre-rn/boot-check';
import 'expo-router/entry';
// …the registerStrandWakeTask block stays as it is
```

Carry the reasoning comments now in `index.js` (why each import sits where it does) into the kit modules they describe, and leave `index.js` with one line each.

## Changes inside the moved files

- **`webrtc.js` now loads after `intl-pluralrules` and `event`**, not before them as it does today. It needs only `crypto.getRandomValues` from `hermes.js`, which still comes first. Say so in its header comment, and name this in the device-run ticket's checklist.
- **`audit.js`**: the `RTCPeerConnection` probe gets a `gap` reason ("only apps that import `@serfab/cadre-rn/polyfills/webrtc` install it"). An app without WebRTC (sereus-chat) then sees `gap`, not a `MISSING` warning; the reference app, which imports it, still sees `polyfilled` because `statusOf` checks presence first. Change the `[reference-app-rn]` log prefix to `[cadre-rn]`, and point the MISSING advice at the kit's files and the kit README.
- Comments that say "index.js imports this…" or cite `polyfills/*` app paths: rewrite to describe the kit's entry order and the one rule the app must follow (import `@serfab/cadre-rn/polyfills` first).
- `registry.js` says it is a deliberate copy of the NativeScript app's registry. Keep that note and update the path it names.

## Tests

- **Move** `test/polyfills/hermes-polyfills.spec.ts` and `test/polyfills/reload-reason.spec.ts` to `packages/cadre-rn/test/polyfills/`, as a `polyfills` Vitest project with **no** stale-build guard (as in the app today: it reads no sibling `dist`).
  - `hermes-polyfills.spec.ts` used the app's `require` and `resolvePackageDir` (from `metro-resolution.ts`, which reads the app's Metro config). In the kit, use `createRequire` on the kit's `package.json`, and a small local helper that finds an installed package directory by walking the kit's and the repo root's `node_modules`. Add `abort-controller` (the version React Native bundles, `3.0.0`) and `@libp2p/websockets` (the app's range) as kit `devDependencies`.
  - `reload-reason.spec.ts` mocks `react-native` with `vi.mock`. **Do not add `react-native` as a kit dev dependency** (see edge cases). If Vitest refuses to mock a module it cannot resolve, alias `react-native` to a stub file under `test/` in the kit's Vitest config.
- **Keep** `test/polyfills/dependency-globals.spec.ts` and `metro-resolution.ts` in the app. That spec guards the app's own installed dependency graph against the polyfill surface, and the graph is per-app; it reads the app's Metro config for the same reason. Repoint its reads of `polyfills/*.js` (`join(appDir, 'polyfills', …)`) at the kit's directory, found with `resolvePackageDir('@serfab/cadre-rn')`. The app's `polyfills` Vitest project stays, with this one spec in it; update the project comment in `packages/reference-app-rn/vitest.config.ts`.

No new tests.

## App dependencies

The app no longer imports `react-native-get-random-values` or `react-native-webrtc` itself but must keep both in `dependencies` (autolinking). Add them to the app's `ignoreDependencies` in `knip.ts` with that reason. Remove app dependencies that nothing in the app imports any more (`@ungap/structured-clone`, `web-streams-polyfill`, `event-target-polyfill`, …). Grep first: `@noble/hashes` is still used by `polyfills/node-crypto.js` until the next ticket, and may be used in `src/`. Add `"@serfab/cadre-rn": "workspace:^"` to the app.

## Docs

`docs/reference-app-rn.md` § Polyfills (and its subsections "Required polyfill dependencies", "Global polyfills", "Other global polyfills", "Polyfill quality principles"): the implementations now live in `@serfab/cadre-rn`; the app's job is the three imports above, polyfills first. Replace any "copy these files" wording with "depend on the kit". Update § Package Structure and the `docs/architecture.md` line that links "working implementations in `packages/reference-app-rn/polyfills/`". Add the three subpaths to the kit README, with the one rule: import `@serfab/cadre-rn/polyfills` before anything else.

## Edge cases & interactions

- **One copy of `react-native` in the bundle.** The kit's files live at `packages/cadre-rn/polyfills/`, outside the app. Their bare imports of `react-native`, `react-native-get-random-values` and `react-native-webrtc` find nothing in the `node_modules` directories above that path (the app sets `hoistingLimits: workspaces`, so these sit in `packages/reference-app-rn/node_modules`), and Metro then falls back to the app's `nodeModulesPaths`, which is the one copy. A kit dev dependency on any of them would put a copy at the repo root that Metro would find first. Verified by inspection of the kit's `package.json` here, and structurally fixed by `rn-kit-metro-helper`.
- **Babel over files outside the app.** Metro transforms the kit's files with the app's Babel preset, as it already does for `cadre-core`'s `dist` (`watchFolders` includes the repo root). `hermes.js` mixes `require` with ESM `export`s in `registry.js`; that works today only because Babel interop joins them. The bundle check below proves it still does.
- **Load order.** Nothing in the kit can force the app to import the polyfills first. The README and the header comment of `polyfills/index.js` state the rule.
- **Lint.** `eslint.config.mjs` treats `**/*.{js,cjs,mjs}` as tooling and scopes the phone-runtime guard to `packages/*/src`. The polyfills sit outside `src`, as they do today, so the guard does not flag them for defining the very globals it bans. Confirm `yarn lint` is clean.
- **EAS build.** Check how an EAS build of the reference app obtains workspace packages (`scripts/eas-build-pre-install.sh`, `eas.json`). The kit ships its polyfills as source, so it needs no build for them; if the pre-install hook lists workspaces explicitly, add the kit.

## TODO

- `git mv` the seven files; add `polyfills/index.js` and `polyfills/boot-check.js`; update the kit's `files`, `exports`, dependencies and optional peers.
- Apply the in-file changes (audit gap, log prefix, comments).
- Rewrite `packages/reference-app-rn/index.js` to the three kit imports.
- Move the two specs plus their helper into a kit `polyfills` Vitest project; keep and repoint `dependency-globals.spec.ts`.
- Clean up app dependencies; update `knip.ts`.
- Update docs (reference-app-rn.md § Polyfills and Package Structure, architecture.md link, kit README).
- Repoint the moved paths in open tickets that name them: `backlog/bug-rn-debug-placeholders-printed-raw` (`polyfills/hermes.js`, `index.js` order), `backlog/debt-verify-reload-diagnostics-on-device` (`polyfills/reload-reason.js`), `blocked/report-libp2p-websockets-buffered-amount` (`polyfills/hermes.js`). Change only the paths, not the substance.
- Run `yarn lint`, both packages' `typecheck` and `test`, `knip` (`yarn dep-check`), and `yarn workspace @serfab/reference-app-rn test:bundle` (an `expo export` of the Android bundle). The bundle must succeed.
