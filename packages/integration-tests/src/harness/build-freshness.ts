/**
 * Guards test runs that execute real compiled cadre output.
 *
 * Integration scenarios either launch `@serfab/cadre-cli` as a genuine child
 * process or import `@serfab/cadre-host`/`@serfab/cadre-core` for their real,
 * non-mocked behaviour. Either way the code that runs comes from each
 * package's built `dist`, not `src` — so an edit to `src` with no following
 * `yarn build` is silently invisible: the run exercises the *previous* build
 * and any resulting failure (e.g. a 90s startup timeout) looks like a real
 * regression instead of a stale-build mistake.
 *
 * `assertCadreBuildFresh()` fails the run up front, before any child is
 * spawned, when a package's `src` has been touched more recently than its
 * compiled entry point (or that entry point is missing outright). It runs
 * once per suite from `src/global-setup.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BuildTarget {
	/** Package name as imported (its `package.json` is resolved to find the root). */
	packageName: string;
	/** Compiled entry point actually spawned/imported at runtime, relative to the package root. */
	distEntry: string;
}

/** Every package a scenario ends up running compiled code from. */
const TARGETS: BuildTarget[] = [
	{ packageName: '@serfab/cadre-core', distEntry: 'dist/index.js' },
	{ packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js' },
	{ packageName: '@serfab/cadre-host', distEntry: 'dist/index.js' },
];

/** Test files aren't part of the build output — a touched test shouldn't trip this. */
const SOURCE_EXCLUDE = /\.(test|spec)\.tsx?$/;
const SOURCE_EXCLUDE_DIRS = new Set(['test', '__tests__']);

/** Why a package's compiled output can't be trusted; `undefined` means it's fresh. */
export type StaleReason = 'unresolved' | 'missing' | 'stale';

/**
 * Throws with a clear `yarn build` remedy if any cadre package's `dist`
 * predates its `src`.
 */
export function assertCadreBuildFresh(): void {
	const problems = TARGETS.flatMap((target) => {
		const reason = checkTarget(target);
		return reason === undefined ? [] : [problemMessage(target, reason)];
	});
	if (problems.length === 0) return;

	throw new Error(
		'Stale build detected: these tests run real compiled cadre output.\n' +
		problems.map((p) => `  - ${p}`).join('\n'),
	);
}

function checkTarget(target: BuildTarget): StaleReason | undefined {
	let root: string;
	try {
		root = resolvePackageRoot(target.packageName);
	} catch {
		return 'unresolved';
	}
	return checkBuildFreshness(root, target.distEntry);
}

/**
 * Compares the newest source mtime under `packageRoot/src` against
 * `distEntry`'s mtime. Exported for unit tests — `assertCadreBuildFresh()` is
 * the caller everything else should use.
 *
 * NOTE: an absent or unreadable `src` reports fresh. A package consumed
 * without its sources can't be shown stale, and a hard failure there would
 * break for a reason the caller can't act on.
 */
export function checkBuildFreshness(packageRoot: string, distEntry: string): StaleReason | undefined {
	const entryMtime = mtimeMs(join(packageRoot, distEntry));
	if (entryMtime === undefined) return 'missing';

	const newestSrc = newestMtime(join(packageRoot, 'src'));
	return newestSrc !== undefined && newestSrc > entryMtime ? 'stale' : undefined;
}

function problemMessage(target: BuildTarget, reason: StaleReason): string {
	const remedy = `Run: yarn workspace ${target.packageName} build`;
	switch (reason) {
		case 'unresolved':
			return `${target.packageName}: not resolvable from @serfab/integration-tests. Run: yarn install`;
		case 'missing':
			return `${target.packageName}: not built (missing ${target.distEntry}). ${remedy}`;
		case 'stale':
			return `${target.packageName}: dist is stale — src was edited after the last build. ${remedy}`;
	}
}

/**
 * Locate `packageName`'s directory by scanning the monorepo's `packages/`.
 *
 * Module resolution is deliberately not used: these packages are ESM-only and
 * don't all export `./package.json`, so `require.resolve` can't reach them,
 * and `import.meta.resolve` is not Node's own when this module is loaded
 * through Vite (which is how vitest loads its global setup). Every package
 * checked here is a workspace sibling, and `node_modules/@serfab/*` are
 * symlinks back to these same directories, so the workspace copy *is* the one
 * the tests load.
 */
function resolvePackageRoot(packageName: string): string {
	const root = workspacePackageRoots().get(packageName);
	if (root === undefined) throw new Error(`Could not locate workspace package ${packageName}`);
	return root;
}

let cachedRoots: Map<string, string> | undefined;

/** Package name -> directory, for every workspace under `<repo>/packages`. */
function workspacePackageRoots(): Map<string, string> {
	if (cachedRoots !== undefined) return cachedRoots;

	const packagesDir = join(findRepoRoot(), 'packages');
	cachedRoots = new Map();
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pkgJsonPath = join(packagesDir, entry.name, 'package.json');
		if (!existsSync(pkgJsonPath)) continue;
		const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
		if (pkg.name !== undefined) cachedRoots.set(pkg.name, join(packagesDir, entry.name));
	}
	return cachedRoots;
}

/** Walk up from this file to the workspace root — the `package.json` declaring `workspaces`. */
function findRepoRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const pkgJsonPath = join(dir, 'package.json');
		if (existsSync(pkgJsonPath)) {
			const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { workspaces?: unknown };
			if (pkg.workspaces !== undefined) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) throw new Error('Could not locate the monorepo root from build-freshness.ts');
		dir = parent;
	}
}

/** Newest mtime (ms) among source files under `dir`, recursively. */
function newestMtime(dir: string): number | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let newest: number | undefined;
	for (const entry of entries) {
		const candidate = entry.isDirectory()
			? (SOURCE_EXCLUDE_DIRS.has(entry.name) ? undefined : newestMtime(join(dir, entry.name)))
			: (entry.isFile() && !SOURCE_EXCLUDE.test(entry.name) ? mtimeMs(join(dir, entry.name)) : undefined);
		if (candidate !== undefined && (newest === undefined || candidate > newest)) newest = candidate;
	}
	return newest;
}

/** mtime in ms, or `undefined` when the path doesn't exist / can't be stat'd. */
function mtimeMs(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}
