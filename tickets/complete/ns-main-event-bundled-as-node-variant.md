description: The NativeScript app bundled the Node.js version of a small event library, which threw and swallowed an error every time the networking stack created an abort signal; the bundler now uses the library's browser version, which does nothing, and the bundle check fails if that substitution ever stops happening.
architecture: docs/reference-app-ns.md
files: packages/reference-app-ns/browser-map.js (new: `BROWSER_MAP_PACKAGES`, `owningPackage`, `loadBrowserMap`, `browserVariantOf`), packages/reference-app-ns/webpack.config.js (`browser-map-rewrite` plugin), packages/reference-app-ns/scripts/bundle-check.js (unrewritten-file guard), docs/reference-app-ns.md, packages/reference-app-ns/README.md
repro: verified
----

# `main-event` bundled as its Node variant — complete

Reported on gotchoices/sereus#45 (point 1): `main-event`'s Node `dist/src/events.js` calls the static `setMaxListeners` from `node:events`, which the npm `events` package (what `node:events` is rewritten to) does not export, so every call threw a `TypeError` that the package swallowed; libp2p calls it once per abort signal. The package's `browser` map points at `events.browser.js` (a no-op), but `@nativescript/webpack` does not apply a package's `browser` map to its internal relative imports.

## What landed

- **Implement (`ticket(implement): ns-main-event-bundled-as-node-variant`)** — the `@libp2p/crypto`-only rewrite became a rewrite for an explicit package list (`@libp2p/crypto`, `main-event`). For every relative `.js` request, the target is resolved, its owning package taken from the last `node_modules` segment of the path, and, when that package is listed, the request is redirected to the file its own copy's `browser` map names. Each installed copy reads its own `package.json`, so the hard-coded optimystic search paths are gone.
- **Review** — the helpers moved to `packages/reference-app-ns/browser-map.js` behind one function, `browserVariantOf(file)`, used by both the webpack plugin and `scripts/bundle-check.js`. `test:bundle` now also fails if any bundled file is one the rewrite should have replaced.

## Review findings

Checked:

- **Correctness of the rewrite** — re-ran the bundled-module listing: `main-event/dist/src/events.browser.js` and the `@libp2p/crypto` `keys/{ed25519,rsa,secp256k1,ecdh}/index.browser.js` + `hmac/index.browser.js` are bundled; no Node variant of any is. Read webpack 5.107's `NormalModuleReplacementPlugin`: the callback also runs in `afterResolve`, where a rewritten request is absolute (fails the `startsWith('.')` guard) and an unrewritten one recomputes to no mapping — a harmless no-op, same as before.
- **`owningPackage` on POSIX vs Windows** — uses `path.sep` throughout and webpack hands native paths in `resource.context`, so the logic is identical on POSIX; only exercised on Windows. Degenerate inputs (path ending at `node_modules/`, bare `@scope`) yield names that are never listed. No change.
- **Dropped `.js` append** — confirmed dead: the plugin's regex is tested against `resource.request`, which already ends in `.js`.
- **RN parity** — Metro applies `browser` maps to relative imports inside a package (`docs/reference-app-rn.md` § "Why the browser rewrite matters"), so RN already gets `events.browser.js`; nothing to do there.
- **Docs** — `docs/reference-app-ns.md` (layout block, rewrite section, test table, bundle-smoke section) and `packages/reference-app-ns/README.md` (layout, test table) read and updated for the new file and guard; the "other Node variants bundled" list matches the fix-stage ticket's measurement.
- **Lint/gates** — `npx eslint` on the changed config files clean (`scripts/` is outside lint, already tracked by `debt-tooling-scripts-unlinted-and-unchecked`); `yarn dep-check` exit 0, the new file is not reported unused; `yarn workspace @serfab/reference-app-ns test:bundle` OK (0 errors, 0 warnings).

Found and fixed inline:

- **Unverified contract (the implementer flagged it)** — nothing failed if the rewrite silently stopped; a stopped rewrite compiles cleanly and only fails on a device (for crypto, peer-identity generation throws). Added the guard to `scripts/bundle-check.js` over every bundled file (concatenated modules included). Verified by temporarily disabling the rewrite: `test:bundle` failed listing the six Node files (five crypto, `main-event/events.js`); reverted. This is a scoped check of the listed packages, not the general "any Node variant bundled" check the fix ticket rejected.
- **DRY** — moving the helpers to `browser-map.js` lets the plugin and the guard share one lookup; the plugin body is now two lines and `webpack.config.js` no longer needs `fs`.
- **Orphaned comment (pre-existing, same file)** — the "Node built-in shims / stubs" comment sat above the libp2p user-agent plugin, separated from the `resolve.fallback` block it describes; moved it back above that block.

Tripwire:

- The map lookup is exact-key in `./dir/file.js` form, which both listed packages use; a future package whose keys omit `./` or the extension would silently not rewrite, and the guard (same lookup) would not catch it. Parked as a `NOTE:` in `browserVariantOf` in `browser-map.js`.

Not done / no ticket:

- No on-device run; the CPU saving (~2% of a join, per the reporter) was not re-measured — the claim rests on the bundled-module listing.
- The nested optimystic copy of `main-event` is not in the current graph, so the rewrite's per-copy behaviour there is untested; the guard would flag it if that copy entered the bundle unrewritten.
- Tests: no unit test added. The guard runs inside the existing `test:bundle` gate, which is where the contract is observable; a unit test of `owningPackage` would restate its string slicing.
