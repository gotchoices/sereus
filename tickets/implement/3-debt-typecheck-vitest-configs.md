description: Test-runner config files across the repo are not type-checked, so when the test runner drops or renames a setting the config keeps the dead setting and nothing complains — this already happened once and the broken setting went unnoticed for a whole major-version upgrade. This ticket closes the remaining six packages.
files: packages/cadre-cli/tsconfig.typecheck.json, packages/cadre-core/tsconfig.typecheck.json, packages/cadre-host/tsconfig.typecheck.json, packages/cadre-provider/tsconfig.typecheck.json (new), packages/cadre-provider/package.json, packages/quereus-plugin-sereus/tsconfig.typecheck.json, packages/strand-proto/tsconfig.typecheck.json (new), packages/strand-proto/package.json, docs/STATUS.md
difficulty: easy
---

# Type-check every package's vitest.config.ts (6 remaining packages)

## Background

`packages/integration-tests` was already fixed (see `debt-vitest4-pooloptions-migration`
review): its `tsconfig.typecheck.json` now has `rootDir: ".."/".."` (overriding the base
config's `rootDir: "src"`) and includes `vitest.config.ts` explicitly, so a Vitest option
that TypeScript no longer recognizes fails `yarn typecheck` instead of sitting silently
unused.

Investigation for this ticket (reading every package's `tsconfig.typecheck.json` /
`tsconfig.build.json` / `package.json` `typecheck` script and running
`tsc --listFiles`) found:

- **`reference-app-rn` is already covered.** Its `typecheck` script runs
  `tsc --noEmit -p tsconfig.json` directly (not `tsconfig.typecheck.json`), and that
  `tsconfig.json`'s `include: ["**/*.ts", "**/*.tsx"]` already matches
  `vitest.config.ts` at the package root — confirmed via
  `npx tsc --noEmit -p tsconfig.json --listFiles | grep vitest.config` from inside
  the package, which lists it. **No change needed for this package** — do not add a
  `tsconfig.typecheck.json` for it, that would be a redundant second program.
- The other **six** packages listed in `files:` above need a fix, and they split into
  two shapes:
  1. **Already have a `tsconfig.typecheck.json`** (`cadre-cli`, `cadre-core`,
     `quereus-plugin-sereus`) — just missing `vitest.config.ts` in `include`.
     `cadre-host` also has one, but additionally needs a `rootDir` override (like
     `integration-tests` needed) because its `tsconfig.typecheck.json` doesn't
     currently override the base config's `rootDir: "src"`.
  2. **No `tsconfig.typecheck.json` exists** (`cadre-provider`, `strand-proto`) —
     both currently point their `package.json` `typecheck` script at
     `tsconfig.build.json`, which is *also* the file their `build` script emits
     from. Do **not** edit `tsconfig.build.json` for this — changing its `rootDir`/
     `include` to fit `vitest.config.ts` would change where the real build looks for
     files and how `outDir` maps declaration output, i.e. it'd risk breaking
     `yarn build`. Instead, add a sibling `tsconfig.typecheck.json` (same pattern as
     `cadre-cli`) and repoint just the `typecheck` script at it.

`cadre-host` and `cadre-provider` are documented in `docs/STATUS.md` →
"Type-check coverage" as intentionally **source-only** for their `typecheck` gate
(known test-file type drift tracked separately, e.g. `cadre-core`/`cadre-host` test
type drift ticket referenced there). Preserve that scope — this ticket adds
`vitest.config.ts` to the type-check program, it does **not** widen either package to
also type-check its test files. Note `cadre-provider` actually *does* have test files
today (`src/**/__tests__/**/*.test.ts` — `docs/STATUS.md`'s "cadre-provider has no
test files" line is stale) and its current `tsconfig.build.json` explicitly excludes
them from typecheck; the new `tsconfig.typecheck.json` must keep excluding them so
this ticket doesn't accidentally pull in unrelated, unvetted test-type errors.

`strand-proto` is deprecated and intentionally source-only per `docs/STATUS.md` — keep
it that way; just add `vitest.config.ts` to its (new) typecheck program.

## Per-package changes

### `cadre-cli/tsconfig.typecheck.json` (edit)
Add `"vitest.config.ts"` to `include`. `rootDir` is already `"."`, so no TS6059 risk.
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

### `cadre-core/tsconfig.typecheck.json` (edit)
Add `"vitest.config.ts"` to `include`. `rootDir` is already `"../.."`, so no TS6059
risk (same reasoning as the `integration-tests` fix — `test/global-setup.ts` already
reaches outside the package).
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "../..",
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```
(Keep the existing `rootDir`-explanation comment in this file — don't delete it.)

### `cadre-host/tsconfig.typecheck.json` (edit)
Currently `include: ["src"]` only, no `rootDir` override (inherits `rootDir: "src"`
from the base `tsconfig.json`). Adding `vitest.config.ts` (package-root file) without
overriding `rootDir` will fail with TS6059. Override `rootDir` to `"."` and add the
file — but do **not** add `test/`/`ui/__tests__` (source-only stays source-only):
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "vitest.config.ts"]
}
```

### `cadre-provider/tsconfig.typecheck.json` (new file)
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "vitest.config.ts"],
  "exclude": ["src/**/__tests__/**"]
}
```
Then in `cadre-provider/package.json`, change the `typecheck` script from
`"tsc -p tsconfig.build.json --noEmit"` to `"tsc -p tsconfig.typecheck.json --noEmit"`.
Leave `tsconfig.build.json` and the `build` script untouched.

### `quereus-plugin-sereus/tsconfig.typecheck.json` (edit)
File uses tabs — preserve that. Add `"vitest.config.ts"` to `include`; `rootDir` is
already `"."`.
```json
{
	"extends": "./tsconfig.json",
	"compilerOptions": {
		"rootDir": ".",
		"noEmit": true
	},
	"include": ["src", "test", "vitest.config.ts"]
}
```

### `strand-proto/tsconfig.typecheck.json` (new file)
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".",
    "noEmit": true
  },
  "include": ["src", "vitest.config.ts"]
}
```
Then in `strand-proto/package.json`, change the `typecheck` script from
`"tsc -p tsconfig.build.json --noEmit"` to `"tsc -p tsconfig.typecheck.json --noEmit"`.
Leave `tsconfig.build.json` and the `build` script untouched (it's the real emit
config: `noEmit: false`, used by `yarn build`).

### `docs/STATUS.md` → "Type-check coverage" (edit)
Update the per-package scope bullets to reflect: all 8 non-web/non-RN-app-web packages
now include their own `vitest.config.ts` in whichever program backs `typecheck`
(`cadre-cli`, `cadre-core`, `cadre-host`, `cadre-provider`, `quereus-plugin-sereus`,
`strand-proto`, `integration-tests` via `tsconfig.typecheck.json`; `reference-app-rn`,
`reference-app-web` via their main `tsconfig.json`). Correct the stale
"`cadre-provider` has no test files" line — it does, they're intentionally excluded
from `typecheck` (type drift, same reasoning as `cadre-core`/`cadre-host`), not absent.

## Edge cases & interactions

- **`yarn build` must not change.** `cadre-provider` and `strand-proto`'s `build`
  scripts still point at `tsconfig.build.json`, untouched by this ticket. After the
  edits, run `yarn workspace @serfab/cadre-provider build` and
  `yarn workspace strand-proto build` (or repo-root equivalents) to confirm output is
  unchanged.
- **Don't let `vitest.config.ts` inclusion silently pull in test files** for the two
  source-only packages (`cadre-host`, `cadre-provider`) — `include: ["src", ...]`
  lists `src` explicitly rather than `.`, and `cadre-provider` additionally needs the
  `exclude` for its co-located `__tests__` dirs. Verify by running each package's
  `typecheck` and confirming the error/pass count doesn't include test-file errors
  that weren't there before (a fresh TS6059 or unrelated type error from a test file
  means the scope leaked).
- **`quereus-plugin-sereus`'s `vitest.config.ts` uses `test.projects` (two named
  projects, `unit` + `e2e`).** Confirm `defineConfig` still type-checks this shape
  cleanly under the installed Vitest version — this is exactly the kind of file this
  ticket exists to protect, so if there's a real type error here, fix it for real
  (don't loosen/cast around it).
- **Tabs vs spaces**: `quereus-plugin-sereus`'s existing JSON files use tabs; match
  that when editing (per `.editorconfig` / repo convention), don't reformat the whole
  file to spaces.
- **`cadre-core`'s `vitest.config.ts` references `./test/global-setup.ts` as a string**
  (`globalSetup`), not a TS import — no additional `rootDir` widening needed beyond
  what's already there for `test/global-setup.ts`'s own cross-package import of
  `test-harness/`.

## TODO

- Edit `cadre-cli/tsconfig.typecheck.json`, `cadre-core/tsconfig.typecheck.json`,
  `quereus-plugin-sereus/tsconfig.typecheck.json` to add `vitest.config.ts` to
  `include` (per snippets above).
- Edit `cadre-host/tsconfig.typecheck.json`: add `rootDir: "."` override, add
  `vitest.config.ts` to `include`.
- Create `cadre-provider/tsconfig.typecheck.json` (new), repoint
  `cadre-provider/package.json`'s `typecheck` script at it.
- Create `strand-proto/tsconfig.typecheck.json` (new), repoint
  `strand-proto/package.json`'s `typecheck` script at it.
- Run `yarn workspace <pkg> typecheck` for all six touched packages; fix any type
  error `vitest.config.ts` inclusion surfaces for real (don't suppress).
- Run `yarn workspace @serfab/cadre-provider build` and
  `yarn workspace strand-proto build` to confirm the untouched `tsconfig.build.json`
  path still emits correctly.
- Run root `yarn typecheck` (all workspaces) to confirm the gate is still green
  end-to-end.
- Update `docs/STATUS.md` → "Type-check coverage" per above.
