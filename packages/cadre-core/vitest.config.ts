import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Fails the run immediately when a dependency's dist predates its src, instead
    // of testing a stale build — see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    coverage: { reporter: ['text', 'html'] }
  }
})
