description: One package's test files were hidden from the type checker because a few had type errors; the errors are now fixed and the tests are checked like everything else. A related gap in another package (checking Svelte-app test files) is closed too, and the status doc is brought back in sync.
files: packages/cadre-provider/tsconfig.typecheck.json, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-host/package.json, docs/STATUS.md
---

# `cadre-provider` test files (and `cadre-host/ui` test files) now under `typecheck`

## What changed

The plan ticket (`16-debt-widen-typecheck-to-test-files`) re-measured state and found the
premise had gone half-stale: `cadre-core` and `cadre-host` `src` tests were already fixed by
an earlier commit (`c5b7afa`). Only `cadre-provider` still excluded its tests from
`typecheck`, plus `cadre-host/ui`'s test files were never wired into any `tsc` program at
all. `docs/STATUS.md` hadn't been updated to reflect the earlier fix and pointed at a ticket
slug not on the board.

This implement pass:

1. **Fixed the 4 real type errors** in `cadre-provider`, both the same root cause — a
   `vi.fn()` spy declared with zero parameters, so `mock.calls[0]?.[1]` (or `[0]`) indexed
   past an empty tuple (`TS2493`), and the resulting `undefined` failed an `as` cast
   (`TS2352`). Fix was to type the spy's parameters to match what the code under test
   actually passes, following an existing same-file precedent:
   - `container-seed-endpoint.test.ts:106` — `fetchMock` now declares
     `(_url: string | URL, _init?: RequestInit)`.
   - `orchestrator-port-leak.test.ts:115` — `createSpy` now declares `(_opts: CreateOpts)`
     against a new local `CreateOpts` type (the subset of dockerode's create-options shape
     the assertions read); the old `as { … }` cast at the read site is gone.
2. **Removed the `exclude` in `packages/cadre-provider/tsconfig.typecheck.json`** — the
   whole reason it existed (test-file type errors) is now fixed, so `include: ["src",
   "vitest.config.ts"]` reaches `src/**/__tests__/**` on its own.
3. **Chained a second `tsc` pass into `cadre-host`'s `typecheck` script** —
   `tsc -p tsconfig.typecheck.json --noEmit && tsc -p ui/tsconfig.json --noEmit`. `ui/`
   can't join the main program (different module resolution, Svelte types), but its
   `tsconfig.json` already listed `__tests__/**/*.ts` and already passed clean; it just
   wasn't invoked by anything. `tsc` silently ignores the `.svelte` entries in that
   `include` (can't parse them), so this pass covers only the `.ts` test files — the
   `.svelte` gap is unchanged and still owned by `check:svelte`/`svelte-check`.
4. **Updated `docs/STATUS.md`** "Type-check coverage" section: moved `cadre-core`,
   `cadre-host`, `cadre-provider` into the "Source + tests" bullet (only `strand-proto`
   stays source-only, by design, being deprecated); deleted the stale gap bullet that named
   the now-closed ticket slug; removed the sentence claiming `cadre-provider` explicitly
   excludes its tests; extended the `.svelte` gap bullet to note `cadre-host`'s
   `ui/__tests__/*.ts` is now covered by the second `tsc` pass while `.svelte` itself still
   isn't.

## Verification performed

```
yarn workspace @serfab/cadre-provider typecheck   # exit 0 (was 4 errors)
yarn workspace @serfab/cadre-host typecheck        # exit 0 (both tsc passes)
yarn workspace @serfab/cadre-provider test         # 19 files / 126 tests passed
yarn typecheck                                     # root, fans out to all 10 workspaces — exit 0
                                                    # includes check:vitest-typecheck-coverage — passed
yarn lint                                           # exit 0, no findings
```

No pre-existing failures encountered; nothing written to `tickets/.pre-existing-error.md`.

## Diff surface (5 files, matches ticket's declared scope exactly)

- `packages/cadre-provider/tsconfig.typecheck.json` — dropped `exclude` + its comment block.
- `packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts` — typed
  one spy's parameters.
- `packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts` — typed one
  spy's parameters, added local `CreateOpts` type, dropped an `as` cast.
- `packages/cadre-host/package.json` — `typecheck` script now chains a second `tsc -p
  ui/tsconfig.json --noEmit`.
- `docs/STATUS.md` — "Type-check coverage" section brought back in sync with actual state.

## Known gaps / things the reviewer should specifically check

- **The other 17 `cadre-provider` test files** (and non-`.test.ts` helpers like
  `fake-docker.ts`) entered the `typecheck` program for the first time in this change. They
  were included in the pre-change 4-error measurement (full `tsc -p tsconfig.json --noEmit
  --rootDir .`) and came back clean, and the post-change `yarn workspace @serfab/cadre-provider
  typecheck` run (which uses `tsconfig.typecheck.json`, not byte-identical to `tsconfig.json`)
  also exits 0 — but this is the first time this exact program has run over the whole
  directory, so it's worth a second look if anything seems off.
- **`.svelte` files remain untyped by `tsc`** in `cadre-host/ui` and `reference-app-web` —
  unchanged, intentionally out of scope per the ticket, still owned by `svelte-check`.
- **No behavior change intended in the two test files** — only the declared type of two
  `vi.fn()` spies changed (params added, one cast removed). The `yarn workspace
  @serfab/cadre-provider test` run (126 passed) is the check that runtime behavior didn't
  shift; worth a quick read of the two diffs to confirm the added parameter types don't
  quietly change which mock overload vitest picks.
- No tripwires identified during this pass — the ticket's scope was narrow and fully
  resolved, not conditional.
