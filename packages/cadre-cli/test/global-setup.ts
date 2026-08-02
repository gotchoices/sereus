/**
 * Vitest global setup — runs once before the whole cadre-cli suite.
 *
 * Several specs here import real (non-mocked) symbols from `@serfab/cadre-core`
 * (e.g. `pinnedKeyTrustPolicy` in `start-pins.spec.ts`), and the `../src/commands/*`
 * modules those specs exercise load `@serfab/cadre-core`'s compiled entry point at
 * module-evaluation time regardless. That entry point in turn imports
 * `@serfab/quereus-plugin-sereus`, which imports the `@optimystic/*` and
 * `@quereus/quereus` packages linked in from their sibling checkouts. Every one of
 * those resolves through a `node_modules` symlink whose manifest points at `dist`,
 * so an edit to any of their `src` with no following build is invisible here: the
 * suite runs the previous build and reports green about code it never executed.
 * Fail the run up front instead.
 *
 * As of `one-shot-node.spec.ts` the suite also SPAWNS this package's own compiled
 * output (`dist/bin/cadre.js`) as a child process, so `@serfab/cadre-cli` is a
 * target too. The accepted cost: an edit to `packages/cadre-cli/src` with no
 * following build now fails the *whole* cadre-cli suite, including the specs that
 * import `src` directly and never touch `dist`. That is the same tradeoff
 * `integration-tests` already accepted, and it is the right one — a spec that runs
 * `dist` reports on yesterday's code otherwise. Editing a spec does not trip it:
 * `test/` is excluded from the source scan (`SOURCE_EXCLUDE_DIRS`).
 *
 * The guard itself lives at the repo root (`test-harness/build-freshness.ts`),
 * shared with the other suites that call it; the list of packages below is this
 * suite's own concern.
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * Every package this suite runs compiled code from. `@serfab/cadre-cli` is this
 * package itself (spawned as a child, not imported); `@serfab/cadre-core` is
 * declared directly; the rest are reached transitively through it, mirroring
 * `@serfab/cadre-core`'s own target list plus `@serfab/cadre-core` itself.
 *
 * Exported so `build-targets.spec.ts` can hold it against this package's actual
 * `dependencies` — a hand-written list rots silently otherwise. The self-entry
 * needs no exemption there: coverage is checked, not equality, and a package is
 * never its own dependency.
 */
export const TARGETS: BuildTarget[] = [
  { packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js', location: 'workspace' },
  { packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
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
