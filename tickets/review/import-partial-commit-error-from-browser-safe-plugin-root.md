description: The control-write retry code now imports the database plugin's partial-commit error type directly and checks it by class, because the plugin's main entry no longer loads Node-only file-system modules. The name-matching workaround and the lint rule that forbade the import are gone.
files:
  - packages/cadre-core/src/control-write-retry.ts (`reportsPossiblyStoredWrite`, ~line 283, and its doc comment)
  - packages/cadre-core/test/control-write-retry.spec.ts (unchanged; already builds the real `PartialCommitError`)
  - eslint.config.mjs (removed the `no-restricted-imports` block for `@optimystic/quereus-plugin-optimystic`)
  - docs/testing.md ("Lint coverage": removed that rule's entry)
----

# Import `PartialCommitError` from the plugin root

## What changed

- `control-write-retry.ts` imports `PartialCommitError` from `@optimystic/quereus-plugin-optimystic` (the root entry). `reportsPossiblyStoredWrite` now checks it with `instanceof` like the other three typed vetoes. `LEGACY_PARTIAL_COMMIT_ERROR_NAME` and its comment are deleted. The veto's doc comment now says a second loaded copy of the plugin fails `instanceof` the same way a second copy of `@optimystic/db-core` does, and the classifier then falls back to text matching.
- `eslint.config.mjs`: removed the block that barred `packages/cadre-core/src/**` from importing the plugin root.
- `docs/testing.md` → "Lint coverage": removed that rule's bullet.
- The spec needed no change. It already constructs the real `PartialCommitError` (lines ~606–628) in both partial-commit cases.
- No sereus doc describes the old "Unknown engine" refusal (grepped `docs/` and package sources for `Unknown engine`, `QUEREUS_ENGINE_ID`, `engine id`), so nothing needed updating for the upstream change that the engine id now names the Quereus version the plugin was built against.
- The other plugin imports (`control-database.ts`, `quereus-plugin-sereus/src/compose-strand.ts`) use the `/plugin` subpath's default export, the plugin function. They were left as they are. Nothing requires moving them, and the subpath still exists upstream.

## Upstream precondition

`../optimystic` HEAD is `9bb860e6`, which includes `f6913258`. The plugin `dist/` was built at 22:01 on 2026-09-17. `dist/index.js` and its chunk contain no `node:` imports, `import.meta`, or `fs`/`path`/`url` imports. Nothing was built in `../optimystic`.

## Validation run (all passed)

- `yarn workspace @serfab/cadre-core typecheck`
- `yarn workspace @serfab/cadre-core build`: rebuilt `dist`, which the web and RN apps bundle. `dist/control-write-retry.js` imports the plugin root.
- `npx vitest run test/control-write-retry.spec.ts` in cadre-core: 55/55.
- `yarn lint` (repo root): clean.
- `npx vite build` in `reference-app-web`: built successfully. The log has no `externalized`/`fs`/`url`/`path` warnings, and it shows `quereus-plugin-optimystic/dist/index.js` in the graph, so the root entry was actually bundled. The remaining warnings (dynamic-vs-static import, chunk size) were there before this change.
- React Native Metro bundle: `npx expo export --platform android --output-dir dist-bundle-check` in `reference-app-rn` bundled 4703 modules to Hermes bytecode with no errors. The only warnings are the existing `multiformats` "not listed in exports" fallbacks. I didn't use `yarn test:bundle` because it ends in `rm -rf dist`, and an existing ignored `dist/` was already there. The throwaway output folder was deleted afterwards.

## Not run / gaps

- I didn't run the full cadre-core vitest suite, only the one spec for the changed module. The change is one import plus one predicate that changed from a `name` comparison to `instanceof`.
- `instanceof` is stricter than the old name match. If a second physical copy of `@optimystic/quereus-plugin-optimystic` is ever loaded (for example, a duplicate install instead of the `resolutions` link), a `PartialCommitError` from that copy no longer triggers the type veto. The classifier falls back to text matching, the same trade the three `db-core` types already make, and the doc comment says so. Reviewer: decide whether that is acceptable or whether this one type should keep a name fallback. I judged it acceptable to match the existing three.
- Nothing now stops a future change from importing a genuinely Node-only module into cadre-core's main graph except the `vite build` of `reference-app-web` and the RN export. Neither runs in `yarn lint` or cadre-core's tests. That was already true for every import other than this one entry.
