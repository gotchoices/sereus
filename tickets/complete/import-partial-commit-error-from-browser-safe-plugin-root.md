description: The control-write retry code now imports the database plugin's partial-commit error type directly and checks it by class, because the plugin's main entry no longer loads Node-only file-system modules. The name-matching workaround and the lint rule that forbade the import are gone.
files:
  - packages/cadre-core/src/control-write-retry.ts (`reportsPossiblyStoredWrite` and its doc comment)
  - packages/cadre-core/test/control-write-retry.spec.ts (unchanged; already builds the real `PartialCommitError`)
  - eslint.config.mjs (removed the `no-restricted-imports` block for `@optimystic/quereus-plugin-optimystic`)
  - docs/testing.md ("Lint coverage")
----

# Import `PartialCommitError` from the plugin root

## What changed

- `control-write-retry.ts` imports `PartialCommitError` from the root entry of `@optimystic/quereus-plugin-optimystic`, and `reportsPossiblyStoredWrite` checks it with `instanceof`, the same way it checks the three `@optimystic/db-core` error types. The `LEGACY_PARTIAL_COMMIT_ERROR_NAME` constant is deleted.
- `eslint.config.mjs`: the rule that stopped cadre-core from importing the plugin root is removed, along with its bullet in `docs/testing.md`.
- Upstream precondition: `../optimystic` at `9bb860e6` (includes `f6913258`); the plugin `dist/` root entry and its shared chunk import no Node built-ins and have no load-time side effects.

## Review findings

**Checked:** the implement diff (`aa3c3995`) read in full; the plugin's `package.json` `exports` and the built `dist/index.js`, `dist/plugin.js` and shared chunk (imports and top-level statements); every other import of the plugin in `packages/*/src`; docs that mention the classifier (`docs/architecture.md` line 98 describes the behaviour without the matching mechanism, so it needed no change); `knip.ts`; the spec's partial-commit cases (lines ~600–635 build the real class, both direct and rewrapped on `cause`); existing tickets for a platform-safety check (none).

**Validation (all passed):** `yarn lint`; `yarn workspace @serfab/cadre-core typecheck` and `build`; `control-write-retry.spec.ts` + `control-read-retry.spec.ts` 81/81; the full cadre-core suite 135 files, 2213 passed, 1 skipped (the implement pass ran only one spec); `yarn workspace @serfab/reference-app-ns test:bundle` compiled the whole import graph with 0 errors and 0 warnings (the NativeScript app also bundles cadre-core, and the implement pass had not checked it). The implement pass had already run the `reference-app-web` `vite build` and the React Native `expo export`.

**Correctness: no defects found.** The root entry is browser-safe: its only imports are `@noble/hashes`, `@optimystic/db-core`, `@optimystic/db-p2p` and the shared chunk, which are all already in cadre-core's graph. The `node:` strings in the chunk are object keys (`{ node: node2, … }`), not imports.

**Class identity across the two plugin entries (tripwire, parked as a `NOTE:` on `reportsPossiblyStoredWrite`).** cadre-core registers the plugin through `/plugin` but imports the error class from the root entry. They are the same class only because upstream's build emits both entries over one shared chunk (`dist/plugin.js` is a one-line re-export from `chunk-*.js`). If upstream ever bundles the entries separately, the `instanceof` stops matching and the spec still passes, because the spec builds the error from the same root import. The note says what to do if that happens.

**`instanceof` instead of the name match (implementer's open question): accepted.** A second physical copy of the plugin would make the veto fall back to text matching, the same trade the three db-core types already make. Only one copy is linked through the root `resolutions`, and the app bundlers resolve one copy. The doc comment already records this. I also re-wrapped two over-long lines in that comment.

**Platform-safety coverage (docs, fixed inline; tripwire).** The removed `docs/testing.md` bullet was the only place that said the app builds are the whole-graph check for cadre-core's browser and React Native safety. I added a "Lint coverage" bullet saying that cadre-core's `.` entry must stay free of Node built-ins, naming the three app bundle commands that check it, and noting that none of them runs under a root gate. Its `NOTE:` says that if this breaks again, the fix is a root-gate bundle check of the `.` entry, not another single-import lint rule. No ticket filed: the check exists (app bundle smokes), has caught the one instance so far, and adding a bundle step to `yarn test` has a cost that is not yet justified.

**Other categories:**
- DRY, modularity, source size: the change removes code (a constant and a lint block); nothing to consolidate.
- Resource cleanup and error handling: not applicable (one predicate change).
- Type safety: the change is an improvement, from a string compare to a typed class check.
- Tests: no new spec is needed. The existing cases already use the real class, and a name-only lookalike is now intentionally not vetoed by type.
