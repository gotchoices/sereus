import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit suite for `reference-app-ns`.
 *
 * `environment: 'node'` — nothing collected here touches a NativeScript view.
 * The three view-model suites (`cadre-vm.spec.ts`, `settings-view-model.spec.ts`,
 * `chat-vm.spec.ts`) do import `@nativescript/core`, but only for `Observable`
 * and `ObservableArray`; the alias below redirects that specifier to
 * `test/stubs/nativescript-core.ts`, which re-exports the real classes from the
 * submodules that load here. Everything else collected here
 * (`src/node-local-slots.ts`, `src/cadre-phone.ts`, `src/ns-storage.ts`) is plain
 * module logic once `@optimystic/db-p2p-storage-ns` is mocked.
 *
 * `globalSetup` runs the stale-build guard because these suites execute real,
 * non-mocked compiled output from `@serfab/cadre-core` (and, through it, the
 * linked `@optimystic/*` and `@quereus/quereus` siblings) — see
 * `test/global-setup.ts`. The chat suite also runs `src/chat-operations.ts`
 * against a real in-memory Quereus `Database` carrying the app's chat schema.
 *
 * The remaining NativeScript-coupled modules (the pages) are not unit-targeted
 * here; they run under `test:bundle` and the on-device e2e harness
 * (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
	resolve: {
		alias: [
			{
				// Anchored regex, NOT a plain string `find`: Vite treats a string as a
				// prefix, so `'@nativescript/core'` would also match every
				// `@nativescript/core/...` subpath — including the stub's own deep
				// imports of `data/observable*`, which would then resolve back into the
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
