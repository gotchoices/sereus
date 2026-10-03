/**
 * Vitest global setup — runs once before the whole cadre-rn suite.
 *
 * `noise-crypto.spec.ts` compares the adapter against `@optimystic/db-p2p`'s
 * `noisePureJsCrypto`, and the phone-node specs start a real cadre-core node over
 * `@optimystic/db-p2p-storage-rn`. Each resolves through a `node_modules` symlink whose
 * manifest points at `dist`. An edit to one of those packages' `src` with no following
 * build would be invisible here, so the run fails up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`); the list
 * of packages below is this suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from — the `link:` entries of
 * `package.json`'s `dependencies`, and cadre-core, which the phone-node specs start.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p-storage-rn', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
