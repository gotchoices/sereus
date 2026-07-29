description: The integration test suite has a setting meant to run test files one at a time so they don't fight over network ports, but the current test runner version ignores that setting entirely, so they run all at once and the setting is a lie.
files:
  - packages/integration-tests/vitest.config.ts
difficulty: easy
----

## What's wrong

`packages/integration-tests/vitest.config.ts` contains:

```ts
// Run sequentially by default - parallel can cause port conflicts
pool: 'forks',
poolOptions: {
  forks: {
    singleFork: true
  }
}
```

Vitest 4 **removed** `test.poolOptions` — every run prints:

```
DEPRECATED  `test.poolOptions` was removed in Vitest 4. All previous `poolOptions`
are now top-level options. Please, refer to the migration guide:
https://vitest.dev/guide/migration#pool-rework
```

So `singleFork: true` never takes effect. Observed directly: running two
scenario files together interleaves their test output, and the whole suite
takes 66s with the config as-is versus 368s when forced sequential with
`--no-file-parallelism`. The comment in the file describes behaviour the
project no longer has.

This also explains the TypeScript error an editor reports on that file
(`'poolOptions' does not exist in type 'InlineConfig'`).

## Why it matters

The setting was added deliberately because these scenarios bind real network
ports and start real libp2p nodes; running them concurrently risks port
collisions and cross-scenario interference. Right now nothing enforces the
isolation the comment promises, so any such flakiness looks random.

## What "fixed" looks like

The config expresses the intended isolation in a form Vitest 4 honours (the
migration guide's top-level replacement for `singleFork`), the deprecation
warning is gone, and the comment matches reality. If the project decides
parallel execution is actually fine, the opposite resolution is equally valid
— drop the setting and the comment rather than leave a directive that does
nothing.

## Note on scope

This was found while reviewing the stale-build guard, not caused by it. It is
**not** the cause of the currently-failing convergence scenarios: the same 9
tests fail identically with and without `--no-file-parallelism`, and those
failures are already tracked under the blocked ticket
`control-db-convergence-optimystic-p2p`.
