/**
 * Vitest global setup — runs once before the whole reference-app-web unit suite.
 *
 * `node-local-slots.spec.ts` composes `kvSlot` with the REAL
 * `PersistentTrustedOwnerStore` / `PersistentBootstrapPeerStore`, and
 * `@serfab/cadre-core` reaches `node_modules` as a symlink whose manifest points
 * at `dist`. So an edit to cadre-core's `src` with no following build is
 * invisible here: the suite runs the previous build and reports green about a
 * load policy it never executed. Fail the run up front instead — the same guard
 * `cadre-core` and `integration-tests` use (`test-harness/build-freshness.ts`).
 */

import { assertBuildFresh, type BuildTarget } from '../../../test-harness/build-freshness.js';

/**
 * The one package this suite runs compiled code from directly. The `@optimystic/*`
 * and `@quereus/*` siblings that cadre-core pulls in transitively are NOT listed:
 * this package sets `installConfig.hoistingLimits: "workspaces"`, so its copies of
 * them live in its own `node_modules`, while the guard resolves `linked` targets
 * from the repo root's — see the backlog ticket
 * `debt-stale-build-guard-hoisting-limited-packages`. The same reason there is no
 * `build-targets.spec.ts` here: the manifest cross-check would demand exactly
 * those entries.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS);
}
