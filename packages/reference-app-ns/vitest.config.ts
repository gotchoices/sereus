import { defineConfig } from 'vitest/config';

/**
 * Unit suite for `reference-app-ns`.
 *
 * `environment: 'node'` — nothing collected here touches a NativeScript view or
 * imports `@nativescript/core`; both suites are plain module logic
 * (`src/node-local-slots.ts`, `src/cadre-phone.ts`) reachable under bare Node.
 *
 * `globalSetup` runs the stale-build guard because those suites execute real,
 * non-mocked compiled output from `@serfab/cadre-core` (and, through it, the
 * linked `@optimystic/*` and `@quereus/quereus` siblings) — see
 * `test/global-setup.ts`.
 *
 * The NativeScript-coupled modules (pages, view models, `ns-storage.ts`) are not
 * unit-targeted here; they run under `test:bundle` and the on-device e2e harness
 * (`scripts/run-e2e.mjs`).
 */
export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.spec.ts'],
		globalSetup: ['./test/global-setup.ts'],
	},
});
