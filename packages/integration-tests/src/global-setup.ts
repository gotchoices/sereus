/**
 * Vitest global setup — runs once before the whole integration suite.
 *
 * Every scenario exercises real compiled cadre output, either as a spawned
 * `cadre-cli` child or as an in-process import of `@serfab/cadre-host` /
 * `@serfab/cadre-core` from their `dist`. A stale build therefore silently
 * tests yesterday's code, so fail the run up front instead.
 */

import { assertCadreBuildFresh } from './harness/build-freshness.js';

export default function setup(): void {
	assertCadreBuildFresh();
}
