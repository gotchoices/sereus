description: The database plugin's main entry used to load Node-only file-system modules, so the retry code identified one of its error types by name and a lint rule forbade importing that entry. Upstream has now made the entry safe for browser and phone builds, so import the error type directly and remove the workaround.
files:
  - packages/cadre-core/src/control-write-retry.ts (`LEGACY_PARTIAL_COMMIT_ERROR_NAME`, the `link.name ===` match ~line 288, and the comments at ~268–297)
  - packages/cadre-core/test/control-write-retry.spec.ts
  - eslint.config.mjs (`no-restricted-imports` on `@optimystic/quereus-plugin-optimystic`, ~line 165)
  - docs/testing.md (~line 274, Lint coverage entry for that rule)
----

# Import `PartialCommitError` from the plugin root; drop the name match and the lint rule

## Background

Optimystic made the plugin root entry browser- and React-Native-safe: fix `22163135`, implement `9dc9de24`, review `2e10b587`, plugin dist rebuilt at `f6913258`. `QUEREUS_ENGINE_ID` no longer reads `@quereus/quereus`'s `package.json` at load. A build step writes the version into a committed `src/transaction/quereus-version.ts`, so `node:fs`, `node:url`, `node:path` and `import.meta` are gone from the graph. Upstream now has a browser-bundle spec (esbuild, both entries) and `yarn check:rn` (Metro plus Hermes, both entries) that guard this. No `/errors` subpath was added, since it wasn't needed.

Semantic note for the docs: the engine id now names the Quereus the plugin was **built** against, not the installed one. A node whose installed Quereus behaves differently is still refused, but at the operation-hash comparison rather than as "Unknown engine" (optimystic `docs/correctness.md`, Theorem 4 step 1). Check whether any sereus doc describes the old "Unknown engine" behaviour.

## TODO

1. Check that `../optimystic` HEAD is at or after `f6913258` with the plugin dist built. Don't build there.
2. **Confirm first:** run a browser build that imports the root entry. For example, temporarily import `PartialCommitError` from the root into cadre-core and run `vite build` of `reference-app-web`. It should succeed with no `fs`/`url`/`path` externalization warnings. If it fails, stop and report upstream instead of continuing.
3. In `control-write-retry.ts`, import `PartialCommitError` from `@optimystic/quereus-plugin-optimystic` and match it with `instanceof`. Remove `LEGACY_PARTIAL_COMMIT_ERROR_NAME` and update the comments.
4. Remove the `no-restricted-imports` rule from `eslint.config.mjs` and its entry in `docs/testing.md` → "Lint coverage".
5. Update `control-write-retry.spec.ts` if it constructs a name-only stand-in. It should use the real class.
6. Validate: cadre-core typecheck, `control-write-retry.spec.ts`, `yarn lint`, `vite build` of `reference-app-web`, and the RN Metro bundle check if one exists in `reference-app-rn` tests.
