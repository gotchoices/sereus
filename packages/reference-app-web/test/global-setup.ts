/**
 * Vitest global setup — runs once before the whole reference-app-web unit suite.
 *
 * `node-local-slots.spec.ts` runs the REAL `createOwnerKey` and
 * `loadOrCreateIdentityKey` over the tab's key store, and
 * `@serfab/cadre-core` reaches `node_modules` as a symlink whose manifest points
 * at `dist`. That entry point in turn imports the `@optimystic/*` and
 * `@quereus/quereus` packages linked in from their sibling checkouts. So an edit
 * to any of their `src` with no following build is invisible here: the suite
 * runs the previous build and reports green about a load policy it never
 * executed. Fail the run up front instead — the same guard `cadre-core` and
 * `integration-tests` use (`test-harness/build-freshness.ts`).
 *
 * This package sets `installConfig.hoistingLimits: "workspaces"`, so its copies
 * of the `@optimystic/*` / `@quereus/*` siblings live in its own `node_modules`
 * rather than the repo root's — the guard resolves `linked` targets by walking
 * the `node_modules` chain up from this file's directory, reaching those local
 * copies first.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 *
 * Wider than those `dependencies`, deliberately: importing `@serfab/cadre-core`'s
 * entry point evaluates `cadre-node.js`, `control-database.js` and
 * `strand-database.js`, which statically import `@serfab/quereus-plugin-sereus`
 * and the two `@optimystic/quereus-plugin-*` packages. This suite therefore runs
 * their compiled output too, without declaring any of them — the same transitive
 * reach `cadre-cli` and `cadre-host` list for.
 *
 * `@optimystic/db-p2p-storage-web` is listed because `node-local-slots.ts` reads its
 * durability probe at runtime and `strand-storage.ts` constructs its `IndexedDBRawStorage`,
 * so both specs run its `dist`; it is also a declared, link-resolved dependency the
 * drift spec checks against the manifest.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p-storage-web', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
