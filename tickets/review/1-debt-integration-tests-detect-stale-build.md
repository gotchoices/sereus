description: Some tests launch the real command-line app as a separate program, and if that program was not rebuilt after a code change they quietly test the old version — failing minutes later with a timeout that says nothing about the real cause. This is the review pass for the fix.
files:
  - packages/integration-tests/src/harness/build-freshness.ts
  - packages/integration-tests/src/harness/index.ts
  - packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
difficulty: easy
----

## What to review

New harness module `packages/integration-tests/src/harness/build-freshness.ts`
exports `assertCadreBuildFresh()`, called as the first line of `beforeAll` in
the two scenarios that spawn a real `@serfab/cadre-cli` child process:
`cadre-host-node-donation.integration.ts` and
`cadre-host-owner-node.integration.ts`.

It walks `src/` of `@serfab/cadre-core`, `@serfab/cadre-cli`, and
`@serfab/cadre-host` (resolving each package root via
`import.meta.resolve()` + walking up to the matching `package.json`, since
these are ESM-only packages and `cadre-core` doesn't export
`./package.json`), compares the newest `src` mtime (excluding
`*.test.ts`/`*.spec.ts` and `test`/`__tests__` dirs) against the mtime of the
compiled entry point actually spawned (`dist/index.js` for
cadre-core/cadre-host, `dist/bin/cadre.js` for cadre-cli), and throws one
`Error` naming every stale/missing package plus the exact
`yarn workspace <name> build` fix, before any child process is spawned.

Two things worth a close look:

- `resolvePackageRoot`'s package.json name-matching walk-up
  (`build-freshness.ts:85-97`) — confirm it can't falsely match a
  differently-scoped `package.json` on the way up, and that
  `import.meta.resolve` behaves the same across the Node versions this repo
  targets.
- `SOURCE_EXCLUDE` / `SOURCE_EXCLUDE_DIRS` (`build-freshness.ts:36-37`) —
  confirm the regex/dir list is the right exclusion set (e.g. does it need to
  also skip `dist` if `src` and `dist` are ever siblings under a symlinked
  root, or `.d.ts` build artifacts checked into `src` anywhere).

Also worth a second opinion: is `cadre-host-orchestrator-lifecycle.integration.ts`
correctly excluded? It calls `createTestCadreHost({ spawnEntrypoint: IDLE_CHILD, ... })`
— a fake entrypoint, not the real cadre-cli binary — so it was left
untouched. Re-grep `packages/integration-tests/src/scenarios/` for
`createContainer`/`ensureOwnerNode` to confirm no other scenario spawns the
real binary and was missed.

## How this was tested (implement stage)

- `yarn typecheck` in `packages/integration-tests` — clean.
- `yarn eslint` on all 4 touched files — clean.
- Fresh `yarn workspace @serfab/cadre-core build`,
  `yarn workspace @serfab/cadre-cli build`,
  `yarn workspace @serfab/cadre-host build`, then ran both real-spawn
  scenarios directly:
  - `cadre-host-owner-node.integration.ts`: 9/9 pass (~20s)
  - `cadre-host-node-donation.integration.ts`: 5/5 pass (~21s)
- Stale-build simulation (fix stage): bumped `cadre-cli`/`cadre-host`
  `src/index.ts` mtimes to "now" without rebuilding, re-ran the owner-node
  scenario — failed in ~16s with a clear
  `Stale build detected: ... dist is stale — src was edited after the last
  build. Run: yarn workspace @serfab/cadre-host build` message instead of
  hanging toward the 90s startup timeout. Rebuilt afterward; repo left clean
  (`dist/` is gitignored, only mtimes were touched during the test, which
  `git status` doesn't track).

**Not run**: the full integration-tests suite (`yarn vitest run` with no
path filter) was not run end-to-end in either the fix or implement stage —
only the two directly-affected scenarios were run directly, to keep runtime
bounded. If the reviewer wants full-suite confidence, that's the gap to
close.

## Review findings

(fill in during review)
