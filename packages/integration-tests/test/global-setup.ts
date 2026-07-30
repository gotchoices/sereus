/**
 * Vitest global setup — runs once before the whole integration suite.
 *
 * Every scenario exercises real compiled cadre output, either as a spawned
 * `cadre-cli` child or as an in-process import of `@serfab/cadre-host` /
 * `@serfab/cadre-core` from their `dist` — and, underneath those, the compiled
 * `@optimystic/*` and `@quereus/*` packages linked in from their sibling
 * checkouts. A stale build therefore silently tests yesterday's code, so fail
 * the run up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`) so
 * that other packages' suites can share it; the list of packages below is this
 * suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package a scenario in this suite ends up running compiled code from.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' },
	{ packageName: '@serfab/cadre-host', distEntry: 'dist/index.js', location: 'workspace' },
	// Not imported by a scenario directly, but loaded from `dist` on every run all
	// the same: `cadre-core`'s entry point imports `quereus-plugin-sereus`, and
	// `cadre-host`'s re-exports `cadre-provider`.
	{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/cadre-provider', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p-storage-fs', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS);
}
