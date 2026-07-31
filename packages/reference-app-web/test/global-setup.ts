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
 * and `@quereus/*` siblings that cadre-core pulls in transitively are not listed
 * yet, and there is no `build-targets.spec.ts` here to demand them — completing
 * the list is `debt-web-app-build-guard-targets`.
 *
 * They *can* be listed now: this package sets `installConfig.hoistingLimits:
 * "workspaces"`, so its copies of them live in its own `node_modules`, and the
 * guard resolves `linked` targets by walking the `node_modules` chain up from
 * this file's directory — reaching those local copies before the repo root's.
 */
export const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js', location: 'workspace' },
];

export default function setup(): void {
	assertBuildFresh(TARGETS, import.meta.url);
}
