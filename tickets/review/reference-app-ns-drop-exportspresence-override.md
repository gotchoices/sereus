description: Investigated removing a temporary build-warning suppression in the NativeScript reference app; found the underlying problem is not actually fixed yet, so no code change was made — recorded why and what real fix would take.
files: packages/reference-app-ns/webpack.config.js
difficulty: easy
----

## What this ticket asked

Once the upstream `optimystic-db-p2p-libp2p-dep-skew` fix landed, remove the
`exportsPresence: 'warn'` override (+ its paired `ignoreWarnings` suppression list)
from `packages/reference-app-ns/webpack.config.js`, and confirm `test:bundle` stays
at 0 errors / 0 warnings.

## What I found

The upstream ticket **did** land (`../optimystic` commit `e632b54`, `tickets/complete/
optimystic-db-p2p-libp2p-dep-skew.md`), and sereus already resolves it via the
existing `link:../optimystic/packages/db-p2p` root resolution — no lockfile/install
step needed, the linked package.json is live.

But removing the override and re-running `yarn test:bundle` (from
`packages/reference-app-ns`) reproduces the **exact same 22 errors** the override
was written to suppress:

```
export 'StrictNoSign' was not found in '@libp2p/interface' (...)
export 'streamMessage' was not found in 'protons-runtime' (...)
```

I put the override back (file now matches HEAD, `git diff` clean) and confirmed
`test:bundle` is back to 0 errors / 0 warnings.

### Root cause (not what the ticket assumed)

The upstream fix only changed what `@optimystic/db-p2p` and its *own* nested
`node_modules` resolve to (confirmed: `node_modules/@optimystic/db-p2p/node_modules/
protons-runtime` is `6.0.2`, which does export `streamMessage`; `@chainsafe/libp2p-
gossipsub`'s own nested `@libp2p/interface` is `2.11.0`, which does export
`StrictSign`/`StrictNoSign`/`TopicValidatorResult`). Normal Node/webpack module
resolution would find those nested, correctly-versioned copies.

The actual break is in `@nativescript/webpack`'s base config
(`node_modules/@nativescript/webpack/dist/configuration/base.js`, the
`config.resolve.modules` call): it prepends reference-app-ns's own **absolute**
`node_modules` path to the module search list for *every* resolve, regardless of
which file is doing the importing. I verified this directly with `enhanced-resolve`
(webpack's own resolver) — resolving `protons-runtime` from `@libp2p/autonat`'s real
on-disk location (inside `../optimystic/packages/db-p2p/node_modules/...`) correctly
finds the `6.0.2` copy in isolation, but the actual webpack build instead resolves to
`packages/reference-app-ns/node_modules/protons-runtime` (`5.6.0`, hoisted there by
yarn, no `streamMessage`) and `packages/reference-app-ns/node_modules/@libp2p/
interface` (`3.1.0`, no `StrictSign`/`StrictNoSign`/`TopicValidatorResult`) — because
that absolute path search root wins before webpack ever walks up from the real
nested location.

On top of that, `@chainsafe/libp2p-gossipsub` (a dependency of `db-p2p`) itself still
declares `"@libp2p/interface": "^2.0.0"` — a different major than the `^3.x` the rest
of the stack uses. The upstream fix explicitly did not touch this (its own summary:
"`packages/db-p2p` itself stays at `^3.1.0`"; gossipsub's requirement wasn't in scope
at all). So even a fully-converged single-`protons-runtime` tree wouldn't clear the
`StrictSign`/`StrictNoSign`/`TopicValidatorResult` errors — those need either a
gossipsub major-version bump (does a `^3.x`-compatible gossipsub exist upstream?) or
a sereus-side webpack resolve workaround for this one package.

### Why the override must stay, for now

Both failure modes are structural (a general-purpose bundler quirk + a real upstream
major-version mismatch), not incidental version drift the `resolutions` link was ever
going to fix. Removing the override today reintroduces all 22 build errors.

## Suggested next step (for review to decide)

This looks like a `backlog/debt-` ticket for sereus (not a `fix/` in optimystic — the
gossipsub major-version mismatch is upstream's to decide whether/how to address, and
the `resolve.modules` behavior is `@nativescript/webpack`'s design, not a bug sereus
can silently patch without risk of resolving *other* packages incorrectly too).
Possible angles for whoever picks this up: (a) track whether `@chainsafe/libp2p-
gossipsub` ever ships a `@libp2p/interface@^3` compatible release upstream, or (b) a
scoped webpack `NormalModuleReplacementPlugin`/alias rule (same pattern already used
in this file for `@libp2p/crypto` and `user-agent.js`) that redirects these two
specific bare-specifier imports to their real nested paths when the importing file is
under `optimystic/packages/db-p2p/node_modules`, instead of relying on
`exportsPresence` + a warning-text regex allowlist.

## Validation

- `yarn test:bundle` (from `packages/reference-app-ns`) — 0 errors, 0 warnings, both
  before touching the file and after reverting my temporary edit.
- Confirmed via a standalone `enhanced-resolve` script (webpack's resolver, same
  `conditionNames` as `webpack.config.js`) that normal resolution *would* find the
  correct nested versions — isolating the cause to `@nativescript/webpack`'s forced
  `resolve.modules` absolute-path entry, not to anything in this repo's own config.
- `git diff packages/reference-app-ns/webpack.config.js` — empty; no functional
  change shipped by this ticket.

## Known gaps for reviewer

- I did not attempt the webpack-alias workaround myself — it's a real behavior
  change to a working build config and felt like it deserved its own scoped
  ticket + testing pass rather than a same-session addition to a ticket titled
  "drop the override."
- I did not check whether a newer `@chainsafe/libp2p-gossipsub` major release
  (compatible with `@libp2p/interface@^3`) exists upstream — that's a quick
  npm-registry check the next ticket should start with before reaching for the
  webpack-alias route.
