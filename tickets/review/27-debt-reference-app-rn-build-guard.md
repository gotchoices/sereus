description: Added the stale-build guard to reference-app-rn's unit tests, so they abort instead of quietly running months-old cadre-core output.
files: packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/test/global-setup.ts, packages/reference-app-rn/test/build-targets.spec.ts
---

# reference-app-rn stale-build guard — implemented

Followed the resolved design in the source ticket exactly; no deviations.

## What changed

- `packages/reference-app-rn/test/global-setup.ts` (new): exports `TARGETS`
  (8 `BuildTarget`s — `@serfab/cadre-core` and `@serfab/quereus-plugin-sereus`
  as `workspace`; `@optimystic/db-core`, `@optimystic/db-p2p`,
  `@optimystic/db-p2p-storage-rn`, `@optimystic/quereus-plugin-crypto`,
  `@optimystic/quereus-plugin-optimystic`, `@quereus/quereus` as `linked`) and a
  default `setup()` calling `assertBuildFresh(TARGETS, import.meta.url)`.
  Modeled directly on `packages/reference-app-web/test/global-setup.ts`, with
  `@optimystic/db-p2p-storage-web` swapped for `@optimystic/db-p2p-storage-rn`.
- `packages/reference-app-rn/test/build-targets.spec.ts` (new): calls
  `describeBuildTargets('reference-app-rn', ...)` from
  `test-harness/build-targets-spec.ts`, pinning `expectFound` to
  `@serfab/cadre-core` (workspace) and `@optimystic/db-p2p` (linked) — both are
  declared in this package's own `dependencies`, unlike `@optimystic/db-core`
  which is reached only transitively through `cadre-core`.
- `packages/reference-app-rn/vitest.config.ts`: added
  `globalSetup: ['./test/global-setup.ts']` to the `node` project block only.
  The `react` project is untouched — it mocks `@serfab/cadre-core` via
  `vi.mock` in `test/react/use-cadre.spec.ts` and never runs real compiled
  output.

## How it was tested

- `yarn workspace @serfab/reference-app-rn test` — all 10 test files / 164
  tests pass (`node` project's 9 spec files including the new
  `build-targets.spec.ts`, plus `react`'s `use-cadre.spec.ts`). `dist` was
  already fresh going in, so this run was green from the start rather than
  failing first — see the drift check below for the actual failure-path proof.
- `yarn workspace @serfab/reference-app-rn typecheck` — clean, no output.
- Drift check: `touch`ed `packages/cadre-core/src/arachnode-stub.ts` (confirmed
  its mtime moved past `dist/index.js`'s), re-ran the RN test command — it
  failed before any test file ran, "No test files found" from vitest's runner
  plus an unhandled error: `Stale build detected: ... @serfab/cadre-core: dist
  is stale — src was edited after the last build. Run: yarn workspace
  @serfab/cadre-core build`. Confirms the guard aborts the whole `node`
  project, not just the specs that import `cadre-core` directly, and names the
  right package. Ran `yarn workspace @serfab/cadre-core build`, re-ran the RN
  test command — back to 10 files / 164 tests green. No leftover stale state.
- `git status --porcelain` after all of the above: only the three files this
  ticket lists (`vitest.config.ts` modified, two new files under
  `test/`) — `dist` directories are gitignored, nothing else moved.

## Gaps / things the reviewer should know

- Did not additionally run the wider monorepo test suite (`cadre-core`,
  `reference-app-web`, `integration-tests`, etc.) beyond the one
  `cadre-core build` triggered above — out of scope for this ticket, and
  those suites' own guards are unrelated to this change.
- Did not exercise the `unresolved`/`missing` `StaleReason` branches (only
  `stale`) — `assertBuildFresh`, `checkLinkedTarget`, and friends are already
  covered by `test-harness`'s own unit tests elsewhere in the repo, so this
  ticket only needed to prove the wiring, not re-prove the guard's internal
  logic.
- No functional decisions were left open by the source ticket — its "Resolved
  design" section was accurate as written; this write-up is a straight
  execution record, not a design justification.
