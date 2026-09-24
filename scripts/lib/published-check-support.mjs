/**
 * The parts of `scripts/check-published.mjs` that are pure functions of a manifest,
 * of git's output, or of a directory tree on disk. Split out so they can be
 * exercised against fixtures by `scripts/check-published.test.mjs` without a git
 * worktree, an install, or a network — the entry script keeps only the orchestration
 * that nothing but a real run can cover.
 */

import { existsSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findPackageDir, readJson } from './published-smoke-support.mjs';

/** Accepted command-line flags, mapped to the option they set. */
const KNOWN_FLAGS = new Map([
	['--allow-dirty', 'allowDirty'],
	['--keep', 'keep']
]);

/** The scopes whose resolved copies the run exists to report on. */
const SIBLING_SCOPES = ['@optimystic/', '@quereus/'];

/** Manifest fields a workspace can declare a sibling dependency in. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * `yarn install` in the worktree. Dropping `resolutions` necessarily rewrites the
 * lockfile, and Yarn makes installs immutable by default whenever `CI` is set —
 * without the flag this fails in exactly the environment the check is most wanted in.
 */
export const INSTALL_ARGS = ['install', '--no-immutable'];

/**
 * The root scripts run in the worktree, in order. `build` first because every other
 * one reads compiled output: `lint` is type-aware, `typecheck` walks the same
 * programs, and `test` runs against each package's `dist`.
 */
export const WORKTREE_GATES = ['build', 'lint', 'typecheck', 'test'];

/**
 * Parse the flags, rejecting anything unrecognised. A silently ignored typo
 * (`--allowdirty`) would check a commit the caller did not mean to check.
 */
export function parseFlags(argv) {
	const flags = { allowDirty: false, keep: false };
	for (const arg of argv) {
		const option = KNOWN_FLAGS.get(arg);
		if (!option) {
			throw new Error(`unknown flag "${arg}" — expected any of: ${[...KNOWN_FLAGS.keys()].join(', ')}`);
		}
		flags[option] = true;
	}
	return flags;
}

/**
 * The paths `git status --porcelain` reports as differing from `HEAD`, untracked
 * ones (`??`) included. The worktree is built from the commit, so an untracked new
 * source file is just as absent from it as an unstaged edit — both mean the run
 * would describe something other than what the caller has in front of them.
 */
export function dirtyPaths(porcelain) {
	return porcelain
		.split('\n')
		.map((line) => line.slice(3).trim())
		.filter((path) => path.length > 0);
}

/**
 * The root manifest with `resolutions` deleted, plus what that deletion changed.
 *
 * The whole key goes, not only its `link:` entries: `resolutions` is a
 * workspace-root mechanism that never reaches an installing consumer, so keeping
 * part of it would leave the worktree resolving something no consumer can. Nothing
 * else is touched — the point is to change one thing and re-run the same gates.
 *
 * `delinked` is the set that stops pointing at a sibling checkout and starts coming
 * from the registry, which is what the run is about; `alsoDropped` is anything else
 * the key held, reported because dropping it is a side effect rather than the goal.
 */
export function delinkedManifest(manifestText) {
	const manifest = JSON.parse(manifestText);
	const entries = Object.entries(manifest.resolutions ?? {});
	delete manifest.resolutions;

	return {
		text: `${JSON.stringify(manifest, null, 2)}\n`,
		delinked: entries.filter(([, range]) => range.startsWith('link:')).map(([name]) => name).sort(),
		alsoDropped: entries.filter(([, range]) => !range.startsWith('link:')).map(([name]) => name).sort()
	};
}

/** Every `packages/*` holding a `package.json`, as `{ dir, manifest }`. */
export function workspacePackages(rootDir) {
	// Mirrors the root `workspaces` glob (`packages/*`), as the type-check gates do
	// in `scripts/lib/typecheck-programs.mjs`. If workspaces ever grow a second root,
	// teach both.
	const packagesDir = join(rootDir, 'packages');
	if (!existsSync(packagesDir)) {
		return [];
	}
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name))
		.filter((dir) => existsSync(join(dir, 'package.json')))
		.map((dir) => ({ dir, manifest: readJson(join(dir, 'package.json')) }));
}

/**
 * The dependency names the report covers: every name the root `resolutions` block
 * redirects with `link:` — the exact set the worktree de-links — plus any other
 * `@optimystic/*` or `@quereus/*` package a workspace declares. The latter arrive
 * from the registry in both install shapes, so they are unchanged by the de-link and
 * are printed beside the rest to say so.
 */
export function reportedSiblingNames(rootManifest, workspaces) {
	const names = new Set(Object.keys(rootManifest.resolutions ?? {}));
	for (const { manifest } of workspaces) {
		for (const field of DEP_FIELDS) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (SIBLING_SCOPES.some((scope) => name.startsWith(scope))) {
					names.add(name);
				}
			}
		}
	}
	return [...names].sort();
}

/**
 * Where each workspace resolves a sibling to, when that is not the copy hoisted at
 * the worktree root. The reference apps declare `installConfig.hoistingLimits:
 * "workspaces"` and so get their own `node_modules`; a report of the hoisted view
 * alone would describe artifacts their suites never loaded.
 */
export function nestedSiblingCopies(rootDir, workspaces, names) {
	const hoisted = new Map(names.map((name) => [name, findPackageDir(rootDir, name)]));

	const copies = [];
	for (const { dir, manifest } of workspaces) {
		for (const name of names) {
			const found = findPackageDir(dir, name);
			if (found === null || found === hoisted.get(name)) {
				continue;
			}
			copies.push({ consumer: manifest.name, name, version: readJson(join(found, 'package.json')).version, dir: found });
		}
	}
	return copies;
}

/**
 * Every symbolic link and Windows junction under `dir`, found without following any
 * of them. Order does not matter: a link is never descended into, so removing one
 * can never hide another.
 */
export function reparsePointsUnder(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// An unreadable directory holds nothing this can unlink; the delete that
		// follows will report it if it matters.
		return [];
	}

	const found = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isSymbolicLink()) found.push(path);
		else if (entry.isDirectory()) found.push(...reparsePointsUnder(path));
	}
	return found;
}

/**
 * Remove every link under `dir` without touching what any of them points at, and
 * return the paths removed.
 *
 * `docs/testing.md` records what this exists to prevent: on Windows, a recursive
 * delete of a checkout whose `node_modules` still held the `link:` junctions
 * followed them and emptied the sibling checkouts in `../optimystic` and
 * `../quereus`. `check-published`'s worktree has no `resolutions` and so no sibling
 * junctions — but it is full of the ones yarn writes for the workspaces themselves,
 * and unlinking first is cheaper than depending on every delete path getting the
 * exception right.
 */
export function unlinkReparsePoints(dir) {
	const links = reparsePointsUnder(dir);
	for (const link of links) {
		try {
			unlinkSync(link);
		} catch (err) {
			// Windows refuses `unlink` on a directory junction or directory symlink;
			// `rmdir` removes the link itself and never follows it. POSIX rejects that
			// call on a symlink, which is why it is the fallback rather than the rule.
			if (err.code !== 'EPERM' && err.code !== 'EISDIR' && err.code !== 'EACCES') {
				throw err;
			}
			rmdirSync(link);
		}
	}
	return links;
}

/**
 * `path` in the form Windows accepts past its 260-character limit.
 *
 * Deep `node_modules` trees exceed it, and `git worktree remove --force` gives up
 * there with `Filename too long` (observed on this machine, 2026-09-24) having
 * already de-registered the worktree — so the fallback delete has to reach paths git
 * could not. `resolve` first because the extended form disables path normalisation:
 * it must be absolute and backslash-separated.
 */
export function longPath(path) {
	if (process.platform !== 'win32' || path.startsWith('\\\\?\\')) {
		return path;
	}
	return `\\\\?\\${resolve(path)}`;
}
