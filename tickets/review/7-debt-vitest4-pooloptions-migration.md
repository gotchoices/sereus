description: Restored the safety guard that keeps integration tests from running two-at-a-time and colliding on the same network port, after a Vitest upgrade had silently turned that guard off.
files: packages/integration-tests/vitest.config.ts
difficulty: easy
---

# Migrate integration-tests to Vitest 4 sequential-run config — done

## What changed

`packages/integration-tests/vitest.config.ts`: replaced the removed Vitest 4
`test.poolOptions.forks.singleFork` block with the top-level equivalent:

```ts
pool: 'forks',
fileParallelism: false,
```

Comment above it updated to explain why (Vitest 4 removed `poolOptions`; this
is the replacement for single-fork sequential execution).

## Verification performed

- `fileParallelism` confirmed as a real resolved top-level Vitest 4 config
  key via `node_modules/vitest/dist/chunks/config.d.A1h_Y6Jt.d.ts:163`
  (`fileParallelism: boolean;`).
- `yarn build` at repo root — full monorepo build green, no stale-dist
  failures (prereq ticket `debt-integration-tests-detect-stale-build`
  already landed and guards this).
- `yarn test` inside `packages/integration-tests` — full run, log at
  `/c/Users/n8ers/AppData/Local/Temp/claude/.../scratchpad/test.log`:
  - No `DEPRECATED test.poolOptions` warning (was present before the fix,
    confirming the old block really was dead).
  - `Test Files  6 failed | 21 passed (27)`, `Tests  9 failed | 107 passed (116)`.
  - **All 9 failures cross-checked against `tickets/.pre-existing-known.md`
    — every one is already listed there under the `control-db-convergence-optimystic-p2p`
    slug (status: blocked), unrelated to this config change.** No new
    failures introduced.
  - Total suite duration ~373s for 116 tests across 27 files — consistent
    with genuinely sequential (single-fork) execution, not parallel.

## What reviewer should double check

- This is a config-only, mechanical change (one file, ~6 lines). Low risk.
- Sequential execution is now enforced by `fileParallelism: false` rather
  than being empirically inferred from wall-clock — reviewer may want to
  additionally sanity-check by temporarily reverting the fix and confirming
  the DEPRECATED warning reappears (I did this as part of investigation,
  not preserved in a diff).
- The 9 pre-existing convergence-test failures are out of scope for this
  ticket (tracked separately as `control-db-convergence-optimystic-p2p`,
  currently blocked) — do not attempt to fix them here.
