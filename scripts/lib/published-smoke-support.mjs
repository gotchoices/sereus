/**
 * The parts of `scripts/smoke-published-install.mjs` that are pure functions of the
 * repository on disk, or of an already-installed `node_modules` tree. Split out so
 * they can be exercised against fixtures by
 * `scripts/smoke-published-install.test.mjs` without packing, installing, or a
 * network — the entry script keeps only the process orchestration that nothing but a
 * real run can cover.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Accepted command-line flags, mapped to the option they set. */
const KNOWN_FLAGS = new Map([
	['--skip-build', 'skipBuild'],
	['--keep', 'keep']
]);

export function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Parse the flags, rejecting anything unrecognised. A silently ignored typo
 * (`--skipbuild`) would start a full monorepo build the caller did not ask for.
 */
export function parseFlags(argv) {
	const flags = { skipBuild: false, keep: false };
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
 * The publishable set is whatever the root `pub:*` scripts publish — one source of
 * truth, so a new publishable package is covered the moment it gets a `pub:` script.
 */
export function publishableWorkspaces(rootDir) {
	const scripts = readJson(join(rootDir, 'package.json')).scripts ?? {};
	const workspaces = [];
	for (const [name, body] of Object.entries(scripts)) {
		if (!name.startsWith('pub:')) {
			continue;
		}
		const match = /publish-package\.(?:js|mjs)\s+(\S+)/.exec(body);
		if (!match) {
			throw new Error(`root script "${name}" does not name a package directory: ${body}`);
		}
		const dir = join(rootDir, 'packages', match[1]);
		const manifest = readJson(join(dir, 'package.json'));
		workspaces.push({ dir, manifest, tarballName: `${manifest.name.replace('@', '').replace('/', '-')}.tgz` });
	}
	if (workspaces.length === 0) {
		throw new Error('no `pub:*` scripts found in the root package.json — nothing to pack');
	}
	return workspaces;
}

/**
 * The declared range for a package the scratch project must depend on directly.
 * Read off the in-repo manifests: `pack` only rewrites `workspace:` protocol ranges,
 * so for a registry dependency the packed manifest carries this exact string.
 *
 * Every publishable workspace is consulted, and a disagreement is an error rather
 * than a first-match win: the scratch project installs exactly one copy, so if two
 * of our packages want different ranges there is no single right answer to pick
 * silently. `devDependencies` count — `@libp2p/websockets` is a dev dependency of
 * `@serfab/cadre-core` and a real one of `@serfab/quereus-plugin-sereus`, and it is
 * the same transport either way.
 */
export function declaredRange(workspaces, depName) {
	const owners = new Map();
	for (const { manifest } of workspaces) {
		for (const field of ['dependencies', 'devDependencies']) {
			const range = manifest[field]?.[depName];
			if (range) {
				owners.set(range, [...(owners.get(range) ?? []), `${manifest.name} (${field})`]);
			}
		}
	}
	if (owners.size === 0) {
		throw new Error(`no publishable workspace declares "${depName}" — the scratch project cannot pin it`);
	}
	if (owners.size > 1) {
		const detail = [...owners].map(([range, from]) => `"${range}" from ${from.join(', ')}`).join('; ');
		throw new Error(`publishable workspaces disagree on the range for "${depName}": ${detail}`);
	}
	return [...owners.keys()][0];
}

/** Every `@serfab/*`, `@optimystic/*` and `@quereus/*` name the publishable set depends on, plus `extra`. */
export function reportedPackages(workspaces, extra = []) {
	const names = new Set(extra);
	for (const { manifest } of workspaces) {
		names.add(manifest.name);
		for (const depName of Object.keys(manifest.dependencies ?? {})) {
			if (depName.startsWith('@serfab/') || depName.startsWith('@optimystic/') || depName.startsWith('@quereus/')) {
				names.add(depName);
			}
		}
	}
	return [...names].sort();
}

/**
 * Locate `spec` as node would from `fromDir`: walk up checking `node_modules/<spec>`.
 * Resolving from the *consumer's* directory rather than the project root is the whole
 * point — a naive lookup at the root once reported `@quereus/quereus` 0.16.4 while
 * `@serfab/cadre-core` was loading a nested 4.6.0 one level down.
 *
 * A directory walk rather than `createRequire().resolve` because several of these
 * packages are ESM-only with no `require` export condition, and `@quereus/quereus`
 * does not export `./package.json` at all — both make `require.resolve` throw on
 * packages that are installed and working.
 */
export function findPackageDir(fromDir, spec) {
	let dir = fromDir;
	for (;;) {
		const candidate = join(dir, 'node_modules', ...spec.split('/'));
		if (existsSync(join(candidate, 'package.json'))) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/** What each reported package resolves to from the consuming project's own root. */
export function hoistedVersions(projectDir, names) {
	return names.map((name) => {
		const dir = findPackageDir(projectDir, name);
		return dir === null
			? { name, version: null, dir: null }
			: { name, version: readJson(join(dir, 'package.json')).version, dir };
	});
}

/**
 * Direct dependencies that a publishable package resolves to something other than
 * the copy hoisted at the project root — the duplicate-instance failure the version
 * report exists to make visible.
 *
 * NOTE: one level deep by design; a duplicate below a publishable package's own
 * direct dependencies is not reported. If a duplicate ever hides there, widen this
 * to walk the installed tree rather than the manifests.
 */
export function nestedCopies(projectDir, workspaces) {
	const hoisted = new Map();
	const hoistedDir = (name) => {
		if (!hoisted.has(name)) {
			hoisted.set(name, findPackageDir(projectDir, name));
		}
		return hoisted.get(name);
	};

	const copies = [];
	for (const { manifest } of workspaces) {
		const consumerDir = findPackageDir(projectDir, manifest.name);
		if (!consumerDir) {
			continue;
		}
		for (const depName of Object.keys(manifest.dependencies ?? {})) {
			const dir = findPackageDir(consumerDir, depName);
			if (!dir || dir === hoistedDir(depName)) {
				continue;
			}
			copies.push({ consumer: manifest.name, dep: depName, version: readJson(join(dir, 'package.json')).version, dir });
		}
	}
	return copies;
}

/**
 * Which of our own packages npm satisfied from somewhere other than the tarball just
 * packed. The versions would look identical in the version report — `@serfab/*`
 * 0.9.0 is published — so without this check the smoke could silently exercise the
 * *previous* release rather than this build.
 */
export function tarballProvenance(projectDir, workspaces) {
	const lockPath = join(projectDir, 'package-lock.json');
	if (!existsSync(lockPath)) {
		return { lockfilePresent: false, wrong: [] };
	}
	const entries = readJson(lockPath).packages ?? {};
	const wrong = [];
	for (const { manifest, tarballName } of workspaces) {
		const resolved = entries[`node_modules/${manifest.name}`]?.resolved ?? '(absent from lockfile)';
		if (!resolved.includes(tarballName)) {
			wrong.push({ name: manifest.name, resolved });
		}
	}
	return { lockfilePresent: true, wrong };
}

/**
 * Publishable workspaces whose `dist` is missing, or older than their `src`. `pack`
 * does not build, so under `--skip-build` either state means the tarballs carry code
 * that is not what `src` says — and the smoke would print a pass for the *previous*
 * build, the exact false green this gate exists to prevent.
 *
 * A deliberate small re-derivation of `test-harness/build-freshness.ts`'s
 * `checkBuildFreshness`, not a call to it: that module is TypeScript with no build
 * step (vitest transpiles it as a global-setup import), so a plain node script cannot
 * import it. Same rule — newest source mtime versus newest build-output mtime.
 */
export function staleWorkspaces(workspaces) {
	const problems = [];
	for (const { dir, manifest } of workspaces) {
		const newestBuild = newestMtime(join(dir, 'dist'));
		if (newestBuild === undefined) {
			problems.push({ name: manifest.name, reason: 'missing' });
			continue;
		}
		const newestSrc = newestMtime(join(dir, 'src'));
		// An absent `src` cannot show anything stale (same rule as the test-harness guard).
		if (newestSrc !== undefined && newestSrc > newestBuild) {
			problems.push({ name: manifest.name, reason: 'stale' });
		}
	}
	return problems;
}

/** Newest mtime anywhere under `dir`; `undefined` if it is absent, unreadable, or empty. */
function newestMtime(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let newest;
	for (const entry of entries) {
		const path = join(dir, entry.name);
		const candidate = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
		if (candidate !== undefined && (newest === undefined || candidate > newest)) {
			newest = candidate;
		}
	}
	return newest;
}
