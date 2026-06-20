description: Once the optimystic dependency-version fix lands, remove the temporary webpack relaxation in the NativeScript reference app that hides "export not found" warnings, and confirm the bundle builds clean.
files: packages/reference-app-ns/webpack.config.js
difficulty: easy
----

## Background

The NativeScript reference app (`@serfab/reference-app-ns`, webpack 5) currently sets
`module.parser.javascript.exportsPresence = 'warn'` in `webpack.config.js` to downgrade
22 "export not found" errors to warnings. Those missing exports come from a nested-libp2p
version skew inside `@optimystic/db-p2p` (`StrictSign`/`StrictNoSign`/`TopicValidatorResult`
← `@libp2p/interface`, `streamMessage` ← `protons-runtime`).

The root-cause fix lives in optimystic and is tracked there as
`optimystic-db-p2p-libp2p-dep-skew` (now in `../optimystic/tickets/`). Sereus consumes it via
root `resolutions`.

## Follow-up (this repo)

Once the optimystic dep-skew fix has landed and is picked up via `resolutions`:

- Remove the `exportsPresence:'warn'` override from `packages/reference-app-ns/webpack.config.js`
  so the build re-enables strict missing-export detection.
- Verify `test:bundle` stays at **0 errors and 0 warnings** (or only intentional ones).

## Notes

- Future concern gated on the upstream optimystic fix — promote out of `backlog/` only after
  that fix lands. Cross-repo, so there is no enforceable `prereq:` here.
