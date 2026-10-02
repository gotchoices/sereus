/**
 * Vitest global setup — runs once before the whole cadre-provider suite.
 *
 * The config loader imports `@serfab/config-check`'s compiled entry point through the
 * workspace link, so an edit to that package's `src` with no following build is invisible
 * here: the suite would run the previous build and report green about code it never
 * executed. Fail the run up front instead.
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`), shared with
 * the other suites that call it; the list below is this suite's own concern. Exported so
 * `build-targets.spec.ts` can hold it against this package's actual `dependencies` — a
 * hand-written list rots silently otherwise.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

export const TARGETS: BuildTarget[] = [
  { packageName: '@serfab/config-check', distEntry: 'dist/index.js', location: 'workspace' },
];

export default function setup(): void {
  assertBuildFresh(TARGETS, import.meta.url);
}
