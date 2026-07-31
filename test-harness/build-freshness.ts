/**
 * Guards test runs that execute real compiled output.
 *
 * A test suite reaches another package either by spawning it as a genuine child
 * process (`@serfab/cadre-cli`) or by importing it for its real, non-mocked
 * behaviour (`@serfab/cadre-host`, `@serfab/cadre-core`,
 * `@serfab/quereus-plugin-sereus`) — and those in turn run the compiled output of
 * the `@optimystic/*` and `@quereus/*` packages. Either way the code that runs
 * comes from each package's built `dist`, not `src`: workspace and `link:`
 * dependencies resolve through a `node_modules` symlink to the package
 * directory, and the manifest there points at `dist`. So an edit to a
 * dependency's `src` with no following `yarn build` is silently invisible — the
 * run exercises the *previous* build, and the result is a false green (a schema
 * change that never reached the database under test) or a false regression (a
 * startup timeout, a bug that was in fact already fixed).
 *
 * `assertBuildFresh(targets, setupUrl)` fails the run up front, before any child is
 * spawned, when one of `targets`' `src` has been touched more recently than its
 * compiled output (or its entry point is missing outright). Each consuming
 * package calls it once per suite from its own vitest `globalSetup` file, passing
 * the list of packages *it* runs compiled code from:
 *
 *   - `packages/integration-tests/test/global-setup.ts`
 *   - `packages/cadre-core/test/global-setup.ts`
 *   - `packages/cadre-cli/test/global-setup.ts`
 *   - `packages/cadre-host/src/__tests__/global-setup.ts`
 *   - `packages/quereus-plugin-sereus/test/global-setup.ts`
 *   - `packages/reference-app-web/test/global-setup.ts`
 *
 * Two kinds of package are checked. A `workspace` target lives under this
 * repository's `packages/`. A `linked` target lives in a sibling repository
 * checked out beside this one (`../optimystic`, `../quereus`) and reaches
 * `node_modules` as a symlink, courtesy of the `link:` entries in the root
 * `package.json`'s `resolutions`. Those siblings are developed at the same time
 * as this repository, so what a suite runs is whatever they last *built* —
 * which is not necessarily what they last committed.
 *
 * A `linked` target is located the way Node itself would locate it: by walking
 * the `node_modules` chain up from the calling setup module's own directory,
 * as far as the monorepo root. It cannot be assumed to sit in the root
 * `node_modules` — packages declaring `installConfig.hoistingLimits:
 * "workspaces"` (the reference apps) get their dependencies installed into
 * their own `packages/<app>/node_modules` instead, and that package-local copy
 * is the one their suites actually load. Whichever directory in the chain has
 * an entry first wins, whatever that entry turns out to be; searching past it
 * would judge a copy that never runs.
 *
 * This module lives at the repo root rather than inside a package, and consumers
 * import it by relative path (as the schema-drift specs do with
 * `schemas/strand.qsql`). That is deliberate: a shared *workspace* package would
 * itself be consumed from its own `dist`, so the guard against stale builds could
 * be defeated by its own stale build. Vitest transpiles this `.ts` file directly,
 * so there is no build step anywhere in this loop.
 */

import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Dirent, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a target's directory is found — see the module comment. */
type TargetLocation = 'workspace' | 'linked';

/**
 * One package a suite ends up running compiled code from.
 *
 * `linked` entries are only checked when `node_modules` really holds a symlink
 * into a sibling working copy; a registry-installed copy of the same package is
 * skipped (see `checkLinkedTarget`).
 *
 * NOTE: callers write each `distEntry` out rather than having it read from the
 * package's own `main`/`exports`. If a sibling ever renames its entry point, this
 * reports "not built" and the remedy sends someone to run a build that won't
 * help; if that happens, resolve `distEntry` from the target's `package.json`
 * instead.
 */
export interface BuildTarget {
	/** Package name as imported (its directory is located, not module-resolved). */
	packageName: string;
	/** Compiled entry point actually spawned/imported at runtime, relative to the package root. */
	distEntry: string;
	location: TargetLocation;
}

/** Test files aren't part of the build output — a touched test shouldn't trip this. */
const SOURCE_EXCLUDE = /\.(test|spec)\.tsx?$/;
const SOURCE_EXCLUDE_DIRS = new Set(['test', '__tests__']);

/** Why a package's compiled output can't be trusted; `undefined` means it's fresh. */
export type StaleReason = 'unresolved' | 'missing' | 'stale';

/** What `node_modules/<pkg>` turned out to be, once one was found. */
export type LinkedPackage =
	/** A symlink into a working copy at `root`, which is therefore worth checking. */
	| { readonly status: 'linked'; readonly root: string }
	/** A real directory — installed from the registry, so its mtimes mean nothing. */
	| { readonly status: 'not-linked' }
	/** Nowhere in the chain, or a symlink whose target is gone. `detail` says which. */
	| { readonly status: 'unresolved'; readonly detail: string };

/** Adds the one state only a single-directory lookup can report. */
export type NodeModulesEntry =
	| LinkedPackage
	/** Nothing at this path — the walk should continue to the next ancestor. */
	| { readonly status: 'absent' };

/**
 * Throws with a clear build remedy if any of `targets`' build output predates its `src`.
 *
 * `setupUrl` is the calling setup module's own `import.meta.url`: `linked`
 * targets are resolved through the `node_modules` chain above that module's
 * directory, so a package-local install is found before the hoisted one. It is
 * required rather than defaulting to the repo root, because a default would
 * silently look in the wrong place for exactly the packages that have their own
 * `node_modules`.
 */
export function assertBuildFresh(targets: readonly BuildTarget[], setupUrl: string): void {
	// Eager, and deliberately unguarded: a call site passing a plain path rather
	// than a URL should fail here and loudly, not resolve somewhere plausible.
	const fromDir = dirname(fileURLToPath(setupUrl));

	const problems = targets.flatMap((target) => {
		const problem = checkTarget(fromDir, target);
		return problem === undefined ? [] : [problem];
	});
	if (problems.length === 0) return;

	throw new Error(
		'Stale build detected: these tests run real compiled output.\n' +
		problems.map((p) => `  - ${p}`).join('\n'),
	);
}

/** The problem with `target`'s build, as a ready-to-print line; `undefined` when fine. */
function checkTarget(fromDir: string, target: BuildTarget): string | undefined {
	return target.location === 'workspace'
		? checkWorkspaceTarget(target)
		: checkLinkedTarget(fromDir, target);
}

function checkWorkspaceTarget(target: BuildTarget): string | undefined {
	const root = workspacePackageRoots().get(target.packageName);
	if (root === undefined) return problemMessage(target, 'unresolved', 'Run: yarn install');

	const reason = checkBuildFreshness(root, target.distEntry);
	return reason === undefined
		? undefined
		: problemMessage(target, reason, `Run: yarn workspace ${target.packageName} build`);
}

/**
 * Checks a package linked in from a sibling repository.
 *
 * Failure mode — a stale sibling fails the run, exactly like a stale workspace
 * package. It invalidates the results just as completely: this guard was
 * extended because an `@optimystic/db-p2p` fix that had already landed was
 * investigated three separate times against a build that predated it. The two
 * softer options were weighed and rejected. A banner that lets the suite
 * continue is ignorable, and being ignored is precisely how that investigation
 * went wrong. A grace margin ("stale only if `src` leads `dist` by more than N
 * minutes") cannot tell a neighbour mid-edit from a forgotten build — both look
 * identical, `src` newer than `dist`, and the forgotten build is if anything the
 * *more* recent of the two. The accepted cost is that a sibling repo's own
 * automation editing mid-run aborts this suite, with a message naming exactly
 * which sibling to rebuild and where.
 *
 * `fromDir` is the consuming suite's directory — where the `node_modules` walk
 * starts — not a `node_modules` path.
 */
export function checkLinkedTarget(fromDir: string, target: BuildTarget): string | undefined {
	const resolved = resolveLinkedPackageFrom(fromDir, target.packageName);

	// A registry-installed copy is skipped, never judged: its `src` and `dist`
	// mtimes are whatever packing happened to record — for the copied
	// `@optimystic/db-p2p-storage-fs`, `src` lands ~10ms after `dist` — so the
	// comparison is meaningless and would report a permanent, unfixable "stale".
	// Only a symlink points at a working copy someone can actually rebuild.
	if (resolved.status === 'not-linked') return undefined;
	if (resolved.status === 'unresolved') return `${target.packageName}: ${resolved.detail}. Run: yarn install`;

	const reason = checkBuildFreshness(resolved.root, target.distEntry);
	return reason === undefined
		? undefined
		: problemMessage(target, reason, linkedRemedy(target.packageName, resolved.root));
}

/**
 * Classify `nodeModulesDir/<packageName>`: symlink into a working copy, real
 * directory, or nothing there at all.
 *
 * Linkedness is decided by `lstat`, not by package name — which of these
 * dependencies are linked changes with the contents of `resolutions` and with
 * whoever last ran `yarn install`. Windows junctions, which is what yarn writes
 * for a `link:` dependency there, also report as symbolic links.
 *
 * This looks at one directory only. `absent` is its answer for "not here",
 * which is what lets `resolveLinkedPackageFrom` tell *keep walking* from
 * *found, and unusable*.
 */
export function resolveLinkedPackage(nodeModulesDir: string, packageName: string): NodeModulesEntry {
	const entry = join(nodeModulesDir, packageName);

	let entryStat: Stats;
	try {
		entryStat = lstatSync(entry);
	} catch (error) {
		// Only "nothing here" continues the walk. A directory that exists but
		// can't be read is reported: swallowing it would carry on to an ancestor
		// and judge a copy this suite does not load, which is the whole failure
		// this walk exists to avoid.
		const code = errorCode(error);
		if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'absent' };
		return { status: 'unresolved', detail: `${entry} could not be read (${code ?? 'unknown error'})` };
	}
	if (!entryStat.isSymbolicLink()) return { status: 'not-linked' };

	try {
		// `realpath` both follows the link and normalises the platform's spelling
		// of its target (a Windows junction target carries a `\\?\` prefix). It
		// throws when the sibling working copy has been moved or deleted.
		return { status: 'linked', root: realpathSync(entry) };
	} catch {
		return { status: 'unresolved', detail: `links to ${linkTarget(entry)}, which no longer exists` };
	}
}

/**
 * Walks the `node_modules` chain above `fromDir` and classifies the first hit.
 *
 * The first directory holding an entry wins, whatever that entry is: it is the
 * copy Node itself would load, so it is the one whose freshness matters. A
 * package-local install that turns out to be a registry copy, or a link that
 * dangles, therefore ends the walk — "recovering" by carrying on to the root
 * would judge a copy the suite never runs.
 */
export function resolveLinkedPackageFrom(fromDir: string, packageName: string): LinkedPackage {
	const searched = nodeModulesChain(fromDir);
	for (const nodeModulesDir of searched) {
		const entry = resolveLinkedPackage(nodeModulesDir, packageName);
		if (entry.status !== 'absent') return entry;
	}
	return { status: 'unresolved', detail: `not installed (looked in ${searched.join(', ')})` };
}

/**
 * The `node_modules` directories Node would consult from `fromDir`, nearest
 * first, bounded above by the monorepo root (inclusive) so a `node_modules`
 * outside the repository is never consulted.
 *
 * When no ancestor declares `workspaces` — only reachable from temp-dir
 * fixtures — the walk runs to the filesystem root instead of throwing: a guard
 * that crashes on an odd layout is worse than one that searches a little far.
 *
 * NOTE: unlike Node's own algorithm this does not skip ancestors already named
 * `node_modules`, so a `fromDir` *inside* `node_modules` would yield candidates
 * like `.../node_modules/<pkg>/node_modules`. Harmless — no setup module lives
 * there, and such a directory would have to exist to be hit. If one ever does,
 * skip ancestors whose basename is `node_modules`.
 *
 * NOTE: this runs per linked target per suite start-up — a handful of `lstat`
 * calls against at most ~11 targets, unmeasurable today. If it ever shows up,
 * cache the chain per `fromDir`; it cannot change during a run.
 */
function nodeModulesChain(fromDir: string): string[] {
	const stopAt = findWorkspaceRoot(fromDir);

	const dirs: string[] = [];
	let dir = fromDir;
	for (;;) {
		dirs.push(join(dir, 'node_modules'));
		if (dir === stopAt) return dirs;
		const parent = dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

/** A thrown value's `errno` code, when it carries one. */
function errorCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** The raw symlink target, for a message about a link that can't be followed. */
function linkTarget(entry: string): string {
	try {
		return readlinkSync(entry);
	} catch {
		return 'an unreadable path';
	}
}

/**
 * `yarn workspace` only reaches this repository's own workspaces, so a linked
 * sibling has to be built from its own checkout — name that checkout, because
 * whoever hits this has to go there to fix it.
 */
function linkedRemedy(packageName: string, packageRoot: string): string {
	const repoRoot = findWorkspaceRoot(packageRoot);
	return repoRoot === undefined
		? `Run in ${packageRoot}: yarn build`
		: `Run in ${repoRoot}: yarn workspace ${packageName} build`;
}

/**
 * Compares the newest source mtime under `packageRoot/src` against the newest
 * mtime anywhere in the build output. Exported for unit tests —
 * `assertBuildFresh()` is the caller everything else should use.
 *
 * The comparison deliberately spans the whole output tree rather than
 * `distEntry` alone. Every target here is compiled by `tsc`, and the sibling
 * repositories build with `incremental`/`composite`, so a rebuild rewrites only
 * the outputs a change actually affects: edit `src/core/database-events.ts` and
 * `dist/src/core/database-events.js` is rewritten while `dist/src/index.js`
 * keeps the mtime it had two builds ago. Judged by the entry point alone such a
 * package is stale forever — `yarn build` succeeds and changes nothing the check
 * can see — which is exactly the unfixable, ignore-me failure the guard's whole
 * value depends on not producing. The newest file under the output root is when
 * the package was last built: some emitted artifact always moves, and for `tsc
 * --incremental` the `.tsbuildinfo` moves on every single run.
 *
 * NOTE: an absent or unreadable `src` reports fresh. A package consumed
 * without its sources can't be shown stale, and a hard failure there would
 * break for a reason the caller can't act on.
 *
 * NOTE: this walks every target's whole `src` and output tree on every suite
 * start-up — 6 packages for cadre-core, 11 for integration-tests, unmeasurable
 * against those suites' runtimes today. If it ever shows up in start-up time,
 * compare the newest `src` entry against `.tsbuildinfo` alone (it moves on every
 * `tsc --incremental` run) instead of walking the output tree.
 */
export function checkBuildFreshness(packageRoot: string, distEntry: string): StaleReason | undefined {
	const entryMtime = mtimeMs(join(packageRoot, distEntry));
	if (entryMtime === undefined) return 'missing';

	const newestSrc = newestMtime(join(packageRoot, 'src'), isBuildInput);
	if (newestSrc === undefined) return undefined;

	// The entry point is the fallback for an unreadable output root, and for a
	// `distEntry` that sits at the package root with no directory above it.
	const newestBuild = newestMtime(join(packageRoot, outputRoot(distEntry)), isBuildOutput) ?? entryMtime;
	return newestSrc > newestBuild ? 'stale' : undefined;
}

/** The build output directory: the leading segment of `dist/src/index.js` is `dist`. */
function outputRoot(distEntry: string): string {
	const [first] = distEntry.split(/[\\/]/);
	return first === undefined || first === '' ? distEntry : first;
}

function problemMessage(target: BuildTarget, reason: StaleReason, remedy: string): string {
	switch (reason) {
		case 'unresolved':
			return `${target.packageName}: no workspace under packages/ declares this name. ${remedy}`;
		case 'missing':
			return `${target.packageName}: not built (missing ${target.distEntry}). ${remedy}`;
		case 'stale':
			return `${target.packageName}: dist is stale — src was edited after the last build. ${remedy}`;
	}
}

let cachedRoots: Map<string, string> | undefined;

/**
 * Package name -> directory, for every workspace under `<repo>/packages`.
 *
 * Module resolution is deliberately not used: these packages are ESM-only and
 * don't all export `./package.json`, so `require.resolve` can't reach them,
 * and `import.meta.resolve` is not Node's own when this module is loaded
 * through Vite (which is how vitest loads its global setup). `node_modules/@serfab/*`
 * are symlinks back to these same directories, so the workspace copy *is* the
 * one the tests load. Linked siblings can't be found this way at all — they live
 * outside this repository — so they go through `resolveLinkedPackageFrom`
 * instead, which reads the same kind of symlink from the other end.
 */
function workspacePackageRoots(): Map<string, string> {
	if (cachedRoots !== undefined) return cachedRoots;

	const packagesDir = join(findRepoRoot(), 'packages');
	cachedRoots = new Map();
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pkg = readPackageJson(join(packagesDir, entry.name, 'package.json'));
		if (pkg?.name !== undefined) cachedRoots.set(pkg.name, join(packagesDir, entry.name));
	}
	return cachedRoots;
}

let cachedRepoRoot: string | undefined;

/** Walk up from this file to the workspace root — the `package.json` declaring `workspaces`. */
function findRepoRoot(): string {
	if (cachedRepoRoot !== undefined) return cachedRepoRoot;

	cachedRepoRoot = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
	if (cachedRepoRoot === undefined) throw new Error('Could not locate the monorepo root from build-freshness.ts');
	return cachedRepoRoot;
}

/** Nearest ancestor of `from` (inclusive) whose `package.json` declares `workspaces`. */
export function findWorkspaceRoot(from: string): string | undefined {
	let dir = from;
	for (;;) {
		if (readPackageJson(join(dir, 'package.json'))?.workspaces !== undefined) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

interface PackageManifest {
	name?: string;
	workspaces?: unknown;
}

/** Parsed manifest, or `undefined` when there is no readable `package.json` there. */
function readPackageJson(path: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
	} catch {
		return undefined;
	}
}

/** Whether a directory entry counts towards the newest mtime of a tree. */
type EntryFilter = (entry: Dirent) => boolean;

/** Sources the build reads: test files and their directories are not among them. */
const isBuildInput: EntryFilter = (entry) =>
	entry.isDirectory() ? !SOURCE_EXCLUDE_DIRS.has(entry.name) : !SOURCE_EXCLUDE.test(entry.name);

/** Everything the compiler writes counts, `.tsbuildinfo` and compiled tests included. */
const isBuildOutput: EntryFilter = () => true;

/** Newest mtime (ms) under `dir`, recursively, over the entries `accept` keeps. */
function newestMtime(dir: string, accept: EntryFilter): number | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}

	let newest: number | undefined;
	for (const entry of entries) {
		if (!accept(entry)) continue;
		const candidate = entry.isDirectory()
			? newestMtime(join(dir, entry.name), accept)
			: (entry.isFile() ? mtimeMs(join(dir, entry.name)) : undefined);
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
