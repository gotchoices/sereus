import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.integration.ts'],
    // Fails the run immediately when a cadre package's dist predates its src,
    // instead of testing a stale build — see src/global-setup.ts.
    globalSetup: ['./src/global-setup.ts'],
    // Integration tests can be slow - give them time
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Run sequentially by default - parallel can cause port conflicts.
    // Vitest 4 removed `test.poolOptions`; singleFork's replacement is
    // top-level fileParallelism: false (one fork, files run one at a time).
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

