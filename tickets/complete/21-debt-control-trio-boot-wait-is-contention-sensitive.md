description: When an integration test file fails during its shared setup, the test runner counts every test in it as "skipped", so the summary line looks like nothing failed. Each integration run now ends with a block naming those tests as not run.
architecture: docs/testing.md
files: test-harness/setup-failure-reporter.ts, test-harness/setup-failure-reporter.spec.ts, packages/integration-tests/vitest.config.ts, packages/integration-tests/package.json, docs/testing.md, AGENTS.md
----

# A suite that dies in setup no longer summarizes only as "skipped"

## What was built

`test-harness/setup-failure-reporter.ts` is a Vitest reporter with type-only imports. At the end of a run it prints one block to stdout, after Vitest's own summary, naming the tests that a failed `beforeAll` kept from running, grouped by the suite (or file) whose hook threw, with the first line of the hook's error. It prints nothing when there are none and does not touch the exit code.

```
 NOT RUN  1 test did not run because a setup hook (beforeAll) failed. Count as failed, not skipped.
   test/zz-scratch-setup-failure.spec.ts > scratch setup failure — 1 test
     Error: scratch boot failed
```

A test is counted when its state is `skipped`, its mode is `run` (so not `it.skip`, `describe.skipIf`, `todo`, or filtered out), and its nearest enclosing suite or file is `failed`, has a hook error, and contains no test that passed or failed.

Wiring: `packages/integration-tests/vitest.config.ts` lists `['verbose', '../../test-harness/setup-failure-reporter.ts']`; the `test` and `test:debug` scripts no longer pass `--reporter=verbose`, because a command-line `--reporter` replaces the config's list. `docs/testing.md` has the section "Tests that did not run"; `AGENTS.md` mentions the reporter in its description of `test-harness/`.

The two other arms of the original ticket (the 45-second wait in the three-node control boot, and heavy files running side by side) were closed before implementation: the wait's cause was fixed upstream in optimystic, and the integration config already runs one file at a time. `control-trio.ts` and `wait-utils.ts` were not touched.

Only `integration-tests` lists the reporter. Other packages still summarize a failed `beforeAll` as skipped; adopting it is one config line each, described in the doc section.

## Review findings

Read the `ticket(implement): debt-control-trio-boot-wait-is-contention-sensitive` diff before the handoff, then ran the reporter against fixtures the implementer had not tried.

**Found and fixed**

- **A `beforeAll` that throws a plain object crashed the reporter.** `throw { code: 5 }` reaches the reporter as an error whose `message` is undefined, although Vitest's type says it is a string. `firstErrorLine` called `.split` on it, Vitest printed `Unhandled Error: TypeError: Cannot read properties of undefined (reading 'split')`, and the whole `NOT RUN` block was lost for that run, including the groups for other suites. Reproduced in a scratch fixture outside the repo. `firstErrorLine` now reads the error as untyped and prints `the hook threw a value with no message` for that case. This also replaced the unreachable `no error recorded` fallback the handoff flagged. The spec's fixture gained a fifth file, `object-thrown.spec.mjs`, and the expected total went from 3 to 4; no new test case or extra Vitest child process was added.
- **Doc adoption bullet was incomplete.** "Only `integration-tests` lists it" told another package to add the config line, but not to remove a `--reporter` flag from its scripts, which would silently drop the reporter. Added.

**Checked, nothing to change**

- **Terminal rendering (the handoff's open gap).** Not run on a real terminal, but settled by reading Vitest 4.1.8: reporters' `onTestRunEnd` are called in list order and the default/verbose one is synchronous; it prints the summary and then calls the live-summary renderer's `finish()`, which flushes and stops intercepting stdout. The block is therefore written after the summary on a terminal as it is when piped. The spec asserts that order in the piped case.
- **Other hook-error shapes**, run in a scratch fixture: a thrown string, `throw undefined`, a promise rejected with `null` (each prints the value as the error line, no name); an inner suite whose `beforeAll` throws inside an outer suite whose `afterAll` also throws (grouped under the inner suite, 2 tests); a suite where both `beforeAll` and `afterAll` throw (counted once, first error shown); a multi-line message (first line only).
- **`--bail 1`.** Tests in a file cut short by bail are not counted: their file has no hook error.
- **The recursive delete in the spec's `afterAll`.** The directory is a fresh one under the OS temp directory holding only the fixture files and whatever Vitest caches there; it has no `link:` junctions, so the hazard in `tickets/rules/sibling-repos.md` does not apply.
- **The implementer's two tests.** Both kept. The first pins the counting rule against real Vitest task states (the rule has four conditions and the fixture exercises each); the second pins "prints nothing on a run with no setup failure". Neither restates the implementation or checks a fake.
- **Docs.** Read the new section of `docs/testing.md` against the code: it states current behaviour only, and the example path (`src/scenarios/<file>.integration.ts`) matches the package's include globs. No other doc, script or workflow file in the repo passes `--reporter` for integration tests.
- **Types, size, comments.** No `any`; the reporter is about 110 lines of small functions; comments state constraints, not steps.

**Tripwires (not tickets)**

- A suite whose every test calls `ctx.skip()` at run time and whose `afterAll` throws is reported as not run. Already recorded by the implementer as an accepted-tradeoff `NOTE:` on `diedInSetup` and in the doc section; left alone.
- Comments in `packages/cadre-core/test/control-start-storage-op-budget.spec.ts` and `control-founding-consult-budget.spec.ts` tell the reader to pass `--reporter=verbose`. This only matters if `cadre-core` adopts the reporter; the doc's adoption bullet now says to remove such flags, which is where someone adopting it will read.

**Not done**

- The full integration suite was not run; the change affects reporting only. Watch mode (`test:watch`) was not tried; the handler runs once per run and holds no state between runs.
- No major findings, so no tickets were filed.

**Validation**

- `yarn workspace @serfab/integration-tests test setup-failure-reporter control-node-config` — 2 files, 15 tests passed, verbose lines present, no `NOT RUN` block.
- `yarn lint` and `yarn typecheck` at the root — both pass.
- The stale-build guard did not fire.
