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
