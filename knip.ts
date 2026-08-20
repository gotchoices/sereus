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
 * is deliberately deferred (see docs/testing.md → "Dependency-check coverage").
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
		// release + gate helpers — none are part of the nine product workspaces
		// this gate guards. test-harness/ is *not* ignored: its `vitest` import
		// now resolves against the root manifest (root declares vitest for
		// scripts/check-test-file-typecheck-coverage.mjs), so ignoring it draws a
		// "Remove from ignore" configuration hint and buys nothing.
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
			],
		},

		'packages/cadre-provider': {},

		'packages/integration-tests': {
			ignoreDependencies: [
				// Quereus plugins are registered by name at runtime; cadre-core pulls
				// this in transitively, but it's listed here for explicit test setup.
				'@optimystic/quereus-plugin-optimystic',
				// Same reason as cadre-host above: the harness resolves the CLI's bin
				// via `req.resolve('@serfab/cadre-cli/bin/cadre.js')` to spawn it as a
				// child process (src/harness/provider-process-orchestrator.ts); never
				// statically imported.
				'@serfab/cadre-cli',
			],
		},

		'packages/quereus-plugin-sereus': {},

		'packages/reference-app-ns': {
			// NativeScript resolves page modules by string, not by import: app-root.xml
			// names `chat/chat-page` in `defaultPage` and Settings is reached via a
			// runtime `Frame.topmost()?.navigate('settings/settings-page')` — no static
			// import exists for knip to follow, so each page (and the whole `src/` graph
			// behind it) needs to be an entry. The polyfill/shim files are reached only
			// through webpack (`resolve.fallback` for the node-* polyfills,
			// `NormalModuleReplacementPlugin` for the shims — see webpack.config.js),
			// `nativescript.config.ts` is read by the `ns` CLI, and `solo-smoke.ts` is a
			// manual on-device helper with no importer.
			// NOTE: `app/**/*-page.ts` is load-bearing — a page added under another
			// name falls outside it, and knip then silently under-analyses the `src/`
			// graph behind that page without turning the gate red. If page naming ever
			// diverges from the `*-page.ts` convention, list the pages explicitly.
			entry: [
				'app/**/*-page.ts',
				'nativescript.config.ts',
				'src/polyfills/node-*.ts',
				'src/shims/*.js',
				'src/solo-smoke.ts',
			],
			// The NativeScript CLI is a globally-installed tool, like `ncu` / `eas`.
			ignoreBinaries: ['ns'],
			ignoreDependencies: [
				// NativeScript toolchain: `@nativescript/android` is the native platform
				// runtime consumed by `ns prepare android`, never imported.
				'@nativescript/android',
				// webpack-config-implicit: `esbuild-loader` is named by string in a
				// webpack-chain `.loader()` call, which knip's webpack plugin can't read;
				// `util` resolves straight to the npm package for transitive deps that
				// import it (externalsPresets.node:false).
				'esbuild-loader',
				'util',
				// Node built-in name, so knip won't treat the bare `buffer` import in
				// src/polyfills/buffer-global.ts as a package — same ignore as the rn and
				// web apps carry.
				'buffer',
			],
		},

		'packages/reference-app-rn': {
			// Expo / React Native framework-implicit deps: the Metro bundler and
			// Babel toolchain consume these without an explicit import, and the
			// Expo runtime resolves `expo-updates` / `@expo/vector-icons` from
			// app.json + native config rather than from a static import knip sees.
			ignoreDependencies: [
				'@babel/core',
				'@babel/runtime',
				'buffer',
				'@expo/vector-icons',
				'expo-updates',
				'@types/babel__core',
			],
		},

		'packages/reference-app-web': {
			// Vite-config-implicit deps: `readable-stream` / `buffer` (resolve
			// aliases + optimizeDeps), plus `@optimystic/db-core` / `idb` which are
			// pulled transitively through `@optimystic/db-p2p` / `@serfab/cadre-core`
			// in the browser bundle. `@types/readable-stream` is types-only.
			ignoreDependencies: [
				'@optimystic/db-core',
				'buffer',
				'idb',
				'readable-stream',
				'@types/readable-stream',
			],
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
