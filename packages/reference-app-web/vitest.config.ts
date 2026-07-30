import { defineConfig } from 'vitest/config';

/**
 * Plain `node` environment: everything under `src/lib` this suite targets
 * (`node-local-slots.ts`) has no DOM/Svelte dependency — a hand-built fake
 * `OptimysticWebDBHandle` is enough, no real IndexedDB needed. Playwright specs
 * under `e2e/` are a separate harness (`test:e2e`), not part of this run.
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		// Fails the run immediately when @serfab/cadre-core's dist predates its src,
		// instead of testing a stale build — see test/global-setup.ts.
		globalSetup: ['./test/global-setup.ts'],
	},
});
