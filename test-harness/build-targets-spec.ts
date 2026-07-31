/**
 * The shared spec every suite uses to hold its stale-build target list in place.
 *
 * `targetListProblems` is the check; this is the three assertions each consuming
 * package was otherwise copying verbatim into its own `build-targets.spec.ts`.
 * They only ever differed in the suite's name, where its package root sits
 * relative to the spec file, and which two dependencies it pins — so those are
 * the arguments, and everything else lives here once.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { BuildTarget } from './build-freshness.js';
import { distBackedDependencies, targetListProblems, type Origin } from './build-targets.js';

export interface BuildTargetsSpec {
	/** The suite's package root — use `packageRootFrom(import.meta.url, ...)`. */
	packageDir: string;
	/** The list `global-setup.ts` hands to `assertBuildFresh`. */
	targets: readonly BuildTarget[];
	/**
	 * A couple of dependencies the manifest scan must actually turn up, by name and
	 * origin. Without these, an empty scan (a renamed field, a moved package root)
	 * would let the coverage assertion pass having checked nothing.
	 */
	expectFound: Readonly<Record<string, Origin>>;
}

/** The package root `segments` above the module at `metaUrl`. */
export function packageRootFrom(metaUrl: string, ...segments: string[]): string {
	return join(dirname(fileURLToPath(metaUrl)), ...segments);
}

/** Registers the target-list assertions for one suite. */
export function describeBuildTargets(suiteName: string, spec: BuildTargetsSpec): void {
	const { packageDir, targets, expectFound } = spec;

	describe(`${suiteName} stale-build targets`, () => {
		it('cover every dependency this suite runs compiled code from', () => {
			expect(targetListProblems(packageDir, targets)).toEqual([]);
		});

		it('are checked against dependencies that were actually found', () => {
			const found = distBackedDependencies(packageDir);

			for (const [name, origin] of Object.entries(expectFound)) {
				expect(found.get(name), name).toBe(origin);
			}
		});

		it('name each package once', () => {
			const names = targets.map((target) => target.packageName);

			expect(names).toEqual([...new Set(names)]);
		});
	});
}
