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

import { resolveLinkedPackageFrom, type BuildTarget } from './build-freshness.js';
import { distBackedDependencies, linkedResolutions, targetListProblems, type Origin } from './build-targets.js';

export interface BuildTargetsSpec {
	/** The suite's package root — use `packageRootFrom(import.meta.url, ...)`. */
	packageDir: string;
	/** The list `global-setup.ts` hands to `assertBuildFresh`. */
	targets: readonly BuildTarget[];
	/**
	 * A couple of dependencies the manifest scan must actually turn up, by name and
	 * origin. Without these, an empty scan (a renamed field, a moved package root)
	 * would let the coverage assertion pass having checked nothing.
	 *
	 * Written as the repository *intends* to resolve each name — `'linked'` means
	 * "the root manifest redirects this to a sibling checkout". On an install where
	 * it does not, `describeBuildTargets` asserts the registry shape instead; these
	 * blocks do not change with the install.
	 */
	expectFound: Readonly<Record<string, Origin>>;
}

/** The package root `segments` above the module at `metaUrl`. */
export function packageRootFrom(metaUrl: string, ...segments: string[]): string {
	return join(dirname(fileURLToPath(metaUrl)), ...segments);
}

/**
 * What an `expectFound` entry of `'linked'` means when the root manifest's
 * `resolutions` block is gone — `yarn check:published`'s de-linked worktree, and
 * any consumer's checkout. The dependency then arrives from the registry, which
 * `distBackedDependencies` deliberately omits (a packed copy's `src`/`dist` mtimes
 * are packing artifacts, so judging its freshness would report a staleness nobody
 * can fix).
 *
 * Asserting only that absence would pass for a name that is misspelled or no
 * longer a dependency at all, which is the vacuity `expectFound` exists to
 * prevent. So the dependency must also still be installed: `'not-linked'` is
 * `resolveLinkedPackageFrom`'s answer for a real directory at that name, and
 * `'absent'`/`'unresolved'` for nothing there.
 */
function expectInstalledFromRegistry(packageDir: string, name: string, found: Map<string, Origin>): void {
	expect(found.get(name), name).toBeUndefined();
	expect(resolveLinkedPackageFrom(packageDir, name).status, name).toBe('not-linked');
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
			const linked = linkedResolutions(packageDir);

			for (const [name, origin] of Object.entries(expectFound)) {
				if (origin === 'linked' && !linked.has(name)) expectInstalledFromRegistry(packageDir, name, found);
				else expect(found.get(name), name).toBe(origin);
			}
		});

		it('name each package once', () => {
			const names = targets.map((target) => target.packageName);

			expect(names).toEqual([...new Set(names)]);
		});
	});
}
