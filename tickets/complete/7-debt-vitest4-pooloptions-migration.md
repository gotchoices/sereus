description: Restored the safety guard that keeps integration tests from running two-at-a-time and colliding on the same network port, after a test-runner upgrade had silently turned that guard off — and added a type-check so a future upgrade can't turn it off unnoticed.
files: packages/integration-tests/vitest.config.ts, packages/integration-tests/tsconfig.typecheck.json, docs/STATUS.md
difficulty: easy
---

# Migrate integration-tests to Vitest 4 sequential-run config — complete

## What changed

**Implement stage** (`ff9ed44`) — `packages/integration-tests/vitest.config.ts`:
replaced the removed Vitest 4 `test.poolOptions.forks.singleFork` block with the
top-level equivalent:

```ts
pool: 'forks',
fileParallelism: false,
```

**Review stage** (this pass):

- `packages/integration-tests/tsconfig.typecheck.json` — added `vitest.config.ts`
  to `include` and overrode `rootDir` to `"."` (the base config pins
  `rootDir: "src"`, which otherwise errors TS6059). `yarn typecheck` now covers
  the vitest config file.
- `packages/integration-tests/vitest.config.ts` — corrected the explanatory
  comment (see finding 1) and noted the new type-check coverage.
- `docs/STATUS.md` — the open `- [ ]` item describing this exact bug was still
  present and now contradicted the code; replaced with a `- [x]` entry recording
  the resolution.
- `tickets/backlog/debt-vitest4-pooloptions-ignored.md` — deleted; it was a
  duplicate filing of this same issue, now resolved.

## Review findings

### Correctness — 1 minor finding, fixed inline

1. **Comment claimed behaviour the setting doesn't provide.** The implement-stage
   comment read "top-level fileParallelism: false (one fork, files run one at a
   time)". `fileParallelism: false` guarantees *one file at a time*; it does **not**
   collapse to one fork — with `isolate` at its default `true`, each file still gets
   its own fresh forked process. That is stricter isolation than `singleFork: true`
   was, so it is the right setting for the stated goal (avoiding port collisions),
   but the parenthetical was wrong. Rewritten to say what actually happens.
   *Fixed in this pass.*

The substantive change itself is correct. `fileParallelism` is a real resolved
top-level Vitest 4 key (`node_modules/vitest/dist/chunks/config.d.A1h_Y6Jt.d.ts:163`),
vitest is at 4.1.8, and no other file in the repo references `poolOptions`,
`singleFork`, or `singleThread`.

### Test / gate coverage — 1 gap found, closed for this package

2. **The original bug was type-detectable but nothing type-checked the file.**
   `tsc` reports `'poolOptions' does not exist in type 'InlineConfig'` on the old
   config — but `tsconfig.typecheck.json` included only `src/**/*.ts`, so
   `vitest.config.ts` was in no type-check program and the dead setting survived an
   entire major-version upgrade with `yarn typecheck` green. Closed for this package
   by adding the file to the typecheck include. **Verified the gate actually bites**:
   temporarily re-inserting the `poolOptions` block makes
   `yarn workspace @serfab/integration-tests typecheck` fail with exit 2 and the
   TS2769 error above; restored immediately after. *Fixed in this pass.*

### Major — 1 ticket filed

3. **The same type-check blind spot exists in the other seven packages.** Only
   `integration-tests` was fixed here (it is this ticket's file). `cadre-cli`,
   `cadre-core`, `cadre-host`, `cadre-provider`, `quereus-plugin-sereus`,
   `reference-app-rn`, and `strand-proto` each have a root `vitest.config.ts`
   outside their typecheck program. Not this ticket's scope — filed as
   `tickets/backlog/debt-typecheck-vitest-configs.md`.

### Tripwires — 1 recorded, no ticket

4. If some future integration scenario needs state shared *in-process across test
   files* (the one thing `singleFork: true` gave that `fileParallelism: false` does
   not), the knob is `isolate: false`, not a return to `poolOptions`. Fine now —
   nothing in the suite wants shared cross-file state, and per-file forks are the
   safer default for port-binding tests. Parked as a parenthetical in the
   `vitest.config.ts` comment at the exact site.

### Docs

Read every file the change touches plus the ones it should have: `docs/STATUS.md`
was stale (finding above, fixed). `docs/architecture.md`, `docs/cadre-host.md`,
`docs/strands.md`, and `docs/cadre-consistency.md` say nothing about vitest pooling
and needed no edit. `packages/integration-tests/README` — none exists.

### Categories with nothing to report

- **Source hygiene / DRY / decomposition / resource cleanup / error handling** —
  nothing to report, and not for lack of looking: the diff is one options object in
  a 30-line config file with no functions, no control flow, and no resources. These
  aspects have no surface to land on here.
- **Performance** — sequential execution is a deliberate ~7x wall-clock cost
  (66s parallel → 453s sequential) that is the *point* of the ticket, not a
  regression.

## Verification performed

- `yarn lint` (root) — exit 0, clean.
- `yarn typecheck` (root, all 9 workspaces) — exit 0, 20s, with the widened
  integration-tests typecheck scope in place.
- Negative test of the new gate — see finding 2.
- `yarn test` in `packages/integration-tests` — full run, streamed; log kept at
  the session scratchpad as `review-test.log`:
  - No `DEPRECATED test.poolOptions` warning.
  - `Test Files  6 failed | 21 passed (27)`, `Tests  9 failed | 107 passed (116)`.
  - All 9 failures matched by exact test name against
    `tickets/.pre-existing-known.md` — every one listed under
    `control-db-convergence-optimystic-p2p` (status: blocked). No new failures;
    nothing skipped or loosened. Not re-reported per the pre-existing-failure rule.
  - `Duration 453.72s` for 116 tests across 27 files, versus the 66s parallel
    baseline recorded when the bug was found — independent confirmation the
    sequential setting is genuinely in effect.
