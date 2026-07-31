description: One package's test files were hidden from the type checker because a few had type errors; the errors are now fixed and the tests are checked like everything else. A related gap in another package (checking a web UI's test files) is closed too, and the status doc is back in sync.
files: packages/cadre-provider/tsconfig.typecheck.json, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts, packages/cadre-provider/src/service/__tests__/orchestrator-port-leak.test.ts, packages/cadre-host/package.json, docs/STATUS.md
---

# `cadre-provider` test files (and `cadre-host/ui` test files) now under `typecheck`

## What landed

- **4 type errors fixed in `cadre-provider` tests**, both instances of the same root cause: a
  `vi.fn()` spy declared with zero parameters, so reading `mock.calls[0]?.[1]` indexed past an
  empty tuple (`TS2493`) and the resulting `undefined` failed an `as` cast (`TS2352`). Fix was
  to declare the spy's parameters to match what the code under test passes.
  - `container-seed-endpoint.test.ts` — `fetchMock` now takes `(_url: string | URL, _init?: RequestInit)`.
  - `orchestrator-port-leak.test.ts` — `createSpy` now takes `(_opts: CreateOpts)` against a new
    local `CreateOpts` type (the subset of dockerode's create-options shape the assertions read);
    the `as { … }` cast at the read site is gone.
- **`exclude` removed from `packages/cadre-provider/tsconfig.typecheck.json`** — the reason it
  existed is fixed, so `include: ["src", "vitest.config.ts"]` now reaches `src/**/__tests__/**`.
- **`cadre-host`'s `typecheck` chains a second `tsc` pass** —
  `tsc -p tsconfig.typecheck.json --noEmit && tsc -p ui/tsconfig.json --noEmit`. The UI can't join
  the main program (different module resolution, Svelte types), and its own `tsconfig.json` already
  listed `__tests__/**/*.ts` and already passed clean — nothing invoked it.
- **`docs/STATUS.md` → "Type-check coverage"** brought back in sync: `cadre-core`, `cadre-host`,
  `cadre-provider` moved into the "Source + tests" bullet, the stale gap bullet naming a
  nonexistent ticket slug deleted.

## Review findings

### What was checked

- The implement diff read first, before the handoff summary.
- **Every `tsconfig*.json` in `packages/*` grepped for test-hiding `exclude` entries.** Only the
  four `tsconfig.build.json` files exclude tests, which is correct — build output should not
  contain them. No `tsconfig.typecheck.json` excludes tests any more.
- **Independent cross-package audit** (throwaway script, not committed): for all ten workspaces,
  enumerate every `*.test.ts` / `*.spec.ts` on disk, resolve the real file list of every tsconfig
  the package's `typecheck` script passes via `-p` (using `ts.getParsedCommandLineOfConfigFile`,
  same API the existing guard uses), and diff. Result: 205 test files across the repo, **0
  orphaned** except the 9 `reference-app-web` Playwright e2e specs, which are covered by a
  different script (see tripwire below). This independently confirms the STATUS.md claim table
  rather than trusting it — including that `cadre-core`'s 83 `.spec.ts` and `cadre-provider`'s 19
  `.test.ts` really are all in-program.
- **`cadre-host` UI pass actually checks something**: `tsc -p ui/tsconfig.json --noEmit --listFiles`
  resolves 7 `ui/src/**/*.ts` plus all 3 `ui/__tests__/*.ts` files. The `ui/__tests__` files are in
  `cadre-host`'s vitest `include`, so the gap this closed was real.
- **The existing guard tolerates the new two-`tsc` script.** `scripts/check-vitest-typecheck-coverage.mjs`
  scrapes *all* `-p`/`--project` flags and treats a package as covered if any one program contains
  its `vitest.config.ts`, so chaining a second pass does not trip or weaken it. Its own fixture
  suite already covers the two-`-p` case.
- **The two test-file edits are type-only.** Added parameter types on `vi.fn()` callbacks and one
  removed cast; no runtime path touched. Provider suite re-run green.
- Docs: `docs/STATUS.md` "Type-check coverage" read end-to-end against measured reality (including
  the "seven `tsconfig.typecheck.json` files" count — still seven).

### Minor findings — fixed in this pass

- **`container-seed-endpoint.test.ts:113` kept a `?.` + `as RequestInit` combination** —
  `mock.calls[0]?.[1] as RequestInit` silently casts `undefined` into a non-optional type, exactly
  the type-laziness the ticket exists to remove, and inconsistent with the sibling file where the
  implementer dropped the cast in favour of `calls[0]![0]`. Changed to `calls[0]![1]!`.
- **`docs/STATUS.md` listed `strand-proto` under "Known coverage gaps"** as source-only-by-design.
  It has zero test files, so nothing is hidden — it is not a gap at all. Folded into the
  source-only bullet with that fact stated.
- **`reference-app-ns` was absent from the per-package scope list entirely** (pre-existing: the
  section named nine of ten workspaces). Added, with its `typecheck` invocation and the note that
  it has no test files yet.
- **`ui/tsconfig.json`'s `include` lists `src/**/*.svelte`, which plain `tsc` silently ignores.**
  A reader of the new second pass would reasonably assume `.svelte` is now covered. Added one
  sentence to the `.svelte` gap bullet saying that entry is there for `svelte-check`, not for this
  pass.

### Major findings — none filed

No new tickets. The obvious follow-up — *nothing stops someone re-adding an exclusion* — is
already on the board as `tickets/backlog/debt-guard-test-files-typechecked.md`, which names this
ticket as its prereq and specifies exactly that acceptance criterion. Re-filing it would duplicate.

### Tripwire

`reference-app-web`'s 9 Playwright e2e specs are the only test files outside the fast gate: they
live in `tsconfig.e2e.json`, checked by `typecheck:e2e`, which is chained into that package's
`build` — not into root `yarn typecheck`. They do get checked (verified: exits 0), just later. If
`yarn typecheck` ever becomes the sole pre-commit gate, e2e type drift would ride to `build`
unnoticed. Parked as a clarifying clause on the existing `reference-app-web` bullet in
`docs/STATUS.md` → "Type-check coverage", not as a ticket.

## Verification

```
yarn workspace @serfab/cadre-provider typecheck   # exit 0
yarn workspace @serfab/cadre-provider test        # 19 files / 126 tests passed
yarn workspace @serfab/cadre-host typecheck        # exit 0 (both tsc passes)
yarn workspace @serfab/cadre-host test             # 59 files / 511 passed, 4 skipped
npx tsc -p tsconfig.e2e.json --noEmit              # reference-app-web, exit 0
yarn typecheck                                     # root, all 10 workspaces + coverage guard — exit 0
yarn lint                                          # exit 0
```

No pre-existing failures encountered; `tickets/.pre-existing-error.md` not written.
