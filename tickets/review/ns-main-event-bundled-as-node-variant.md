description: The NativeScript app bundled the Node.js version of a small event library, which threw and swallowed an error every time the networking stack created an abort signal; the bundler now uses the library's browser version, which does nothing.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/webpack.config.js (top-of-file helpers `BROWSER_MAP_PACKAGES` / `owningPackage` / `loadBrowserMap`, and the `browser-map-rewrite` plugin), docs/reference-app-ns.md (§ "Named-package Node → browser rewrite", layout line), packages/reference-app-ns/README.md (layout line)
repro: verified
----

# `main-event` bundled as its Node variant — review handoff

Reported on gotchoices/sereus#45 (point 1): `main-event`'s Node `dist/src/events.js` calls the static `setMaxListeners` from `node:events`, which the npm `events` 3.3.0 package (what `node:events` is rewritten to) does not export, so each call throws a `TypeError` that the package's `catch` swallows. libp2p calls it once per abort signal. The package's `browser` / `react-native` maps point at `events.browser.js` (a no-op), but `@nativescript/webpack` does not apply a package's `browser` map to its internal relative imports, so the Node file was bundled.

## What changed

`packages/reference-app-ns/webpack.config.js`: the `@libp2p/crypto`-only rewrite became a rewrite for an explicit package list, `BROWSER_MAP_PACKAGES = new Set(['@libp2p/crypto', 'main-event'])`. One `NormalModuleReplacementPlugin` (`browser-map-rewrite`) handles every relative `.js` request:

- resolve the request against the issuer's directory;
- `owningPackage(target)` takes the package name and root from the **last** `<sep>node_modules<sep>` segment of that path (two segments for scoped names) — this satisfies the ticket's "match with the `node_modules` prefix" requirement and also picks the innermost package for nested installs;
- if the name is listed, look up the package-relative path in that copy's `browser` map (`loadBrowserMap(pkgRoot)`, cached per root) and redirect to the mapped file when the value is a string (a `false` value, meaning "empty module" in the browser-field spec, is left alone — no listed package uses it).

Deviation from the ticket's suggested shape: the ticket proposed keeping the old fixed search roots (`node_modules`, root `node_modules`, two `../../../optimystic/...` paths) and loading one map per package name. Instead each installed copy's map is read from its own `package.json`, at the root derived from the resolved path. That drops the hard-coded optimystic paths and means two copies at different versions each use their own map. Also dropped: the old `if (!abs.endsWith('.js')) abs += '.js'` — dead, since the plugin's regex only fires on requests ending in `.js`.

Header comment in the config and the layout lines in `docs/reference-app-ns.md` and `packages/reference-app-ns/README.md` now say "named-package browser rewrite". The doc section was renamed to "Named-package Node → browser rewrite", with one item per package and its reason, and the rule that packages join only when measured. One correction: the old doc listed "webcrypto" among crypto's browser files, but the installed map has no such entry (aes-gcm, hmac, ecdh / ed25519 / rsa / secp256k1 keys only), so that word was dropped.

## Validation done

- Module listing (run from `packages/reference-app-ns`, same config factory as `scripts/bundle-check.js`):
  ```
  node -e "const webpack=require('webpack');const cfg=require('./webpack.config.js')({android:true,appPath:'app',appResourcesPath:'App_Resources',production:false,sourceMap:false});webpack(cfg,(e,s)=>{const j=s.toJson({modules:true});const all=[];const walk=m=>{all.push(m.name);(m.modules||[]).forEach(walk)};j.modules.forEach(walk);all.filter(n=>/main-event|@libp2p.crypto/.test(n)).forEach(n=>console.log(n))})"
  ```
  Now lists `main-event/dist/src/index.js` and `main-event/dist/src/events.browser.js`, not `events.js`. The `@libp2p/crypto` `keys/{ed25519,rsa,secp256k1,ecdh}/index.browser.js` and `hmac/index.browser.js` are still selected and no Node `index.js` of those is bundled. (`aes-gcm` does not appear in either variant — nothing in the graph imports it.)
- `yarn workspace @serfab/reference-app-ns test:bundle`: 0 errors, 0 warnings.
- `npx eslint packages/reference-app-ns/webpack.config.js`: clean.

## Tests

None added, as the ticket specified: the module listing above is the check, and `test:bundle` guards the build. Nothing in CI asserts that `events.browser.js` (or the crypto browser files) is the one bundled — a future change that silently stopped the rewrite would still pass `test:bundle`. That was true of the crypto rewrite before this ticket too; flagging it rather than adding a guard, since the ticket rejected a general "Node variant bundled" check.

## Not verified

- No on-device run. The CPU saving (~2% of a join, per the reporter) was not re-measured; the claim rests on the bundled-module listing above.
- Behaviour of the nested optimystic copy of `main-event` (`../optimystic/packages/db-p2p/node_modules/main-event`, also 1.0.1) is untested only because the current bundle does not include it; the rewrite keys on the resolved path, so it would apply there too.

## For the reviewer

- Check `owningPackage` on Windows vs POSIX paths (it uses `path.sep` throughout; only exercised on Windows here).
- The plugin now runs `path.resolve` for every relative `.js` request in the graph rather than first filtering by a crypto substring of the issuer's directory; build time was ~6.7 s either way.
