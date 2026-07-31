/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a workspace
 * or linked dependency to `package.json` leaves it unguarded and says nothing —
 * the suite goes on passing while it runs that dependency's stale `dist`.
 */

import { describeBuildTargets, packageRootFrom } from '../../../test-harness/build-targets-spec.js';
import { TARGETS } from './global-setup.js';

describeBuildTargets('cadre-core', {
	packageDir: packageRootFrom(import.meta.url, '..'),
	targets: TARGETS,
	expectFound: {
		'@serfab/quereus-plugin-sereus': 'workspace',
		'@quereus/quereus': 'linked',
	},
});
