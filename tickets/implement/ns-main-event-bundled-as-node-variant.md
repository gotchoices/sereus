description: The NativeScript app bundles the Node.js version of a small event library, which throws and swallows an error every time the networking stack creates an abort signal; point the bundler at the library's browser version instead, which does nothing.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/webpack.config.js (the `@libp2p/crypto` rewrite, lines ~13-34 and ~77-120), docs/reference-app-ns.md (§ "`@libp2p/crypto` Node → browser rewrite" ~313-331, layout line ~182)
repro: verified
----

# `main-event` bundled as its Node variant

Reported on gotchoices/sereus#45 (point 1), from a chat app built on `reference-app-ns` (NativeScript 8.9, V8, Galaxy S7): about 2% of a join's CPU went to this path. That figure is the reporter's; it was not re-measured here.

## What happens

`main-event` 1.0.1 (the only copy the NS bundle includes is `packages/reference-app-ns/node_modules/main-event`) has two variants of `dist/src/events.js`, selected only through its top-level `browser` / `react-native` package fields:

- `events.js` (Node): imports `setMaxListeners` from `node:events` and calls it inside `try { … } catch { /* swallow */ }`.
- `events.browser.js`: `export function setMaxListeners() { }`.

`index.js` imports `./events.js` relatively. As already established for `@libp2p/crypto`, `@nativescript/webpack` does not apply a package's `browser` map to its internal relative imports, so the Node file is bundled. `node:events` is rewritten to the npm `events` 3.3.0 package, which has only `EventEmitter.prototype.setMaxListeners`, no static `setMaxListeners`; the named import is `undefined`, so every call throws a `TypeError` that the `catch` discards. libp2p calls `setMaxListeners` once per abort signal it creates.

Verified by compiling the bundle with the same config factory `scripts/bundle-check.js` uses and listing module names (run from `packages/reference-app-ns`):

```
node -e "const webpack=require('webpack');const cfg=require('./webpack.config.js')({android:true,appPath:'app',appResourcesPath:'App_Resources',production:false,sourceMap:false});webpack(cfg,(e,s)=>{const j=s.toJson({modules:true});const all=[];const walk=m=>{all.push(m.name);(m.modules||[]).forEach(walk)};j.modules.forEach(walk);all.filter(n=>/main-event/.test(n)).forEach(n=>console.log(n))})"
```

Output today: `./node_modules/main-event/dist/src/index.js` and `./node_modules/main-event/dist/src/events.js`. After the fix it must list `events.browser.js` and not `events.js`.

## Fix

Generalize the existing `@libp2p/crypto` browser-map rewrite in `webpack.config.js` from one package to a short list of named packages, and add `main-event` to it:

- `loadLibp2pCryptoBrowserMap()` becomes a loader taking a package name (same search roots), returning that package's `browser` object map or `null`.
- The `libp2p-crypto-browser-rewrite` plugin becomes one `NormalModuleReplacementPlugin` (or one per package) that, for a relative `.js` request whose resolved path lies under `node_modules/<package>/`, looks up the package-relative path in that package's map and redirects to the mapped file. Match the segment with the `node_modules` prefix (`node_modules<sep>main-event<sep>`) so a directory merely named `main-event` elsewhere cannot match.
- The package list is explicit: `['@libp2p/crypto', 'main-event']`. Do **not** apply every package's `browser` map: the reporter lists other Node variants that are bundled (libp2p's connection-manager constants, connection gater and user agent; `mortice`; `weald`; `@libp2p/utils`'s thin-waist address helper; `multiformats`' sha2). None is known to cost anything, and the user agent already has its own NS shim (`libp2p-user-agent-shim`), because libp2p's browser user agent reads `navigator.userAgent`. A package joins the list when one is measured to matter.

Considered and rejected: a `bundle-check.js` guard that fails whenever a Node variant is bundled despite a browser map. Most of those variants are harmless, so the guard would be an allowlist to maintain, and the check would not tell which ones cost anything.

No new unit test. The module-listing command above is the check; `yarn workspace @serfab/reference-app-ns test:bundle` must stay at 0 errors and 0 warnings.

## Docs

`docs/reference-app-ns.md`: rename and rework § "`@libp2p/crypto` Node → browser rewrite" into a section covering the named-package browser-map rewrite, with one item per package and its reason (crypto: Node key APIs missing from the shim; `main-event`: a thrown and swallowed `TypeError` per abort signal), plus the rule that packages are added only when measured. Update the `webpack.config.js` line in the layout block (~182) and the header comment in `webpack.config.js` (~47) to match.

## TODO

- Generalize the browser-map loader and rewrite plugin in `packages/reference-app-ns/webpack.config.js` to an explicit package list; add `main-event`.
- Run the module-listing command; confirm `events.browser.js` is bundled and `events.js` is not, and that the `@libp2p/crypto` `*.browser.js` files are still selected (e.g. `keys/ed25519/index.browser.js`).
- Run `yarn workspace @serfab/reference-app-ns test:bundle` (0 errors, 0 warnings).
- Update `docs/reference-app-ns.md` and the config's header comment.
