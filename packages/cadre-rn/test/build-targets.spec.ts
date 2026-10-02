/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a workspace
 * or linked dependency to `package.json` leaves it unguarded and says nothing.
 */

import { describeBuildTargets, packageRootFrom } from '../../../test-harness/build-targets-spec.js';
import { TARGETS } from './global-setup.js';

describeBuildTargets('cadre-rn', {
	packageDir: packageRootFrom(import.meta.url, '..'),
	targets: TARGETS,
	expectFound: {
		'@optimystic/db-p2p': 'linked',
	},
});
