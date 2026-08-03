import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit suite for `reference-app-ns`.
 *
 * `environment: 'node'` — nothing collected here touches a NativeScript view.
 * The two view-model suites (`cadre-vm.spec.ts`, `settings-view-model.spec.ts`)
 * do import `@nativescript/core`, but only for `Observable`; the alias below
 * redirects that specifier to `test/stubs/nativescript-core.ts`, which re-exports
 * the real class from the one submodule that loads under bare Node. Everything
 * else collected here (`src/node-local-slots.ts`, `src/cadre-phone.ts`) is plain
 * module logic with no platform coupling.
 *
 * `globalSetup` runs the stale-build guard because these suites execute real,
 * non-mocked compiled output from `@serfab/cadre-core` (and, through it, the
 * linked `@optimystic/*` and `@quereus/quereus` siblings) — see
 * `test/global-setup.ts`.
 *
 * The remaining NativeScript-coupled modules (pages, `chat-vm.ts`,
 * `ns-storage.ts`) are not unit-targeted here; they run under `test:bundle` and
 * the on-device e2e harness (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				// Anchored regex, NOT a plain string `find`: Vite treats a string as a
				// prefix, so `'@nativescript/core'` would also match every
				// `@nativescript/core/...` subpath — including the stub's own deep
				// import of `data/observable`, which would then resolve back into the
				// stub. That cycle fails without naming its cause.
				find: /^@nativescript\/core$/,
				replacement: fileURLToPath(new URL('./test/stubs/nativescript-core.ts', import.meta.url)),
			},
		],
	},
	test: {
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		globalSetup: ['./test/global-setup.ts'],
	},
});
