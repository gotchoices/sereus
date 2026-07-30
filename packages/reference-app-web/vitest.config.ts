import { defineConfig } from 'vitest/config';

/**
 * Single `node` project: everything under `src/lib` this suite targets
 * (`node-local-slots.ts`) has no DOM/React/Svelte dependency — a plain node
 * environment with a hand-built fake `OptimysticWebDBHandle` is enough, no
 * real IndexedDB needed. Playwright specs under `e2e/` are a separate harness
 * (`test:e2e`), not part of this vitest run.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: 'node',
					environment: 'node',
					include: ['test/**/*.spec.ts'],
				},
			},
		],
	},
});
