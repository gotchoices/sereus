/**
 * Vitest global setup — runs once before the whole reference-app-web unit suite.
 *
 * `node-local-slots.spec.ts` composes `kvSlot` with the REAL
 * `PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore`, and
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
 * `@optimystic/db-p2p-storage-web` is listed even though `node-local-slots.spec.ts`
 * imports it only as a type, which erases at runtime and never loads its `dist`:
 * it is a declared, link-resolved dependency the app itself runs, and the drift
 * spec checks the manifest rather than the import graph. The accepted cost is
 * that a stale build there fails this unit suite over code it doesn't actually
 * exercise — the same bias towards a loud, fixable failure the guard is built on.
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
