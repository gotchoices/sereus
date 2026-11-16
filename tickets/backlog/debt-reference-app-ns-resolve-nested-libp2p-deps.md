description: The NativeScript app's bundler picks the wrong copy of two networking libraries, so the build has to be told to ignore 22 "missing export" complaints; find a way to make it pick the right copies instead.
files: packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/scripts/bundle-check.js, docs/platforms/nativescript.md
difficulty: hard
----

## Background

`packages/reference-app-ns` bundles the peer-to-peer networking stack (libp2p, via
`@optimystic/db-p2p`) with webpack. Two of those libraries are installed more than
once at different versions, and the bundler picks the wrong copy for 22 imports —
each one reported as `export 'X' was not found in 'Y'`, a hard build error.

Today the build config works around this: it downgrades missing-export errors to
warnings (`exportsPresence: 'warn'`) and silences exactly those 22 messages with a
list of text patterns. The build is green (0 errors, 0 warnings), and the code
paths involved are never executed at runtime on this app's transport setup — so
this is correctness-of-build-config debt, not a user-visible bug.

The workaround was expected to be temporary, pending an upstream dependency
alignment in the `optimystic` repo. That alignment **landed** and did not help.
Investigation (ticket `reference-app-ns-drop-exportspresence-override`, now in
`tickets/complete/`) established two independent causes, both structural:

1. **The bundler ignores nesting.** `@nativescript/webpack`'s base config prepends
   this app's own **absolute** `node_modules` path to webpack's module search list
   (`config.resolve.modules`), applied to every import regardless of which file is
   importing. So an import inside
   `../optimystic/packages/db-p2p/node_modules/@libp2p/autonat` resolves
   `protons-runtime` to the app's hoisted `5.6.0` rather than the correct nested
   `6.0.2` sitting right beside it. Verified with `enhanced-resolve` (webpack's own
   resolver): normal resolution *would* find `6.0.2`; the forced absolute search
   root overrides it. This is `@nativescript/webpack`'s deliberate design, not a
   bug this repo can silently patch — changing it globally risks mis-resolving
   other packages.

2. **A genuine upstream major-version mismatch.** `@chainsafe/libp2p-gossipsub`
   declares `@libp2p/interface@^2`; the rest of the stack is on `^3`. Confirmed
   as of 2026-07: `14.1.2` is the **latest published** gossipsub release and it
   still requires `^2`. There is no `^3`-compatible version to upgrade to. Its own
   nested `@libp2p/interface@2.11.0` copy does export the missing
   `StrictSign` / `StrictNoSign` / `TopicValidatorResult` — cause (1) is what
   prevents the bundler from using it.

## Goal

Make the bundler resolve these two packages to the copies that actually satisfy
the importers, and then delete the `exportsPresence: 'warn'` override and its
`ignoreWarnings` allowlist — restoring strict missing-export detection across the
whole NativeScript bundle.

## Expected behaviour

- `yarn test:bundle` (from `packages/reference-app-ns`) passes with 0 errors and 0
  warnings **without** `exportsPresence: 'warn'` and without any missing-export
  allowlist.
- No other package's resolution changes. Whatever mechanism is used must be scoped
  to the specific importers/specifiers involved, not a global resolution override.
- The app still runs on device (the affected code paths are dormant on the current
  transport setup, but the fix must not perturb the ones that aren't).

## Notes for whoever picks this up

- A likely shape is a scoped `NormalModuleReplacementPlugin` / alias rule keyed on
  the importing file's directory — the same pattern this config already uses for
  `@libp2p/crypto`, `libp2p`'s `user-agent.js`, and `@chainsafe/libp2p-noise`'s
  crypto module. Redirect the bare `protons-runtime` / `@libp2p/interface`
  specifiers to their real nested paths when the importer lives under
  `optimystic/packages/db-p2p/node_modules`.
- Alternative worth weighing: undo the `resolve.modules` absolute-path entry that
  `@nativescript/webpack` prepends, and see what breaks. Higher blast radius, but
  fixes the class of problem rather than two instances.
- Bundling two majors of `@libp2p/interface` into one app is a real cost (bundle
  size, and two distinct copies of any module-level state). Confirm that's
  acceptable, or decide gossipsub should be dropped/replaced instead.
- Watch for a future gossipsub major that moves to `@libp2p/interface@^3` — that
  would eliminate cause (2) outright and shrink this ticket to cause (1) alone.
- `scripts/bundle-check.js` now fails on any warning, so a partial fix cannot
  regress silently.

## Status at triage (2026-09-28, after 1.7.0)

Partly done: gossipsub is gone (optimystic c497dff1), so two webpack ignore patterns are stale. Only the protons 5.6 vs 6.0.2 split remains.

## Premise check

Made while the documentation was rewritten against the code. The installed trees and lock files were read; the bundle was not built, so nothing here says the override can be deleted, only that the two causes this ticket names are no longer in the tree.

- **Cause 2 (gossipsub) is gone from every tree.** No `@chainsafe/libp2p-gossipsub` directory exists under `node_modules` at the root of this repo, of `../optimystic` or of `../Fret`, or under any of their packages' `node_modules`, and none of the three `yarn.lock` files mentions it. This agrees with the triage note above.
- **Cause 1 as described (hoisted `protons-runtime` 5.6.0 against a nested 6.0.2) is gone too.** `packages/reference-app-ns/node_modules/protons-runtime` is 7.1.2, and so is `../optimystic/packages/db-p2p/node_modules/protons-runtime`, which sits beside `@libp2p/autonat` 3.0.28. Version 7.1.2 exports `streamMessage` (`dist/src/index.d.ts`), the name the autonat pattern in the allowlist is for. So the forced search root now leads autonat to a copy that has the export. The triage note's "only the protons 5.6 vs 6.0.2 split remains" no longer matches the tree.
- **The workaround is still in place.** `packages/reference-app-ns/webpack.config.js` still sets `exportsPresence: 'warn'` and still carries the `SKEW_WARNINGS` list with its gossipsub and autonat patterns, and its comments and `docs/platforms/nativescript.md` ("`exportsPresence: 'warn'`") still describe the skew.
- **One 5.6.0 copy remains, in a different place.** `node_modules/@chainsafe/libp2p-noise/node_modules/protons-runtime` at the repo root is 5.6.0. Not checked: whether the bundler's forced search root sends noise's own `protons-runtime` imports to the app's 7.1.2 instead, and whether that matters.

What this leaves: remove the `exportsPresence` block and the allowlist, run `yarn test:bundle` in `packages/reference-app-ns` (it fails on any warning), and see whether anything is reported. If it is clean, the ticket is that deletion plus the comment and doc edits, and the "hard" rating and the scoped-resolver design no longer apply. If something new is reported, the ticket should be rewritten around what the run shows.
