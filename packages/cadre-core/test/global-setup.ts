/**
 * Vitest global setup — runs once before the whole cadre-core suite.
 *
 * These tests import `@serfab/quereus-plugin-sereus` and the `@optimystic/*` /
 * `@quereus/*` packages for their real behaviour, and every one of those resolves
 * through a `node_modules` symlink whose manifest points at `dist`. An edit to one
 * of those packages' `src` with no following build is therefore invisible here: the
 * suite runs the previous build and reports green about code it never executed.
 * That is not hypothetical — a new control-database table was silently absent from
 * the database under test while the whole suite passed. Fail the run up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`),
 * shared with the integration suite; the list of packages below is this suite's
 * own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from — the workspace and `link:`
 * entries of `package.json`'s `dependencies`. `@serfab/cadre-core` itself is
 * absent on purpose: vitest transpiles this package's own `src` directly, so its
 * `dist` is not what runs here.
 */
const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS);
}
