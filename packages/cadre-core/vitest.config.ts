import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Fails the run immediately when a dependency's dist predates its src, instead
    // of testing a stale build — see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // These specs boot a real CadreNode and drive a real control database, so a
    // single test routinely costs seconds — and more when 80+ files run in
    // parallel. Vitest's 5s/10s defaults are unit-suite budgets: they made every
    // slow-enough test bolt on its own `}, 30_000)` override, and left the rest
    // as latent under-load flakes. Budget the suite once, at the profile the
    // sibling network suites already use.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { reporter: ['text', 'html'] }
  }
})
