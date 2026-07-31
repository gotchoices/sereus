/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a workspace
 * or linked dependency to `package.json` leaves it unguarded and says nothing —
 * the suite goes on passing while it runs that dependency's stale `dist`.
 *
 * The list is deliberately wider than `dependencies` (it also covers
 * `quereus-plugin-sereus` and the packages beneath it, reached transitively
 * through `cadre-core`), so only missing entries fail — extra ones are the point.
 *
 * Both pinned names are `workspace:` deps: cadre-host declares no `link:` entry of
 * its own — those arrive transitively through `@serfab/cadre-core`.
 */

import { describeBuildTargets, packageRootFrom } from '../../../../test-harness/build-targets-spec.js';
import { TARGETS } from './global-setup.js';

describeBuildTargets('cadre-host', {
	packageDir: packageRootFrom(import.meta.url, '..', '..'),
	targets: TARGETS,
	expectFound: {
		'@serfab/cadre-core': 'workspace',
		'@serfab/cadre-cli': 'workspace',
	},
});
