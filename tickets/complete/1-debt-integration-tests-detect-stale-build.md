description: Integration tests run compiled code, so an edit that was never rebuilt used to be silently ignored — the tests passed or timed out against the old build with no hint why. They now stop up front and name the package to rebuild.
files:
  - packages/integration-tests/src/harness/build-freshness.ts
  - packages/integration-tests/src/harness/build-freshness.spec.ts
  - packages/integration-tests/src/global-setup.ts
  - packages/integration-tests/vitest.config.ts
  - packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
  - docs/STATUS.md
  - docs/architecture.md
difficulty: easy
----

## What shipped

`packages/integration-tests/src/harness/build-freshness.ts` exports
`assertCadreBuildFresh()`. For `@serfab/cadre-core`, `@serfab/cadre-cli` and
`@serfab/cadre-host` it compares the newest modification time under the
package's `src` against the compiled entry point the tests actually load
(`dist/index.js`, or `dist/bin/cadre.js` for the CLI). If any `dist` is older
than its `src`, or missing, it throws one error naming every offending package
plus its exact `yarn workspace <name> build` remedy. Files that aren't build
inputs (`*.test.ts`, `*.spec.ts`, `test/`, `__tests__/`) are ignored.

It runs **once per suite** from `src/global-setup.ts`, wired as vitest
`globalSetup`, so the run stops before any scenario starts.

## Review findings

### Checked and clean

- **`resolvePackageRoot` walk-up false-match** (the implement handoff's first
  concern) — moot: the whole resolution strategy was replaced, see below.
- **Entry-point paths** — verified against each `package.json`:
  cadre-core/cadre-host `main` + `exports "."` are `dist/index.js`; cadre-cli's
  `bin.cadre` is `dist/bin/cadre.js`, which is literally what
  `host-process-orchestrator.ts:806` resolves and spawns. Correct.
- **`SOURCE_EXCLUDE` / `SOURCE_EXCLUDE_DIRS`** (the handoff's second concern) —
  correct as written. `dist` cannot be picked up: the walk is rooted at
  `<packageRoot>/src` and `dist` is its sibling, not its child. A `.d.ts`
  checked into `src` *should* count, since `tsc` treats it as a build input —
  no exclusion wanted. `cadre-host/ui/` is outside `src`, so UI-only edits
  don't trip the guard; that is right for these scenarios, which exercise the
  HTTP/orchestrator surface, not built UI assets.
- **Scenario coverage** (the handoff asked for a re-grep) — re-grepped
  `src/scenarios/` for `createContainer` / `ensureOwnerNode` /
  `createTestCadreHost` / `spawnEntrypoint`. Only `cadre-host-owner-node` and
  `cadre-host-node-donation` reach the real binary;
  `cadre-host-orchestrator-lifecycle` passes a fake `spawnEntrypoint`
  (`IDLE_CHILD`) and was correctly excluded. Nothing was missed. This became
  moot too — the guard is now suite-wide (see below).
- **Credential exposure** — `.yarnrc.yml` holds an npm auth token but is
  gitignored and untracked. Not a leak; no action.

### Found and fixed in this pass

- **The guard did not work where it was placed.** Moving it to `globalSetup`
  exposed that `import.meta.resolve()` is *not* Node's own when the module is
  loaded through Vite (how vitest loads global setup) — all three packages
  reported unresolvable. Replaced module resolution with a scan of the
  monorepo's `packages/` directory for a `package.json` whose `name` matches,
  reached by walking up from this file to the `package.json` declaring
  `workspaces`. Every package checked is a workspace sibling and
  `node_modules/@serfab/*` are symlinks back to those same directories, so the
  workspace copy *is* what the tests load. This also removes the dependency on
  resolver semantics that differ by Node version and by transform context —
  the handoff's open question about `import.meta.resolve` across Node versions
  is now moot rather than answered.
- **Coverage was too narrow, and the module's own doc said so.** The guard was
  called from two `beforeAll`s, but its doc comment claimed to cover packages
  "pulled in for their real behaviour" — and it's true that *every* scenario
  imports `@serfab/cadre-host` / `@serfab/cadre-core` from `dist`. A stale
  `dist` silently tested old code in all of them, just less dramatically than a
  spawn timeout. Moved to `globalSetup`: one check per run, covering the whole
  suite, and the two duplicated `beforeAll` calls (and their comments) are
  gone. Cost is one directory walk per run, a few milliseconds — this satisfies
  the original ticket's "must not slow ordinary in-process scenarios"
  requirement better than the per-scenario version did, which walked twice.
- **A failed resolution crashed instead of explaining.** An unresolvable
  package threw a raw `ERR_MODULE_NOT_FOUND` out of the guard. Now reported
  through the same problem list as `not resolvable from
  @serfab/integration-tests. Run: yarn install`.
- **The guard had no tests.** Its worst failure mode is silent: if it stops
  detecting staleness, nothing else notices. Split the comparison into an
  exported `checkBuildFreshness(packageRoot, distEntry)` returning
  `'unresolved' | 'missing' | 'stale' | undefined`, and added
  `src/harness/build-freshness.spec.ts` — 8 tests over temp directories with
  controlled mtimes covering fresh, stale-at-top-level, stale-deeply-nested,
  missing `dist`, test/spec files ignored, `test`/`__tests__` dirs ignored, a
  real source next to ignored ones still tripping, and no `src` directory.
- **Docs were stale, as the workflow assumes.** The implement stage added
  none. Added a "Testing / CI" entry in `docs/STATUS.md` describing the guard
  and its exclusions, and a sentence to the `packages/integration-tests`
  bullet in `docs/architecture.md`.
- **Silent pass on an absent `src`** — kept (a package without sources can't be
  shown stale, and failing there gives the caller nothing to act on) but it is
  now stated in the doc comment on `checkBuildFreshness` and pinned by a test,
  instead of being an unremarked consequence of a swallowed `readdirSync`.

### Filed as a new ticket

- `tickets/backlog/debt-vitest4-pooloptions-ignored.md` —
  `packages/integration-tests/vitest.config.ts` sets `test.poolOptions`, which
  Vitest 4 removed. Its `singleFork: true` (added specifically to avoid port
  conflicts between real-network scenarios) is silently ignored; every run
  prints a deprecation banner, and scenario files demonstrably interleave.
  Pre-existing, surfaced by running the suite. Not fixed inline because
  changing suite-wide parallelism needs its own validation pass.

### Tripwires (recorded, not ticketed)

- None. Every concern raised either resolved to a real defect (fixed or
  ticketed above) or to a confirmed non-issue. Nothing landed in the
  "fine now, only matters if X later" category.

### Deliberately not filed

- The implement handoff's note about mtime ordering after a fresh CI checkout.
  The reasoning holds: `dist/` is gitignored and only ever produced locally by
  `yarn build` *after* a checkout finishes, so `dist` mtimes are necessarily
  later than a fresh checkout's `src` mtimes. No false positive is reachable
  from any CI setup that exists today, and there is nothing to record at a code
  site that wouldn't be noise.

## Validation

Run from `packages/integration-tests` unless noted.

- `yarn typecheck` — clean. `yarn eslint packages/integration-tests` (root) — clean.
- `yarn vitest run src/harness/build-freshness.spec.ts` — 8/8 pass.
- Both real-spawn scenarios plus the new spec — 22/22 pass.
- Remaining six `cadre-host-*` scenarios plus `basic-connectivity` (to confirm
  the new `globalSetup` is a no-op for scenarios that don't spawn) — 32/32 pass.
- **End-to-end guard proof:** bumped `packages/cadre-host/src/index.ts`'s mtime
  to now without rebuilding; the run aborted immediately with
  `Stale build detected: ... @serfab/cadre-host: dist is stale — src was
  edited after the last build. Run: yarn workspace @serfab/cadre-host build`.
  The original mtime was captured beforehand and restored afterwards, so no
  rebuild was needed and the tree is unchanged.
- **Full suite** — the gap the implement stage flagged is now closed. `yarn
  vitest run` (no filter): 107 passed, 9 failed across 6 files, 66s. Re-ran
  with `--no-file-parallelism`: **identical** 9 failures, 368s.

### About those 9 failures

All are libp2p/optimystic control-DB convergence timeouts in scenarios this
change never touches, and all are attributed to the already-blocked ticket
`control-db-convergence-optimystic-p2p`. Seven were listed verbatim in
`tickets/.pre-existing-known.md`; two more are the same failure mode in the
same two files under test names that have since drifted, so they were appended
to that file under the same slug rather than re-reported. No
`.pre-existing-error.md` was written — the root cause is already tracked, and
nothing was skipped, disabled, or loosened.
