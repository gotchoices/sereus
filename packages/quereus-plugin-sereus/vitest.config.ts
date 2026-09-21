import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		coverage: { reporter: ['text', 'html'] },
		projects: [
			{
				test: {
					name: 'unit',
					globals: true,
					environment: 'node',
					include: ['test/**/*.spec.ts'],
					exclude: ['test/e2e/**'],
					globalSetup: ['./test/global-setup.ts'],
					// `browser-shape.spec.ts` imports the prebuilt browser bundle. Left to
					// vitest, that multi-megabyte file goes through Vite's transform (and its
					// larger source map is read) on every run; Node loads it directly instead.
					// Matched by path: if the artifact is renamed or moved this stops applying
					// with no failure, and the test just gets slow again.
					server: { deps: { external: [/dist[\\/]plugin-browser\.js$/] } },
				},
			},
			{
				test: {
					name: 'e2e',
					globals: true,
					environment: 'node',
					include: ['test/e2e/**/*.spec.ts'],
					testTimeout: 60_000,
					globalSetup: ['./test/global-setup.ts'],
				},
			},
		],
	},
})
