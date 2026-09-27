/**
 * Vitest global setup — runs once before the whole cadre-rn suite.
 *
 * `noise-crypto.spec.ts` compares the adapter against `@optimystic/db-p2p`'s
 * `noisePureJsCrypto`, which resolves through a `node_modules` symlink whose manifest
 * points at `dist`. An edit to that package's `src` with no following build would be
 * invisible here, so the run fails up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`); the list
 * of packages below is this suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from — the `link:` entries of
 * `package.json`'s `dependencies`.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
