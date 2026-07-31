/**
 * Vitest global setup — runs once before the whole cadre-host suite.
 *
 * `src/update/manifest.ts` and `src/push/index.ts` import real symbols from
 * `@serfab/cadre-core` (`canonicalJson`, `validatePushCredentials`), and
 * `trust-circle-integration.test.ts` imports and drives a real `CadreNode` from
 * it too. `@serfab/cadre-core`'s compiled entry point in turn imports
 * `@serfab/quereus-plugin-sereus`, which imports the `@optimystic/*` and
 * `@quereus/quereus` packages linked in from their sibling checkouts.
 * `host-process-orchestrator.ts` also resolves `@serfab/cadre-cli`'s bin path at
 * runtime, and `@serfab/cadre-provider` is a declared dependency in its own
 * right. Every one of those resolves through a `node_modules` symlink whose
 * manifest points at `dist`, so an edit to any of their `src` with no following
 * build is invisible here: the suite runs the previous build and reports green
 * about code it never executed. Fail the run up front instead.
 *
 * This does not cover cadre-host's *own* `src` going stale relative to its own
 * `dist` — the CLI smoke tests spawn `dist/bin/host.js` as a child process, which
 * is a same-package staleness concern, not a cross-package one `BuildTarget` is
 * meant to check (see `test-harness/build-freshness.ts`'s module comment).
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`),
 * shared with the other suites that call it; the list of packages below is this
 * suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from — the `workspace:` entries of
 * `package.json`'s `dependencies`, plus the `link:` packages reached
 * transitively through them.
 *
 * Exported so `build-targets.test.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' },
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/cadre-provider', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@serfab/quereus-plugin-sereus', distEntry: 'dist/index.js', location: 'workspace' },
	{ packageName: '@optimystic/db-core', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/db-p2p', distEntry: 'dist/src/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-crypto', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@optimystic/quereus-plugin-optimystic', distEntry: 'dist/index.js', location: 'linked' },
	{ packageName: '@quereus/quereus', distEntry: 'dist/src/index.js', location: 'linked' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
