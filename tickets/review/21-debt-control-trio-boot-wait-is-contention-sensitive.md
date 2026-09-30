description: When an integration test file fails during its shared setup, the test runner counts every test in it as "skipped", so the summary line looks like nothing failed. Each integration run now ends with a block naming those tests as not run; this ticket reviews that addition.
architecture: docs/testing.md
files: test-harness/setup-failure-reporter.ts (new), test-harness/setup-failure-reporter.spec.ts (new), packages/integration-tests/vitest.config.ts, packages/integration-tests/package.json, docs/testing.md, AGENTS.md
----

# A suite that dies in setup no longer summarizes only as "skipped"

## What was built

`test-harness/setup-failure-reporter.ts` is a Vitest reporter (type-only imports from `vitest/node`, no runtime dependency). At the end of a run it prints one block to stdout, after Vitest's own summary, naming the tests that a failed `beforeAll` kept from running. It prints nothing when there are none and does not touch the exit code.

Real output, from a throwaway spec with a throwing `beforeAll` placed in `packages/integration-tests/test/` and run through `yarn workspace @serfab/integration-tests test <name>` (the file was deleted afterwards):

```
 Test Files  1 failed (1)
      Tests  1 skipped (1)
...
 NOT RUN  1 test did not run because a setup hook (beforeAll) failed. Count as failed, not skipped.
   test/zz-scratch-setup-failure.spec.ts > scratch setup failure — 1 test
     Error: scratch boot failed
```

The rule, as implemented:

- `diedInSetup(suite or module)`: its `state()` is `failed`, its `errors()` is non-empty, and no descendant test has state `passed` or `failed`.
- A test is counted when its state is `skipped`, its `options.mode` is `run`, and walking `parent` up to the module finds a container that died in setup. The count is grouped under the nearest such container.

Wiring:

- `packages/integration-tests/vitest.config.ts`: `reporters: ['verbose', '../../test-harness/setup-failure-reporter.ts']`.
- `packages/integration-tests/package.json`: `--reporter=verbose` removed from `test` and `test:debug`, because a command-line `--reporter` replaces the config's list and would drop the new reporter.
- `docs/testing.md`: new section "Tests that did not run", placed after the stale-build guard section. `AGENTS.md`: the one-line description of `test-harness/` now mentions the reporter.

Not touched: `packages/integration-tests/src/harness/control-trio.ts`, `wait-utils.ts`, the 45-second wait, its timeout and its message.

## Test added

`test-harness/setup-failure-reporter.spec.ts` — two tests, about 0.9 s together. It writes a fixture suite into a fresh directory under the OS temp directory, runs the real Vitest on it as a child process with the reporter named by absolute path, and asserts on stdout.

- *counts the tests under a failed beforeAll, and no other skipped test* — exit code 1; the block starts after `Test Files`; the heading says 3 tests; `suite-setup.spec.mjs > setup throws — 2 tests` with `Error: suite boot failed`; `module-setup.spec.mjs — 1 test` with `Error: module boot failed`; the block does not name `teardown.spec.mjs` (throwing `afterAll`, one passing test, one `ctx.skip()`, one `it.skip`) or `plain.spec.mjs` (one passing test, one `it.skip`).
- *prints nothing when no setup failed* — running only `plain.spec.mjs` exits 0 and stdout has no `NOT RUN`.

## Where the implementation differs from the plan ticket

- **Locating the Vitest binary.** The plan said `createRequire(import.meta.url).resolve('vitest/vitest.mjs')`. Vitest's `exports` map does not expose that path, so the spec resolves `vitest/package.json` (which is exported) and joins `vitest.mjs` to its directory.
- **Fixture file 1 has two additions.** Its second counted test sits in a nested `describe`, so the spec pins the walk up to the outer suite. It also holds an `it.skip`, which must stay out of the count; without it no fixture exercised the `mode === 'run'` condition, because every other static skip sits under a suite that did not die. The expected count for that file is still 2.
- **Heading wording.** "did not run because a setup hook (beforeAll) failed. Count as failed, not skipped." rather than "their suite's setup failed", because a module-level hook has no suite. The literal `NOT RUN`, the count, the file path and the error's first line are all present as required.

## Validation run

- `yarn workspace @serfab/integration-tests test setup-failure-reporter control-node-config` — 2 files, 15 tests passed; verbose per-test lines present with no `--reporter` flag; no `NOT RUN` block.
- Throwaway failing spec through the package's `test` script — block printed as shown above, exit code 1. This also confirms the relative reporter path in the config loads.
- `yarn workspace @serfab/integration-tests test relay-round-trip-measure` without `RELAY_RRT_MEASURE` — 4 skipped, no `NOT RUN` block.
- `yarn typecheck` and `yarn lint` at the root — both exit 0.
- The stale-build guard did not fire during any of these runs.

Checked by hand in a scratch fixture outside the repo (deleted), not in the spec:

- An inner suite whose `beforeAll` times out, inside an outer suite with a passing test and a `ctx.skip()` test: only the inner suite's one runnable test is counted; the inner `it.skip` and the outer tests are not. Error line was `Error: Hook timed out in 50ms.`
- A file with an import that does not resolve: counted under `Test Files … failed`, absent from the block.
- `describe.skipIf(true)` around a throwing `beforeAll`: not counted.
- A multi-line error message: only its first line is printed.

## Known gaps — start here

- **The full integration suite was not run**, as the plan allowed. Nothing in the change affects test execution, only reporting.
- **Terminal (TTY) rendering was not looked at.** Every run above had stdout piped. On a terminal Vitest's `verbose` reporter uses a live summary that rewrites the screen; the block is written after that reporter's end-of-run handler returns, but nobody has looked at the result on a real terminal.
- **Watch mode (`test:watch`) was not tried.** The end-of-run handler runs on each re-run, so the block should print each time.
- **Block order** follows the order Vitest hands the modules to the reporter, which is not always the order the files ran in.
- **`firstErrorLine` has a fallback (`no error recorded`) that cannot be reached**, since a container only gets there with a non-empty `errors()`. It exists to satisfy the index-access type check. A reviewer may prefer a different shape.
- **The accepted ambiguity is recorded as a `NOTE:` on `diedInSetup`**: a suite whose every test calls `ctx.skip()` at run time and whose `afterAll` throws is reported as not run. No suite in the repo has that shape (not searched exhaustively; taken from the plan ticket).
- **`beforeEach` failures** are not handled and should not need to be: a throwing `beforeEach` fails the test rather than skipping it. By reading Vitest's behaviour, not by a run.
- **Only `integration-tests` lists the reporter.** The other packages with suites still summarize a failed `beforeAll` as skipped. Adopting it is one config line each, plus removing any `--reporter` flag from their scripts; that was out of scope here.
- **Comments in `packages/cadre-core/test/control-start-storage-op-budget.spec.ts` and `control-founding-consult-budget.spec.ts` tell the reader to pass `--reporter=verbose`.** That is cadre-core, which does not list the reporter, so nothing is lost today; it would matter if cadre-core adopts it.

## Use cases for review

- Run any single integration file through `yarn workspace @serfab/integration-tests test <file>` and through `yarn workspace @serfab/integration-tests exec vitest run <file>`: verbose lines, no block on a green run.
- Make a scenario's `beforeAll` throw temporarily: the block names the file, the suite, the number of tests and the error's first line, and the exit code is 1.
- Run with `--reporter=dot`: no block (documented).
- Read the new `docs/testing.md` section against the code and check it states current behaviour only.
