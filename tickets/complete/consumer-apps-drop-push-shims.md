description: Cleaned up leftover bundler workarounds in the example phone and desktop apps that only existed because push-notification code used to be bundled with them, and proved a phone release build still assembles cleanly.
prereq: push-notifier-node-subpath
files: packages/reference-app-rn/metro.config.js, packages/reference-app-rn/README.md, packages/reference-app-ns/webpack.config.js, packages/reference-app-web/vite.config.ts, packages/reference-app-web/README.md, docs/reference-app-rn.md
----

# Complete: drop consumer-app bundler shims obsoleted by `push-node` subpath isolation

## What shipped

`push-notifier-node-subpath` moved cadre-core's FCM/APNs push senders — the only
cross-platform code importing `node:crypto` / `node:http2` — behind the Node-only
`@serfab/cadre-core/push-node` subpath. This ticket removed the reference-app
bundler workarounds that existed *only* for push, kept the ones libp2p transitive
deps still need, and re-proved a clean release/headless bundle across all three
apps.

- **reference-app-rn** (`metro.config.js`, `README.md`): removed dead
  `node:http2` / `http2` empty-stub aliases; kept `node:crypto` / `crypto` →
  `polyfills/node-crypto.js` (still demanded by multiformats sha2/sha1 Node
  variant, `@chainsafe/libp2p-noise` crypto/index, and `@libp2p/crypto` Node key
  modules before the browser rewrite). Also added the `../Fret` sibling root to
  `watchFolders` + `nodeModulesPaths` — see *Scope expansion*.
- **reference-app-ns** (`webpack.config.js`): removed the dead
  `/export 'sign' .*was not found in 'node:crypto'/` skew-warning suppression
  (that warning came from the FCM notifier's namespace import, now gone). Kept the
  `node:crypto` shim (serves libp2p-noise) and the `@libp2p/crypto` browser
  rewrite.
- **reference-app-web** (`vite.config.ts`, `README.md`): comment/README were
  already push-agnostic; added an affirming clause that cadre-core push senders
  now live behind `push-node`, so `vite build` externalizes no `node:crypto` from
  cadre-core. Doc/comment only.

## Scope expansion (accepted)

The RN release bundle was **already broken before this ticket**, independent of
push: `Unable to resolve module p2p-fret`. `p2p-fret` (FRET DHT) is portaled by
`@optimystic/db-p2p` from the sibling `../Fret` monorepo; Metro's roots listed only
sereus/optimystic/quereus, so Metro refused the symlink target. Because a clean
release bundle **is this ticket's regression proof**, the implementer folded the
`fretRoot` addition in rather than defer — it is minimal, mirrors the existing
optimystic/quereus roots, and is EAS-safe (`eas-build-pre-install.sh` strips
`portal:` resolutions, so p2p-fret resolves from npm on EAS and the sibling root
only matters for local bundling). Accepted as-is; not split to a separate ticket
because the ticket cannot demonstrate its own acceptance criterion without it.

## Review findings

**Scope reviewed:** the full implement diff (RN/NS changes landed in runner commit
`7a35ef2`; web files in `3cd87ee`) read fresh before the handoff summary. Angles:
correctness of each removal (static graph reachability), DRY/consistency of the
Metro root additions, doc accuracy across every touched *and* should-have-touched
file, and re-running the three bundle validations + lint.

- **`node:http2` removal — CONFIRMED safe (correctness).** Verified statically:
  the only importer of `(node:)http2` in cadre-core is `push-notifier-apns.ts`,
  reachable only via the `push-node` subpath entry. The cross-platform `index.ts`
  re-exports `CadreNode` from `cadre-node.ts`, which imports only
  `push-fanout.ts`; `push-fanout` pulls no APNs/FCM/http2 edge (references the
  `PushNotifier` interface only). So http2 is genuinely absent from the RN/web
  graph. The re-run RN bundle confirms: 0 `node:http2` mentions, 0
  unable-to-resolve.

- **Stale docs — FIXED inline (minor).** The implementer updated the RN app
  `README.md` but not `docs/reference-app-rn.md`, which mirrors the metro config.
  Two spots were left misrepresenting the new reality: (1) the illustrative
  `watchFolders`/`nodeModulesPaths` snippet still showed the 3-root list without
  `fretRoot`; (2) the `node:crypto` consumer table row named only
  `multiformats/hashes/sha2`. Both updated to match the code + app README.

- **Tripwire miscited — FIXED inline (minor).** The handoff's findings claimed a
  tripwire was "parked as a code comment at `metro.config.js:10-16`", but that
  comment only explained the Fret mechanism — no greppable `NOTE:` tag and no
  statement of the conditional. Added the `NOTE:` line at the site: local bundling
  now depends on three portaled siblings (optimystic, quereus, Fret); a fourth
  portaled sibling would recur the same `Unable to resolve module <x>` until its
  root is added. This is the real tripwire home; the bullet below is the index.

- **Tripwire (parked, not a ticket) — sibling-workspace Metro roots.** Fine now;
  conditional on a future *fourth* portaled sibling being added to the graph.
  Recorded as the `NOTE:` at `metro.config.js` (near the `fretRoot` decl).

- **Known gap, not a defect — Fret-absent path unverified here.** The claim that
  the `fretRoot` entry is "harmless when `../Fret` is absent" (the EAS case) could
  not be exercised in this env because the sibling is present. It mirrors the
  pre-existing optimystic/quereus roots, which are added the same unconditional
  way and are known to work on EAS — so this rests on established precedent, not a
  fresh test. Flagged, not filed.

- **No major findings → no new tickets filed.** No latent defects, no new
  bug/debt/feat work surfaced by the diff. No conditional concern beyond the one
  tripwire above.

## Validation (re-run green this pass)

- **Lint:** `yarn lint` → exit 0. Targeted `npx eslint metro.config.js` after the
  `NOTE:` edit → exit 0.
- **RN release bundle:** `npx expo export --platform android --clear` →
  `Android Bundled … index.js (4655 modules)`, `Exported: dist`, exit 0. 0
  unable-to-resolve, 0 `error:`, 0 `node:http2`.
- **NS:** `node scripts/bundle-check.js` → `compiled successfully`, `0 errors
  (0 warnings)`, exit 0 — confirms removing the `sign` suppression surfaces no new
  warning.
- **Web:** `npx vite build` → `built in 24.62s`, exit 0, no `node:crypto`
  externalization warning from cadre-core.

## Not proven (out of agent env, unchanged from handoff)

- No native builds (`ns prepare android` gradle/SDK, `expo run:android`, EAS device
  build). Proven surface is module resolution + JS bundling, not native compile or
  on-device runtime.
- Bundle resolving `node:crypto` through the kept shim proves resolution, not that
  the createHash-only shim satisfies every runtime call site (true before this
  ticket too; this ticket only removed the http2 stubs).
- No pre-existing test failures surfaced by the commands run this pass; no
  `.pre-existing-error.md` written.
