/**
 * Vitest global setup — runs once before the whole quereus-plugin-sereus suite.
 *
 * This plugin imports the `@optimystic/*` packages and `@quereus/quereus` for
 * their real behaviour, and each one resolves through a `node_modules` symlink
 * whose manifest points at `dist`. An edit to one of those packages' `src` with
 * no following build is therefore invisible here: the suite runs the previous
 * build and reports green about code it never executed — exactly the risk
 * `strand-schema-drift.spec.ts` and the `test/e2e/*` scenarios exist to catch.
 * Fail the run up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`),
 * shared with the other suites that call it; the list of packages below is this
 * suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from — the `link:` entries of
 * `package.json`'s `dependencies`. This package has no `@serfab/*` dependency of
 * its own: nothing in this repository sits upstream of it.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p-storage-web', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS);
}
