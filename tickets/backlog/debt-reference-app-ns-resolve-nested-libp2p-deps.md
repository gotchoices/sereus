description: The NativeScript app's bundler picks the wrong copy of two networking libraries, so the build has to be told to ignore 22 "missing export" complaints; find a way to make it pick the right copies instead.
files: packages/reference-app-ns/webpack.config.js, packages/reference-app-ns/scripts/bundle-check.js, docs/reference-app-ns.md
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
