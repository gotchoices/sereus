import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.spec.ts',
      'src/**/*.integration.ts',
      // The stale-build guard lives at the repo root (shared with other packages'
      // suites) and is outside every package's own test globs, so this suite —
      // where it started life — keeps running its unit tests explicitly.
      '../../test-harness/**/*.spec.ts',
    ],
    // Fails the run immediately when a cadre package's dist predates its src,
    // instead of testing a stale build — see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // Integration tests can be slow - give them time
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run sequentially - parallel can cause port conflicts.
    // Vitest 4 removed `test.poolOptions`; the top-level replacement for
    // `forks.singleFork` is fileParallelism: false — one test file at a time.
    // (Each file still gets its own fork; `isolate` stays default-true.)
    // vitest.config.ts is in tsconfig.typecheck.json, so a future option
    // removal fails `yarn typecheck` instead of being silently ignored.
    pool: 'forks',
    fileParallelism: false,
    // Increase reporter verbosity
    reporters: ['verbose'],
    coverage: { 
      reporter: ['text', 'html'],
      exclude: ['**/fixtures/**']
    }
  }
})

