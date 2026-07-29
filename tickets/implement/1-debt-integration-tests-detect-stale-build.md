description: Some tests launch the real command-line app as a separate program, and if that program was not rebuilt after a code change they quietly test the old version — failing minutes later with a timeout that says nothing about the real cause. This ticket implements and validates the fix.
files:
  - packages/integration-tests/src/harness/build-freshness.ts
  - packages/integration-tests/src/harness/index.ts
  - packages/integration-tests/src/scenarios/cadre-host-node-donation.integration.ts
  - packages/integration-tests/src/scenarios/cadre-host-owner-node.integration.ts
difficulty: easy
----

## Status: implementation done, needs the standard implement→review handoff write-up

The fix stage (this file's predecessor) did the research **and** landed the
fix, because the scope was small and unambiguous. This ticket exists only to
carry the work through the normal `implement → review` stage boundary — there
is no remaining design decision, but the review stage should still get a
proper handoff rather than inheriting a `fix/` ticket directly.

## What was built

New harness module `packages/integration-tests/src/harness/build-freshness.ts`
exports `assertCadreBuildFresh()`. It:

- Resolves the on-disk root of `@serfab/cadre-core`, `@serfab/cadre-cli`, and
  `@serfab/cadre-host` by resolving each package's real entry point via
  `import.meta.resolve(...)` and walking up to the `package.json` whose `name`
  matches (these packages are ESM-only with no `require` condition and
  `cadre-core` doesn't export `./package.json`, so `require.resolve` doesn't
  work here — see the doc comment on `resolvePackageRoot`).
- For each package, compares the newest mtime under `src/` (recursively,
  excluding `*.test.ts`/`*.spec.ts` and `test`/`__tests__` dirs — those aren't
  part of the build) against the mtime of the compiled entry point actually
  spawned/imported at runtime (`dist/index.js` for cadre-core/cadre-host,
  `dist/bin/cadre.js` for cadre-cli — the literal file `HostProcessOrchestrator`
  spawns).
- Throws a single `Error` naming every stale/missing package and the exact
  `yarn workspace <name> build` command to fix it, if any check fails.

`assertCadreBuildFresh()` is exported from `harness/index.ts` and called as
the first line of `beforeAll` in the two scenarios that spawn a real
`cadre-cli` child process:
- `cadre-host-node-donation.integration.ts`
- `cadre-host-owner-node.integration.ts`

These were the only scenarios in `packages/integration-tests/src/scenarios/`
that actually call `createContainer`/`ensureOwnerNode` against the *default*
(real) orchestrator entrypoint — confirmed by grepping all scenario files for
those calls. Other scenarios using `createTestCadreHost()` either pass a fake
`spawnEntrypoint` (`cadre-host-orchestrator-lifecycle`) or never spawn a
container at all, so they're untouched and pay no extra cost — satisfying the
ticket's "must not slow down ordinary in-process scenarios" requirement. A
test-script-level build dependency (the ticket's other suggested direction)
was rejected for this reason: it would rebuild for every scenario, not just
the two that need it.

## Validation performed

- `yarn typecheck` in `packages/integration-tests` — clean.
- Built `cadre-core`, `cadre-cli`, `cadre-host` fresh, then ran both real
  scenarios via `yarn vitest run src/scenarios/cadre-host-owner-node.integration.ts`
  and `...cadre-host-node-donation.integration.ts` directly (not through the
  full suite, to keep runtime bounded) — both pass in full (9/9 and 5/5).
- Simulated staleness by bumping `packages/cadre-cli/src/index.ts` and
  separately `packages/cadre-host/src/index.ts` mtimes to "now" without
  rebuilding, then re-ran the owner-node scenario: it failed in ~16s with
  `Stale build detected: ... @serfab/cadre-host: dist is stale — src was
  edited after the last build. Run: yarn workspace @serfab/cadre-host build`
  instead of hanging toward the 90s startup timeout. Rebuilt afterward and
  confirmed the suite passes again — repo is left in a clean, fresh-build
  state (no source content was changed, only transient mtimes during the
  test, which don't show up in `git status`).

## Known gap (documented, not blocking)

The freshness check is `mtime`-based. If a CI checkout or `git clone`
regenerates `src` file mtimes to all-equal checkout-time values ordered
differently than the true edit history, this check cannot tell "reordered
checkout" apart from "real edit after build" purely from mtimes — but since
`dist/` is `.gitignore`d and only ever produced locally by `yarn build`
*after* a checkout completes, `dist` mtimes will always be later than a
fresh checkout's `src` mtimes in practice, so this isn't expected to produce
false positives in CI. Flagging for the reviewer to confirm this reasoning
holds, not filing it as a ticket — it's conditional on a CI setup change that
doesn't exist today.

## TODO

- Review the diff for correctness (esp. `resolvePackageRoot`'s package.json
  name-matching walk-up, and the `SOURCE_EXCLUDE` regex/dir list).
- Confirm no other scenario should be added to the `assertCadreBuildFresh()`
  callers (re-grep scenarios for `createContainer`/`ensureOwnerNode` in case a
  new one is added later that spawns the real binary).
- Produce the `review/` output ticket with a `## Review findings` section per
  the standard workflow.
