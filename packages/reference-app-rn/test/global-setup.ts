/**
 * Vitest global setup — runs once before the `node` project of the
 * reference-app-rn unit suite.
 *
 * `node-local-slots.spec.ts` composes `kvSlot`/`secureStoreSlot` with the REAL
 * `PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore`,
 * `secure-key-store.spec.ts` throws the real `KeyStoreAccessError`, and
 * `push-wake.spec.ts` reaches `STRAND_WAKE_TYPE` through `src/push-wake.ts` —
 * all runtime values from `@serfab/cadre-core`, which reaches `node_modules` as
 * a symlink whose manifest points at `dist`. That entry point in turn imports
 * the `@optimystic/*` and `@quereus/quereus` packages linked in from their
 * sibling checkouts. So an edit to any of their `src` with no following build
 * is invisible here: the suite runs the previous build and reports green about
 * behaviour it never executed. Fail the run up front instead — the same guard
 * `cadre-core` and `reference-app-web` use (`test-harness/build-freshness.ts`).
 *
 * This package sets `installConfig.hoistingLimits: "workspaces"`, so its copies
 * of the `@optimystic/*` / `@quereus/*` siblings live in its own `node_modules`
 * rather than the repo root's — the guard resolves `linked` targets by walking
 * the `node_modules` chain up from this file's directory, reaching those local
 * copies first.
 *
 * Only the `node` vitest project uses this: `test/react/use-cadre.spec.ts`
 * mocks `@serfab/cadre-core` out via `vi.mock` and never loads real compiled
 * output, so the `react` project has no need for this check.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 *
 * Wider than those `dependencies`, deliberately: importing `@serfab/cadre-core`'s
 * entry point evaluates modules that statically import
 * `@serfab/quereus-plugin-sereus` and the two `@optimystic/quereus-plugin-*`
 * packages. This suite therefore runs their compiled output too, without
 * declaring any of them.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p-storage-rn', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
