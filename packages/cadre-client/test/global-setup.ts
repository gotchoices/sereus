/**
 * Vitest global setup — runs once before the cadre-client suite.
 *
 * The specs under `test/sereus/` run cadre-core's compiled `dist` (node-code reading, the
 * edge-node host). An edit to cadre-core's `src` with no following build would be invisible
 * here, so the run fails up front instead. The guard lives at the repo root
 * (`test-harness/build-freshness.ts`).
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';
import { assertUppercaseDriveLetter } from '../../../test-harness/working-directory.js';

/** Every package this suite runs compiled code from. */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
];

export default function setup(): void {
	assertUppercaseDriveLetter();
	assertBuildFresh(TARGETS, import.meta.url);
}
