import { defineConfig } from 'vitest/config';

/**
 * Two test projects, so the stale-build guard only gates the tests that run another
 * package's `dist`:
 *
 *  - **node** — the Noise crypto adapter, which runs `@optimystic/db-p2p`'s compiled
 *    output and so carries the guard.
 *
 *  - **polyfills** — the runtime polyfills under `polyfills/`. They read no sibling
 *    `dist`, so this project has no guard and `vitest run --project polyfills` stays
 *    runnable while a sibling is unbuilt.
 */
export default defineConfig({
	test: {
		projects: [
			{
				resolve: {
					// The adapter's two native modules implement Node's own `crypto` and `buffer`
					// APIs over JSI, so under Node the real thing stands in for them: the spec
					// exercises the adapter's DER framing and output shapes, not a mock of anything
					// this repo owns.
					alias: {
						'react-native-quick-crypto': 'node:crypto',
						'@craftzdog/react-native-buffer': 'node:buffer',
					},
				},
				test: {
					name: 'node',
					globals: true,
					environment: 'node',
					include: ['test/**/*.spec.ts'],
					exclude: ['test/polyfills/**'],
					// Fails the run immediately when a dependency's dist predates its src, instead
					// of testing a stale build — see test/global-setup.ts.
					globalSetup: ['./test/global-setup.ts'],
				},
			},
			{
				test: {
					name: 'polyfills',
					environment: 'node',
					include: ['test/polyfills/**/*.spec.ts'],
				},
			},
		],
	},
});
