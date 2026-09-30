description: When an integration test file fails during its shared setup, the test runner counts every test in it as "skipped", so the summary line looks like nothing failed. Add a line to the end of each run that names those tests as not run, so a release decision is never made from a summary that hides them.
architecture: docs/testing.md
files: test-harness/setup-failure-reporter.ts (new), test-harness/setup-failure-reporter.spec.ts (new), packages/integration-tests/vitest.config.ts, packages/integration-tests/package.json, docs/testing.md, packages/integration-tests/src/harness/control-trio.ts (read only — do not change the wait)
difficulty: medium
----

# A suite that dies in setup must not summarize as "skipped"

## What is left of the original ticket, and what is not

The original ticket had three arms. Two are closed and need no work here:

- **The 45-second wait in `bootControlTrio` timing out.** The cause was an upstream defect, fixed in optimystic `03ffadc4` (see `tickets/complete/control-peer-row-refresh-invisible-to-third-node.md`). The comment at step 6 of `packages/integration-tests/src/harness/control-trio.ts` already says a timeout there is now a regression to report and that the timeout must not be widened. Leave the wait, its timeout and its message exactly as they are.
- **Heavy files running beside each other.** `packages/integration-tests/vitest.config.ts` already sets `fileParallelism: false`, so one scenario file runs at a time. There is nothing to group.

The remaining arm is the reporting one, and it is general: it applies to any test file whose `beforeAll` throws, not only to the two control-trio files.

## The defect, measured (2026-09-30, vitest 4.1.8, a scratch suite outside the repo)

A file whose `describe` has a `beforeAll` that throws, plus a second file with one passing test and one `it.skip`, reports:

```
 Test Files  1 failed | 1 passed (2)
      Tests  1 passed | 3 skipped (4)
```

The process exits 1 and a `Failed Suites 1` block prints the hook's error, so the run is already red to a script. The trap is the `Tests` line, which is the line people copy into tickets (`tickets/.pre-existing-known.md` has several entries of the form `2 failed / 246 passed / 7 skipped`). It lumps tests that never ran together with tests someone deliberately skipped, and shows no `failed` count at all for them.

Vitest's JSON reporter has the same shape: the file's `status` is `failed`, each of its tests is `skipped`, `numFailedTests` is 0.

## Design (settled)

Add a small vitest reporter that runs alongside the existing `verbose` reporter and, at the end of the run, prints one block naming the tests that did not run because their setup failed. It prints nothing when there are none. It does not change the exit code (already 1) and does not replace or re-order vitest's own summary.

Rejected alternatives:

- *Turn each `beforeAll` into a first test so the boot shows up as a failed test.* 18 scenario files use `beforeAll`; this would have to be repeated in each and in every future one, and the following tests would then run against a half-booted fixture and fail with unrelated errors.
- *A post-run script that parses the JSON report.* It would only run for whoever remembers to call it; the reporter runs on every invocation, including `yarn workspace @serfab/integration-tests exec vitest run <file>`.

### Where it lives

`test-harness/setup-failure-reporter.ts`, default-exporting a class that implements vitest's `Reporter` (`import type { Reporter, TestModule, TestSuite, TestCase } from 'vitest/node'` — type-only imports, so the file has no runtime dependency). `test-harness/` is the shared, never-built directory other packages already import by relative path; placing it there lets another package adopt it later with one config line. Wire it into `packages/integration-tests` only in this ticket. `test-harness/**/*.ts` is already inside that package's `tsconfig.typecheck.json`, so `yarn typecheck` covers it.

### The rule for "did not run because setup failed"

Verified against the real vitest 4.1.8 reporter API with a throwaway reporter:

| case | `test.result().state` | `test.options.mode` | enclosing suite/module |
| --- | --- | --- | --- |
| suite `beforeAll` throws | `skipped` | `run` | suite `state()` is `failed`, `errors()` non-empty |
| module-level `beforeAll` throws | `skipped` | `run` | module `state()` is `failed`, `errors()` non-empty |
| `it.skip` | `skipped` | `skip` | — |
| `ctx.skip()` inside a test whose suite's `afterAll` throws | `skipped` | `run` | suite is `failed` with errors, **but a sibling test has state `passed`** |

So `mode` separates deliberate static skips, but not a runtime `ctx.skip()` under a suite whose *teardown* failed. The rule is therefore:

A suite or module **died in setup** when its `state()` is `failed`, its `errors()` is non-empty, and none of its descendant tests (`children.allTests()`) has state `passed` or `failed`. A test is **not run** when its state is `skipped`, its `options.mode` is `run`, and some ancestor (walk `test.parent`, then `suite.parent`, up to the module) died in setup.

Decompose into small functions: one that decides whether a suite/module died in setup, one that finds a test's nearest such ancestor, one that formats the block. The `onTestRunEnd(testModules)` method only collects and prints.

### Output

Printed after vitest's own summary (list the reporter after `'verbose'`), grouped by the suite that died, using `module.relativeModuleId` and the suite's `fullName`, and carrying the first line of the hook's error so the reader does not have to scroll up to the `Failed Suites` block:

```
 NOT RUN  7 tests did not run because their suite's setup failed. Count them as failed, not skipped.
   src/scenarios/control-write-degraded-cohort-member.integration.ts > control writes with a connected-but-degraded cohort member (forced 3-peer cohort) — 7 tests
     Error: Timeout waiting for B resolves C's signed CadrePeer address record
```

Write with `console.log`/`process.stdout.write` from the reporter (reporters run in the main process, so the output is not swallowed by a recycled worker). Exact wording and colour are the implementer's; the block must contain the literal `NOT RUN`, the count, the file path and the error's first line.

### Wiring

- `packages/integration-tests/vitest.config.ts`: `reporters: ['verbose', '../../test-harness/setup-failure-reporter.ts']`.
- `packages/integration-tests/package.json`: remove `--reporter=verbose` from the `test` and `test:debug` scripts. A `--reporter` flag on the command line replaces the config's `reporters` list, so leaving it would drop the new reporter from the one command `yarn test` runs. The config already selects `verbose`. Confirm by running one small file through `yarn workspace @serfab/integration-tests test <file>` and seeing verbose per-test lines.

### Documentation

Add a headed section to `docs/testing.md` (its own `##` section, placed after "Stale-build guard"; do not append to an existing bullet). State, as current behaviour: vitest counts tests under a failed setup hook as skipped; the `NOT RUN` block is what separates them from deliberate skips; when recording a run's result in a ticket, quote the `NOT RUN` count as failures; a developer running vitest with their own `--reporter` flag loses the block. No history of how it was found.

## Test

One spec, `test-harness/setup-failure-reporter.spec.ts` (already collected by the integration-tests config's `../../test-harness/**/*.spec.ts` glob). It pins the branching rule above against the real vitest, since a hand-built fake of vitest's task objects could drift from the state values the rule depends on.

It writes a fixture into a fresh `fs.mkdtemp(os.tmpdir() + …)` directory, runs vitest on it as a child process (`process.execPath` plus the path from `createRequire(import.meta.url).resolve('vitest/vitest.mjs')`, with `--root <tmp> --config <tmp>/vitest.config.mjs`, the config naming the reporter by absolute path and setting `globals: true` so fixture files need no imports), and asserts on stdout. Fixture files must be written at run time, not committed as `*.spec.ts` under `test-harness/`, or the outer run would collect them and go red.

Fixture and expected result:

- file 1: `describe` with a throwing `beforeAll` and two tests → both counted;
- file 2: module-level throwing `beforeAll` and one test → counted;
- file 3: `describe` with a throwing `afterAll`, one passing test, one `ctx.skip()` test, one `it.skip` → none counted;
- file 4: one passing test and one `it.skip` → none counted.

Expected: exit code 1; stdout contains `NOT RUN` with a count of 3, names files 1 and 2 and their hook error text, and does not name files 3 or 4. A second, smaller assertion: with only file 4, stdout does not contain `NOT RUN`.

Remove the temp directory afterwards with a plain recursive delete — it is under the OS temp directory and holds no `node_modules`, so the junction hazard in `tickets/rules/sibling-repos.md` does not apply. Do not create the fixture anywhere inside the repo.

## Edge cases & interactions

- **Teardown failure is not setup failure.** A suite whose `afterAll` throws is `failed` with errors, but its tests ran. Covered by fixture file 3 (test).
- **Nested suites.** When an outer `beforeAll` throws, the inner suites are not themselves `failed`; the ancestor walk must reach the outer suite. When an inner suite dies and the outer has other passing tests, only the inner suite's tests are counted, because the "no descendant passed or failed" check is evaluated per ancestor. Verify by inspection of the walk; file 1 and 2 cover the one-level cases.
- **Accepted ambiguity.** A suite in which every test calls `ctx.skip()` at run time *and* whose `afterAll` throws is indistinguishable from a setup failure and will be reported as not run. No scenario in the repo has that shape. Record it as a `// NOTE:` at the function that decides "died in setup".
- **A file that fails to import at all** (syntax error, missing module) has no tests to list; vitest already reports it under `Failed Suites` and `Test Files … failed`. The reporter prints nothing for it. By inspection.
- **Filtered and opt-in runs.** Suites skipped through `describe.skipIf` / environment switches (`RELAY_RRT_MEASURE`, `REATTACH_SYNC_MEASURE`, `RELAY_DIAL_COST`) have tests with mode `skip` and no failed ancestor, so they are never counted. `-t` name filters likewise mark unmatched tests as skipped by mode. Spot-check by running `relay-round-trip-measure` without its variable and seeing no `NOT RUN` block.
- **`retry` and `it.fails`.** Neither produces a `skipped` state; unaffected. By inspection.
- **Command-line `--reporter` overrides the config list.** The package scripts are changed for this reason; the doc section says so for ad-hoc runs.
- **Reporter file is loaded by path from the config.** A typo in the path fails the run at startup rather than silently dropping the reporter; confirm once by running any single file.
- **Type-check and lint gates.** The new files sit under `test-harness/`, inside the integration-tests typecheck program and the root ESLint config; `yarn typecheck` and `yarn lint` must pass. No `any`; the walk over `TestSuite | TestModule` parents is typed by vitest's own discriminant (`type === 'suite' | 'module'`).
- **The diagnostic text of the step-6 wait** ("B resolves C's signed CadrePeer address record") is quoted by completed tickets and by `tickets/.pre-existing-known.md`. This ticket does not touch `control-trio.ts` or `wait-utils.ts`.
- **Sibling repositories.** Nothing here needs `../optimystic`, `../quereus` or `../Fret` built or touched. If the stale-build guard reports a sibling `dist` as stale while running the spec, stop and record it in the handoff; do not build the sibling.

## Validation

- `yarn workspace @serfab/integration-tests exec vitest run ../../test-harness/setup-failure-reporter.spec.ts` (or the equivalent filter) — green.
- `yarn workspace @serfab/integration-tests test control-node-config` — verbose lines present, no `NOT RUN` block.
- `yarn typecheck` and `yarn lint`.
- The full integration suite is long; a full run is not required for this change. Do not repeat the original ticket's "three full runs" step — the timing arm it was checking is closed upstream.

## TODO

- Write `test-harness/setup-failure-reporter.ts` per the rule and output above, with the accepted-ambiguity `NOTE:`.
- Add it to `packages/integration-tests/vitest.config.ts` after `'verbose'`, with a short comment saying why it is there.
- Drop `--reporter=verbose` from the `test` and `test:debug` scripts in `packages/integration-tests/package.json`.
- Write `test-harness/setup-failure-reporter.spec.ts` with the four-file fixture.
- Add the section to `docs/testing.md`.
- Run the validation commands; hand off to review stating which were run.
