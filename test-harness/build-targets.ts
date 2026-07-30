/**
 * Cross-checks a suite's stale-build target list against the package it belongs to.
 *
 * The lists handed to `assertBuildFresh` are written by hand, and nothing ties them
 * to the dependencies they are supposed to cover. Add a dependency to a package
 * tomorrow and its list keeps passing while that dependency goes unguarded — the
 * false green the guard exists to catch quietly comes back. `targetListProblems`
 * closes that: each consuming package asserts, from its own suite, that its list
 * still covers everything it runs compiled code from.
 *
 * Only two kinds of dependency are checkable this way. A `workspace:` range is
 * another package in this repository; a name the root manifest's `resolutions`
 * points at with `link:` is a sibling checkout. Both reach `node_modules` as a
 * symlink to a working copy someone can rebuild. Everything else arrives from the
 * registry, where `src`/`dist` mtimes are packing artifacts — `checkLinkedTarget`
 * skips those, so demanding they be listed would be noise.
 *
 * A list may legitimately be a *superset* of its own package's `dependencies`:
 * `integration-tests` guards `@serfab/cadre-cli` and `@serfab/cadre-provider`,
 * which it reaches transitively rather than declaring. So this checks coverage,
 * not equality — extra entries are fine, missing ones are not.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findWorkspaceRoot, type BuildTarget } from './build-freshness.js';

/** Where a dependency's compiled output comes from, when the guard can judge it. */
export type Origin = 'workspace' | 'linked';

/**
 * Every dependency of `packageDir` that runs from a rebuildable `dist` but is not
 * covered by `targets`, as ready-to-print lines. Empty means the list is complete.
 *
 * A dependency listed under the wrong `location` counts as a problem too: the two
 * locations are resolved by different code paths (`packages/` lookup versus
 * `node_modules` symlink), so the wrong one reports `unresolved` rather than
 * checking anything.
 */
export function targetListProblems(packageDir: string, targets: readonly BuildTarget[]): string[] {
	const listed = new Map(targets.map((target) => [target.packageName, target.location]));

	return [...distBackedDependencies(packageDir)].flatMap(([name, origin]) => {
		const location = listed.get(name);
		if (location === origin) return [];
		return location === undefined
			? [`${name} is a ${origin} dependency but is missing from the target list`]
			: [`${name} is a ${origin} dependency but is listed as '${location}'`];
	});
}

/**
 * Dependency name -> where its build lives, for the deps the guard can judge.
 *
 * Exported so a suite can pin what it found: `targetListProblems` returning an
 * empty array proves nothing if this returned nothing to check.
 */
export function distBackedDependencies(packageDir: string): Map<string, Origin> {
	const linked = linkedResolutions(packageDir);
	const { dependencies = {} } = readManifest(join(packageDir, 'package.json'));

	const checkable = new Map<string, Origin>();
	for (const [name, range] of Object.entries(dependencies)) {
		if (range.startsWith('workspace:')) checkable.set(name, 'workspace');
		else if (linked.has(name)) checkable.set(name, 'linked');
	}
	return checkable;
}

/** Names the repo root's `resolutions` redirects to a sibling checkout with `link:`. */
function linkedResolutions(packageDir: string): Set<string> {
	const repoRoot = findWorkspaceRoot(packageDir);
	if (repoRoot === undefined) throw new Error(`Could not locate the monorepo root from ${packageDir}`);

	const { resolutions = {} } = readManifest(join(repoRoot, 'package.json'));
	return new Set(
		Object.entries(resolutions)
			.filter(([, range]) => range.startsWith('link:'))
			.map(([name]) => name),
	);
}

interface Manifest {
	dependencies?: Record<string, string>;
	resolutions?: Record<string, string>;
}

function readManifest(path: string): Manifest {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
	} catch (error) {
		throw new Error(`Could not read ${path}`, { cause: error });
	}
}
