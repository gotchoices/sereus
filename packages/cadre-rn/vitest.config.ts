import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// The adapter's two native modules implement Node's own `crypto` and `buffer` APIs
		// over JSI, so under Node the real thing stands in for them: the spec exercises the
		// adapter's DER framing and output shapes, not a mock of anything this repo owns.
		alias: {
			'react-native-quick-crypto': 'node:crypto',
			'@craftzdog/react-native-buffer': 'node:buffer',
		},
	},
	test: {
		globals: true,
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		// Fails the run immediately when a dependency's dist predates its src, instead
		// of testing a stale build — see test/global-setup.ts.
		globalSetup: ['./test/global-setup.ts'],
	},
});
