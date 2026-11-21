/**
 * Refuses a test run that would load one linked package twice.
 *
 * A **spelling** is the exact path string a junction stores for the directory it
 * points at. Windows compares paths without regard to case, so two junctions can
 * point at one directory and store different strings for it:
 * `C:\Projects\optimystic\packages\db-core` and
 * `C:\Projects\Optimystic\packages\db-core` are one directory under two
 * spellings.
 *
 * Node keys its module cache by the resolved path string, and the resolution it
 * performs keeps whatever spelling the junction stored. `fs.realpathSync` behaves
 * the same way; only `fs.realpathSync.native` corrects a path to the directory's
 * own spelling on disk. The whole check rests on that one difference. So a
 * package reached under two spellings is loaded twice, and the two copies share
 * nothing: each has its own classes, so every `instanceof` across the boundary is
 * false. That is not a subtle degradation — `isCohortUnreachableRead` in
 * `packages/cadre-core/src/control-read-retry.ts` stopped recognising a
 * `BlockUnavailableError` the plugin had just thrown, which reads as a bug in
 * this repository's retry logic rather than in the install.
 *
 * The disagreement arises between this repository's `resolutions` and a sibling's
 * own install. Yarn writes this repository's junctions with the `link:` paths from
 * the root `package.json` (`../optimystic`), while a sibling's own install writes
 * its nested links relative to its own checkout (`C:\Projects\Optimystic`). Those
 * nested links are inside the sibling and not ours to change
 * (`tickets/rules/sibling-repos.md`).
 *
 * Spellings are compared against *each other*, never against the disk. A spelling
 * that disagrees with the disk but is used everywhere loads one copy and is
 * harmless, and refusing it would stop every suite on such a machine for no
 * reason. There is likewise no platform branch: on a case-sensitive filesystem
 * the spellings simply agree. The check also passes trivially where `resolutions`
 * carries no `link:` entries (`yarn check:published`), because then nothing
 * resolves as linked.
 *
 * This module reads only `lstat`, `readlink`, `realpath` and `package.json`. It
 * writes nothing, in this repository or in a sibling.
 *
 * Wiring: each consuming package calls `assertOneSpellingPerLinkedPackage` from
 * its own vitest `globalSetup`, between `assertUppercaseDriveLetter()` and
 * `assertBuildFresh(...)`. Before the freshness check for a reason, not just
 * cost: with two spellings live, the freshness walk judges two roots for one
 * package, so its verdict may be about a copy that is not the one that runs.
 *
 * NOTE: the walk runs once per suite start-up, reading `lstat`, `realpath` and a
 * `package.json` per context and candidate name. It has not been timed in
 * isolation. If suite start-up ever shows up as slow, the set of contexts and
 * their manifests cannot change during a run, so both can be cached.
 *
 * NOTE: `scripts/check-stale-build-guard-wiring.mjs` gates the `build-freshness`
 * import, not this call, so deleting only the
 * `assertOneSpellingPerLinkedPackage` line from one setup module fails nothing —
 * equally true of `assertUppercaseDriveLetter` today. If a third such setup check
 * appears, gate the set of setup checks rather than that one import specifier.
 *
 * See docs/contributing/testing.md → "Windows: one sibling under two path spellings".
 */

import { realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findWorkspaceRoot, readPackageJson, resolveLinkedPackageFrom, workspacePackageRoots, type BuildTarget } from './build-freshness.js';

/** One junction's target, as the loader sees it and as the disk spells it. */
export interface PackageSpelling {
	/** `realpathSync` of the junction — the string Node's module cache keys on. */
	readonly resolved: string;
	/** `realpathSync.native` of it — the directory's own spelling. */
	readonly onDisk: string;
	/** Every `node_modules/<pkg>` junction that resolved to `resolved`, deduped, discovery order. */
	readonly via: readonly string[];
}

/** A package name this suite would load under more than one path string. */
export interface SpellingDisagreement {
	readonly packageName: string;
	/** One entry per distinct `resolved`, so always two or more. */
	readonly spellings: readonly PackageSpelling[];
}

/**
 * A directory an `import '<pkg>'` is resolved from, with the names such an import
 * could plausibly name there.
 *
 * Walking contexts rather than directories is what Node itself does: a package
 * reached through a junction resolves its own imports from its own directory, not
 * from whoever imported it, which is exactly how one suite ends up holding two
 * spellings of one package.
 */
interface LoadingContext {
	readonly dir: string;
	readonly candidates: readonly string[];
}

/** Resolved path -> the junctions that produced it, per package name. */
type SpellingIndex = Map<string, Map<string, string[]>>;

/** Every linked target of `targets` that this suite would load under two or more path strings. */
export function findSpellingDisagreements(targets: readonly BuildTarget[], setupUrl: string): SpellingDisagreement[] {
	const linkedNames = targets.filter((target) => target.location === 'linked').map((target) => target.packageName);
	if (linkedNames.length === 0) return [];

	const found = collectSpellings(seedContexts(targets, linkedNames, setupUrl), linkedNames);
	return [...found].flatMap(([packageName, byResolved]) => (
		byResolved.size < 2 ? [] : [{ packageName, spellings: [...byResolved].map(describeSpelling) }]
	));
}

/** Throws, naming the spellings, the junctions and the remedy, when there is any disagreement. */
export function assertOneSpellingPerLinkedPackage(targets: readonly BuildTarget[], setupUrl: string): void {
	const disagreements = findSpellingDisagreements(targets, setupUrl);
	if (disagreements.length === 0) return;

	throw new Error(disagreementMessage(disagreements, dirname(fileURLToPath(setupUrl))));
}

/**
 * The contexts the walk starts from: the suite's own directory, and the root of
 * every `workspace` target.
 *
 * A workspace package is reached through a `@serfab/*` junction, so Node resolves
 * *its* imports from its own directory rather than from the suite's — and that is
 * how the repo-root junctions enter a reference app's run at all, since the app's
 * own `node_modules` answers first for anything it carries itself.
 */
function seedContexts(targets: readonly BuildTarget[], linkedNames: readonly string[], setupUrl: string): LoadingContext[] {
	// Eager, and deliberately unguarded, as in `assertBuildFresh`: a call site
	// passing a plain path rather than a URL should fail here and loudly.
	const suiteDir = dirname(fileURLToPath(setupUrl));

	// The suite's own files may import any of its curated linked targets, so the
	// whole list is the candidate set here. Every other context is narrowed to
	// what its own manifest declares.
	const contexts: LoadingContext[] = [{ dir: suiteDir, candidates: linkedNames }];

	const workspaceTargets = targets.filter((target) => target.location === 'workspace');
	if (workspaceTargets.length === 0) return contexts;

	const roots = workspacePackageRoots();
	for (const target of workspaceTargets) {
		const root = roots.get(target.packageName);
		// A name no workspace declares is `assertBuildFresh`'s problem to report,
		// not this check's.
		if (root !== undefined) contexts.push({ dir: root, candidates: declaredCandidates(root, linkedNames) });
	}
	return contexts;
}

/**
 * Resolves every candidate from every reachable context, recording which junction
 * produced which path string.
 *
 * Breadth-first so that this repository's own junctions are recorded before the
 * ones a sibling's install wrote: the first `via` the message prints for a
 * spelling is then the one its reader can act on. The walk is bounded by
 * `visited`, keyed on the context path *string* — two spellings of one directory
 * are deliberately separate contexts, because each discovers the junctions stored
 * beneath its own spelling, which is the disagreement itself.
 */
function collectSpellings(seeds: readonly LoadingContext[], linkedNames: readonly string[]): SpellingIndex {
	const found: SpellingIndex = new Map();
	const queue = [...seeds];
	const visited = new Set<string>();

	for (let i = 0; i < queue.length; i++) {
		const context = queue[i];
		if (visited.has(context.dir)) continue;
		visited.add(context.dir);

		for (const name of context.candidates) {
			const resolved = resolveLinkedPackageFrom(context.dir, name);
			// A registry-installed copy cannot disagree about a sibling's spelling,
			// and a package that is absent is never loaded.
			if (resolved.status !== 'linked') continue;

			recordSpelling(found, name, resolved.root, resolved.junction);
			queue.push({ dir: resolved.root, candidates: declaredCandidates(resolved.root, linkedNames) });
		}
	}
	return found;
}

function recordSpelling(found: SpellingIndex, packageName: string, resolved: string, junction: string): void {
	const byResolved = found.get(packageName) ?? new Map<string, string[]>();
	found.set(packageName, byResolved);

	const via = byResolved.get(resolved) ?? [];
	byResolved.set(resolved, via);
	if (!via.includes(junction)) via.push(junction);
}

/**
 * The names `dir`'s own manifest imports, among `linkedNames`.
 *
 * Load-bearing rather than tidiness: without this filter a sibling resolves its
 * *own* package name from inside its own checkout — `@quereus/quereus` from
 * `C:\Projects\Quereus\packages\quereus`, where the only matches for that name
 * are JSDoc examples — and the walk reports a disagreement for an import nothing
 * performs.
 */
function declaredCandidates(dir: string, linkedNames: readonly string[]): string[] {
	const manifest = readPackageJson(join(dir, 'package.json'));
	const declared = new Set([
		...Object.keys(manifest?.dependencies ?? {}),
		...Object.keys(manifest?.peerDependencies ?? {}),
		...Object.keys(manifest?.optionalDependencies ?? {}),
	]);
	return linkedNames.filter((name) => declared.has(name));
}

function describeSpelling([resolved, via]: [string, string[]]): PackageSpelling {
	return { resolved, onDisk: nativeSpelling(resolved), via };
}

/** How the filesystem itself spells `path`, or `path` unchanged when it cannot say. */
function nativeSpelling(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		// A path that will not canonicalise still has the spelling the loader keys
		// on, which is the half of the message that matters. Reporting it unchanged
		// is better than dropping the whole finding over a missing extra.
		return path;
	}
}

/**
 * The refusal, built so that a reader who has never met this failure can act on
 * it: what disagrees, where, what it costs, and what to do.
 */
function disagreementMessage(disagreements: readonly SpellingDisagreement[], suiteDir: string): string {
	return [
		'A linked package resolves to more than one path spelling, so these tests would load it twice:',
		...disagreements.map(describePackage),
		'',
		'Node keys its module cache by the resolved path string, so each spelling is a separate copy of the package. '
		+ 'The copies share no classes, so every `instanceof` across them is false: an error thrown by one is not '
		+ 'recognised by code that imported the other, and that reads as a bug in this repository rather than in the install.',
		'',
		'Remedy:',
		...remedy(foreignCheckouts(disagreements, findWorkspaceRoot(suiteDir))),
	].join('\n');
}

function describePackage(disagreement: SpellingDisagreement): string {
	const spellings = disagreement.spellings.flatMap((spelling) => [
		`      ${spelling.resolved}${spelling.onDisk === spelling.resolved ? '' : ` (the directory is spelled ${spelling.onDisk} on disk)`}`,
		...spelling.via.map((junction) => `        via ${junction}`),
	]);
	return [`  - ${disagreement.packageName}, under ${disagreement.spellings.length} spellings:`, ...spellings].join('\n');
}

/**
 * The checkouts, outside this repository, that hold one of the disagreeing
 * junctions — a sibling's own install wrote those, and they are read-only here.
 *
 * Reported as checkouts rather than as the junctions themselves, because the
 * junctions are already listed above and a sibling reached under both spellings
 * contributes a dozen of them. The remedy has to name the thing a reader acts on,
 * which is the checkout. Canonicalised, so two spellings of one sibling collapse
 * to one entry.
 *
 * With no workspace root above `suiteDir` (only reachable from temp-dir
 * fixtures), nothing can be called ours, so every junction counts as foreign and
 * the message takes the more cautious branch.
 */
function foreignCheckouts(disagreements: readonly SpellingDisagreement[], repoRoot: string | undefined): string[] {
	const junctions = disagreements.flatMap((d) => d.spellings.flatMap((spelling) => [...spelling.via]));
	const foreign = repoRoot === undefined ? junctions : junctions.filter((junction) => !isInside(repoRoot, junction));
	return [...new Set(foreign.map((junction) => nativeSpelling(findWorkspaceRoot(junction) ?? dirname(junction))))];
}

/** What to do about it, as one bullet per step; the first two differ by whose junctions disagree. */
function remedy(foreign: readonly string[]): string[] {
	const repoint = "  - To repoint one of this repository's own junctions, delete it NON-recursively and recreate it: in "
		+ "PowerShell, `[System.IO.Directory]::Delete('<junction>', $false)` then "
		+ "`New-Item -ItemType Junction -Path '<junction>' -Target '<chosen spelling>'`. Never a recursive delete "
		+ 'anywhere near these (tickets/rules/sibling-repos.md).';
	const notInstall = "  - `yarn install` is not the fix. It rewrites every junction from the root `package.json`'s "
		+ '`resolutions`, so they would agree with each other and may still disagree with the nested links a '
		+ "sibling's own install wrote.";

	if (foreign.length === 0) {
		return [
			"  - Every junction above is in this repository's own `node_modules`, so repoint the odd ones out to the "
			+ 'spelling the others use.',
			repoint,
			notInstall,
		];
	}
	return [
		`  - Some junctions above are inside a sibling checkout (${foreign.join(', ')}), written by its own install. `
		+ 'They are read-only from here (tickets/rules/sibling-repos.md): do not write in the sibling.',
		"  - So either repoint this repository's own junctions to the spelling the sibling uses, or rename the "
		+ "sibling's folder to match the `link:` paths in the root `package.json` — after which its owner reinstalls "
		+ 'it, because its existing nested links still store the old spelling.',
		repoint,
		notInstall,
	];
}

/**
 * Whether `path` sits inside `root`.
 *
 * Case-insensitive on Windows, which is the comparison the filesystem itself
 * makes — and case is precisely what the two spellings in play differ in, so an
 * exact compare could call one of this repository's own junctions foreign and
 * send the reader to a sibling that has nothing to do with it.
 */
function isInside(root: string, path: string): boolean {
	const prefix = root.endsWith(sep) ? root : root + sep;
	return process.platform === 'win32'
		? path.toLowerCase().startsWith(prefix.toLowerCase())
		: path.startsWith(prefix);
}
