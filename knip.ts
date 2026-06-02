import type { KnipConfig } from 'knip';

/**
 * Root knip config (Option A from the build-health ticket): one config covering
 * every Yarn workspace. `yarn dep-check` runs `knip` from the repo root.
 *
 * knip auto-detects each workspace from the root `package.json` `workspaces`
 * field and derives entry points from each package's `main`/`bin`/`exports`
 * plus its tool plugins (vitest, vite, svelte, playwright). We only add config
 * where that auto-detection needs help.
 *
 * Gate semantics: the `dep-check` gate exists to catch dependency drift —
 * unused, missing (phantom), and unresolved deps/binaries. Those rules are
 * `error` (they fail the gate). Dead-code rules (unused files / exports /
 * types) are downgraded to `warn` so they surface without blocking the gate;
 * cleaning the existing dead-code backlog across the reference apps and host UI
 * is deliberately out of scope for this ticket (see docs/STATUS.md).
 *
 * Cross-platform: all file discovery is config-driven (no shell globs on the
 * CLI), so the gate runs identically under PowerShell and POSIX shells.
 */
const config: KnipConfig = {
	// `ncu` (npm-check-updates) and `eas` (eas-cli) are invoked by convenience
	// scripts but are global/CI tools, not declared deps — don't flag them.
	ignoreBinaries: ['ncu', 'eas'],

	workspaces: {
		// Root workspace: ignore non-package trees. tess/ is the vendored ticket
		// runner, ops/ is infra tooling, docs/ is documentation, and scripts/ are
		// release helpers — none are part of the nine product workspaces this gate
		// guards.
		'.': {
			ignore: ['tess/**', 'ops/**', 'docs/**', 'scripts/**'],
		},

		'packages/cadre-cli': {},
		'packages/cadre-core': {},

		'packages/cadre-host': {
			// Build/signing helpers run via `node scripts/*.mjs`, not imported
			// (the bin entry is auto-detected from package.json).
			entry: ['scripts/*.mjs'],
			ignoreDependencies: [
				// Loaded lazily via dynamic `import()` / runtime `require` so the
				// node can degrade gracefully when they're absent — knip can't see
				// the string-literal specifiers.
				'@achingbrain/nat-port-mapper',
				'qrcode-terminal',
				// Resolved at runtime via `req.resolve('@serfab/cadre-cli/bin/cadre.js')`
				// to spawn the CLI as a child process; never statically imported.
				'@serfab/cadre-cli',
				// Svelte toolchain for the embedded host UI: `@tsconfig/svelte` is
				// referenced from tsconfig `extends`, `svelte-check` is run ad hoc.
				'@tsconfig/svelte',
				'svelte-check',
			],
		},

		'packages/cadre-provider': {},

		'packages/integration-tests': {
			// Quereus plugins are registered by name at runtime; cadre-core pulls
			// this in transitively, but it's listed here for explicit test setup.
			ignoreDependencies: ['@optimystic/quereus-plugin-optimystic'],
		},

		'packages/quereus-plugin-sereus': {},

		'packages/reference-app-rn': {
			// Expo / React Native framework-implicit deps: the Metro bundler and
			// Babel toolchain consume these without an explicit import, and the
			// Expo runtime resolves `expo-updates` / `@expo/vector-icons` from
			// app.json + native config rather than from a static import knip sees.
			ignoreDependencies: [
				'@babel/core',
				'@babel/runtime',
				'@optimystic/db-p2p',
				'buffer',
				'@expo/vector-icons',
				'expo-updates',
				'@types/babel__core',
			],
		},

		'packages/reference-app-web': {
			// Vite-config-implicit deps: `@multiformats/multiaddr` (dedupe),
			// `readable-stream` / `buffer` (resolve aliases + optimizeDeps), plus
			// `@optimystic/db-core` / `@quereus/quereus` / `idb` which are pulled
			// transitively through `@optimystic/db-p2p` / `@serfab/cadre-core` in
			// the browser bundle. Svelte tooling (`@tsconfig/svelte`,
			// `svelte-check`, `@types/readable-stream`) is config/CLI-driven.
			ignoreDependencies: [
				'@multiformats/multiaddr',
				'@optimystic/db-core',
				'@quereus/quereus',
				'buffer',
				'idb',
				'readable-stream',
				'svelte-check',
				'@types/readable-stream',
			],
		},

		'packages/strand-proto': {
			// Manual dial/listen smoke scripts, run by hand, not from a test runner
			// (the bootstrap entry is auto-detected from package.json).
			entry: ['test/manual/*.ts'],
		},
	},

	rules: {
		files: 'warn',
		exports: 'warn',
		types: 'warn',
		nsExports: 'warn',
		nsTypes: 'warn',
		enumMembers: 'warn',
		duplicates: 'warn',
	},
};

export default config;
