description: Cleaned up leftover bundler workarounds in the example phone and desktop apps that only existed because push-notification code used to be bundled with them, and proved a phone release build still assembles cleanly.
prereq: push-notifier-node-subpath
files: packages/reference-app-rn/metro.config.js, packages/reference-app-rn/README.md, packages/reference-app-ns/webpack.config.js, packages/reference-app-web/vite.config.ts, packages/reference-app-web/README.md
----

# Review: drop consumer-app bundler shims obsoleted by `push-node` subpath isolation

## What this was

`push-notifier-node-subpath` (now complete) moved cadre-core's FCM/APNs push
senders — the only cross-platform code importing `node:crypto` / `node:http2` —
behind the Node-only `@serfab/cadre-core/push-node` subpath. That left dead
bundler workarounds in the three reference apps. This ticket removed the ones that
were only there for push, kept the ones other (libp2p) dependencies still need,
and used a real phone release bundle as the regression proof that the upstream
fix holds — the exact failure the external feedback hit was Metro
`Unable to resolve module node:crypto`.

**Most of the diff is already committed** (runner commit `7a35ef2`, landed with the
resume-note when the prior agent run died mid-lint on an API connection error).
Only the two `reference-app-web` files are uncommitted in the working tree at
handoff. Everything was re-validated green on the combined tree (see Validation).

## What changed, per app

### reference-app-rn (`metro.config.js`, `README.md`)

- **Removed** the `node:http2` / `http2` empty-stub aliases. Static analysis
  confirmed the *only* importer of `(node:)http2` in the resolvable graph is
  `cadre-core/dist/push-notifier-apns.js`, which lives behind the `push-node`
  subpath and is unreachable from the cross-platform entry. Comment describing
  them as an APNs belt-and-suspenders deleted.
- **Kept** `node:crypto` / `crypto` → `polyfills/node-crypto.js`. These are still
  demanded by push-unrelated transitive deps: `multiformats` sha2/sha1 Node
  variant (`import crypto from 'crypto'` → `createHash`), `@chainsafe/libp2p-noise`
  crypto/index (`node:crypto`), and `@libp2p/crypto`'s Node key modules *before*
  the in-config `browser`-field rewrite redirects them to noble variants. Comment
  rewritten to name those real survivors and note push no longer reaches the shim.
  README polyfill-inventory row for `node-crypto.js` updated to match.
- **Added `fretRoot` to `watchFolders` + `nodeModulesPaths`** — see *Scope
  expansion* below. This is the one change beyond the ticket's literal scope and
  the thing to scrutinize hardest.

### reference-app-ns (`webpack.config.js`)

- **Removed** the dead `/export 'sign' .*was not found in 'node:crypto'/`
  suppression from `SKEW_WARNINGS` and its comment clause. That warning came from
  the FCM notifier's namespace import, now gone with push isolation. Bundle-check
  confirms removing it surfaces **no** new warning (0 warnings total).
- **Kept** everything else, incl. the `node:crypto` shim (serves libp2p-noise
  crypto) and the `@libp2p/crypto` Node→browser rewrite.

### reference-app-web (`vite.config.ts`, `README.md`)

- The comment + README were **already push-agnostic** (they state `node:crypto` is
  deliberately unaliased so any browser reach for it surfaces as a real bug —
  never referenced push). Nothing push-specific to strip. Added an affirming
  clause to both noting cadre-core's push senders now live behind `push-node`, so
  a production `vite build` externalizes **no** `node:crypto` from cadre-core —
  verified. Comment/doc only; no runtime change.

## Scope expansion — READ THIS (reviewer decision point)

The RN release bundle was **already broken before this ticket**, independent of
push: `Unable to resolve module p2p-fret`. Cause: `p2p-fret` (the FRET DHT) is
portaled by `optimystic/db-p2p` from a **third** sibling monorepo
`C:\projects\Fret\packages\fret` (via optimystic's `portal:` resolution). Metro's
`watchFolders` / `nodeModulesPaths` listed only sereus / optimystic / quereus —
never Fret — so Metro refused the symlink target. This has been latent since
`db-p2p` adopted `p2p-fret` (optimystic commit for `arachnode-ring-handoff`,
2026-07-08); no RN release bundle could complete since.

Because a clean release bundle **is this ticket's core deliverable / regression
proof**, I added `fretRoot` alongside the existing optimystic/quereus roots rather
than defer. It is convention-consistent and EAS-safe: `eas-build-pre-install.sh`
strips `portal:` resolutions so EAS resolves `p2p-fret` from npm, exactly like the
other siblings — the sibling root only matters for *local* bundling and is
harmless when `../Fret` is absent. Explanatory comment added at the code site
(`metro.config.js:10-16`).

**Reviewer**: this is a scope expansion born of a pre-existing latent break. If you
disagree with folding it in here, the alternative is a standalone
`fix/`-style ticket — but note the ticket cannot demonstrate its own acceptance
criterion without it. It is minimal and mirrors existing structure.

## Validation (the floor — treat as a starting point, not proof of correctness)

All re-run green on the committed + uncommitted tree at handoff:

- **RN release bundle** (the headline proof): `npx expo export --platform android
  --clear` → `Bundled ... (4655 modules)`, `Exported: dist`, exit 0. Full log has
  **0** `unable to resolve` / `error:` lines and **0** `node:http2` mentions. The
  removed http2 shims are absent and nothing broke — regression proven.
- **NS**: `node scripts/bundle-check.js` (headless webpack compile of the whole
  cadre/db-p2p/Quereus/Optimystic graph) → `0 errors (0 warnings)`, exit 0.
- **Web**: `npx vite build` → `built in 14.37s`, exit 0, no `node:crypto`
  externalization warning from cadre-core.
- **Lint**: root `yarn lint` → exit 0.

## Known gaps / things NOT proven (be adversarial here)

- **No native builds.** `ns prepare android` (gradle + Android SDK) and an actual
  `expo run:android` / EAS device build are out-of-band — not runnable in the
  agent env. What's proven is *module resolution + JS bundling*, not native
  compile or on-device runtime. A reviewer wanting full assurance should run a
  real device/EAS build.
- **Bundle success ≠ runtime correctness.** The bundle resolving `node:crypto`
  through the kept shim proves it *resolves*, not that the createHash-only shim
  satisfies every runtime call site. That was true before this ticket too; this
  ticket only removed the http2 stubs, but worth stating.
- **Pre-existing noise, not addressed (correctly):** Metro `Falling back to
  file-based resolution` WARNs (`@noble/hashes/sha2`, `multiformats` sha2-browser,
  `event-target-shim`) and Vite dynamic/static-import-mixing + chunk-size warnings
  are unrelated to this diff and left alone.
- **Uncommitted at handoff:** the two `reference-app-web` files. Runner commits.

## Review findings

- **Scope expansion — Fret watchFolder/nodeModulesPaths.** Added `../Fret` to
  RN Metro roots to fix a pre-existing `Unable to resolve module p2p-fret` that
  otherwise blocks this ticket's own regression proof. Rationale + EAS-safety in
  *Scope expansion* above; decide whether it belongs here or in its own ticket.
- **Tripwire — sibling-workspace Metro roots** (parked as a code comment at
  `metro.config.js:10-16`, not a ticket): the RN local bundle now depends on three
  sibling monorepos (optimystic, quereus, Fret) being present and portaled. If a
  *fourth* portaled sibling is ever added to the graph, the same
  `Unable to resolve module <x>` recurs until its root is added here. Fine now;
  conditional on future portal additions.
- **Web wording** was already push-agnostic; the edit is an affirming clarification
  only, not a removal — flag if you'd rather it stay untouched.
