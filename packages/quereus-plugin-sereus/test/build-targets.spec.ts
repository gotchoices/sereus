/**
 * Holds this suite's stale-build target list against the package it guards.
 *
 * `global-setup.ts`'s `TARGETS` is hand-written. Without this, adding a `link:`
 * dependency to `package.json` leaves it unguarded and says nothing — the suite
 * goes on passing while it runs that dependency's stale `dist`.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { distBackedDependencies, targetListProblems } from '../../../test-harness/build-targets.js';
import { TARGETS } from './global-setup.js';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('quereus-plugin-sereus stale-build targets', () => {
	it('cover every dependency this suite runs compiled code from', () => {
		expect(targetListProblems(packageDir, TARGETS)).toEqual([]);
	});

	// Guards the guard: the assertion above passes trivially if the manifest scan
	// comes back empty (a renamed field, a moved package root).
	it('are checked against dependencies that were actually found', () => {
		const found = distBackedDependencies(packageDir);

		expect(found.get('@optimystic/db-core')).toBe('linked');
		expect(found.get('@quereus/quereus')).toBe('linked');
	});

	it('name each package once', () => {
		const names = TARGETS.map((target) => target.packageName);

		expect(names).toEqual([...new Set(names)]);
	});
});
