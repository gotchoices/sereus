----
description: After the push code is isolated server-side, our example phone and desktop apps still carry build-config workarounds for it; remove the now-unneeded ones and prove a React Native release bundle builds clean.
prereq: push-notifier-node-subpath
files: packages/reference-app-rn/metro.config.js, packages/reference-app-rn/README.md, packages/reference-app-ns/webpack.config.js, packages/reference-app-web/vite.config.ts, packages/reference-app-web/README.md
----

# Drop consumer-app bundler shims made obsolete by the `push-node` subpath isolation

## Context

`push-notifier-node-subpath` removes `node:crypto` / `node:http2` from
`@serfab/cadre-core`'s cross-platform module graph. Our reference apps carry
bundler workarounds that existed only (or partly) because of those imports. This
ticket removes what is now dead, keeps what other dependencies still genuinely
need, and uses the cleanup as the regression proof that the upstream fix works —
the exact failure mode the external feedback report hit (Metro release bundle
`Unable to resolve module node:crypto`).

**Important**: not every shim can go. `reference-app-rn` also shims
`node:os/net/tls/stream/buffer` and bare `crypto` for *transitive libp2p*
dependencies unrelated to push. Investigate each candidate before removal — the
deliverable is the minimal shim set, with comments saying why each survivor stays.

## Scope per app

### reference-app-rn (`metro.config.js:33-57`, README ~line 327)

- `node:http2` / `http2` empty stubs existed **only** for the APNs notifier (the
  config comment at line 37 says so). Remove both entries and the comment.
- `node:crypto` / `crypto` → `polyfills/node-crypto.js`: the `node:crypto` edge
  from cadre-core is gone, but bare `crypto` may still be imported by transitive
  npm deps. Determine what actually still resolves through the shim (remove,
  bundle, read the error; or grep `node_modules` imports). Remove whichever alias
  entries are no longer demanded; if the shim survives for other consumers, trim
  its comment to name the real remaining consumers.
- Update the README's polyfill/shim section to match the final state.
- **Verification (the regression proof)**: run a release-mode Metro bundle so
  resolution of the full graph is exercised without a native toolchain — e.g.
  `npx expo export --platform android` (or `react-native bundle --dev false`).
  Must succeed with the removed shims absent. Stream output (`| tee`) per runner
  rules; if it cannot finish inside the 10-minute idle window, document and defer
  the run to a human — do not leave it silently unverified.

### reference-app-ns (`webpack.config.js:162, 285`)

- Line 285 suppresses `/export 'sign' .*was not found in 'node:crypto'/` — that
  warning came from the FCM notifier's namespace import; the suppression is now
  dead. Remove it and any comment text (line ~162 region) describing push-notifier
  crypto reach.
- Only prune what is push-related; the NS `node:crypto` shim serves libp2p noise
  crypto too (`src/shims/noise-crypto.js`) and stays.
- Verify with the app's webpack build/typecheck if it fits the idle window;
  otherwise document deferral.

### reference-app-web (`vite.config.ts:14`, README ~line 196)

- Comment and README describe the "unaliased `node:crypto` only warns" defense
  around push code. With the imports gone from the graph, the Vite build should
  emit **no** `node:crypto` externalization warning from cadre-core — verify with
  a `vite build`, then update comment + README wording.

## Edge cases & interactions

- Removing an alias that a transitive dep still needs fails the bundle — that is
  the desired signal; restore that alias with an accurate comment rather than
  papering over.
- Metro caches aggressively: run bundles with `--clear` / fresh cache so a stale
  resolution doesn't mask a missing-module failure (false green).
- `expo export` may try network fetches (fonts/assets); if the environment is
  offline, fall back to `react-native bundle --dev false` which is purely local.
- Do not touch shims for `node:os`, `node:net`, `node:tls`, `node:stream`,
  `node:buffer`, or the `@libp2p/crypto` browser rewrites — out of scope, still
  required by libp2p transitive deps.

## TODO

- [ ] RN: remove `node:http2`/`http2` stubs; investigate + minimize `node:crypto`/`crypto` aliases; fix comments + README
- [ ] RN: release-mode bundle (`expo export` or `react-native bundle --dev false`, fresh cache, streamed) succeeds
- [ ] NS: remove dead `node:crypto` sign-warning suppression + stale comments; keep noise-crypto shim
- [ ] Web: `vite build` shows no cadre-core `node:crypto` warning; update vite.config comment + README
- [ ] Lint green; note any deferred heavy builds honestly in the review handoff
