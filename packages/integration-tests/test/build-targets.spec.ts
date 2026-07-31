/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a workspace
 * or linked dependency to `package.json` leaves it unguarded and says nothing —
 * the suite goes on passing while it runs that dependency's stale `dist`.
 *
 * The list is deliberately wider than `dependencies` (it also covers `cadre-cli`,
 * `cadre-provider` and `quereus-plugin-sereus`, reached transitively), so only
 * missing entries fail — extra ones are the point.
 */

import { describeBuildTargets, packageRootFrom } from '../../../test-harness/build-targets-spec.js';
import { TARGETS } from './global-setup.js';

describeBuildTargets('integration-tests', {
	packageDir: packageRootFrom(import.meta.url, '..'),
	targets: TARGETS,
	expectFound: {
		'@serfab/cadre-host': 'workspace',
		'@quereus/quereus': 'linked',
	},
});
