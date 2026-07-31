/**
 * Unit tests for the stale-build guard.
 *
 * The guard's worst failure mode is silent: if it stops detecting staleness it
 * never fires, and nothing else in the suite notices. These tests pin both
 * directions — stale is reported, fresh (and touched-test-file) is not.
 *
 * The linked-sibling half has a second failure mode that is loud instead of
 * silent: judging a package that was installed from the registry rather than
 * symlinked into a working copy reports a permanent "stale" nobody can fix. Both
 * directions are pinned here too.
 *
 * The third failure mode is looking in the wrong `node_modules` — a package with
 * its own installs resolves its siblings locally, not from the repo root, so the
 * chain walk and its bounds get their own fixture at the bottom of this file.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertBuildFresh, checkBuildFreshness, checkLinkedTarget, resolveLinkedPackage, resolveLinkedPackageFrom, type BuildTarget } from './build-freshness.js';

const DIST_ENTRY = 'dist/index.js';
/** Seconds since epoch; `dist` sits between OLD and NEW so either side can win. */
const OLD = 1_700_000_000;
const BUILT = OLD + 100;
const NEW = BUILT + 100;

/** Writes `path` with the given mtime, creating parent dirs. */
function writeFixture(path: string, mtimeSeconds: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, '// fixture\n');
	utimesSync(path, mtimeSeconds, mtimeSeconds);
}

describe('checkBuildFreshness', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'build-freshness-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Writes `<root>/<relPath>` with the given mtime, creating parent dirs. */
	function writeAt(relPath: string, mtimeSeconds: number): void {
		writeFixture(join(root, relPath), mtimeSeconds);
	}

	function buildDist(): void {
		writeAt(DIST_ENTRY, BUILT);
	}

	it('reports missing when the dist entry point does not exist', () => {
		writeAt('src/index.ts', OLD);

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('missing');
	});

	it('reports fresh when every source predates the build', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/nested/deep/helper.ts', OLD);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('reports stale when a top-level source postdates the build', () => {
		writeAt('src/index.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('reports stale when a deeply nested source postdates the build', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/a/b/c/deep.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('ignores test and spec files, which are not build inputs', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/index.test.ts', NEW);
		writeAt('src/index.spec.ts', NEW);
		writeAt('src/component.test.tsx', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('ignores the test and __tests__ directories', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/__tests__/fixture.ts', NEW);
		writeAt('src/test/helper.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('still trips on a non-test file living beside excluded ones', () => {
		writeAt('src/index.test.ts', NEW);
		writeAt('src/constants.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('reports fresh when there is no src directory to compare against', () => {
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	/**
	 * The incremental-emit case, and the reason freshness is judged by the whole
	 * output tree rather than by the entry point: `tsc --incremental` rewrites
	 * only the outputs a change affects, so editing one module leaves
	 * `dist/index.js` at the mtime of some earlier build. Judged by the entry
	 * point alone the package stays stale however often it is rebuilt.
	 */
	it('reports fresh when a rebuild touched other outputs but not the entry point', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/feature.ts', NEW);
		buildDist();
		writeAt('dist/feature.js', NEW + 1);
		writeAt('dist/tsconfig.tsbuildinfo', NEW + 1);

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('reports stale when a source postdates every output, not only the entry point', () => {
		writeAt('src/index.ts', NEW);
		buildDist();
		writeAt('dist/feature.js', BUILT);
		writeAt('dist/nested/deep.js', BUILT);

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('falls back to the entry point when it has no output directory above it', () => {
		writeAt('src/index.ts', NEW);
		writeAt('index.js', BUILT);

		expect(checkBuildFreshness(root, 'index.js')).toBe('stale');
	});
});

/**
 * `assertBuildFresh` resolves against the real repository — a workspace target is
 * looked up under `packages/`, a linked one through the `node_modules` chain above
 * the calling setup module — so these cases use names no install can produce
 * rather than temp-dir fixtures. What is pinned is the contract every caller
 * depends on: silence when there is nothing to report, and one throw naming
 * *every* problem at once, because a run aborted over the first stale package
 * sends someone back for a second build.
 */
describe('assertBuildFresh', () => {
	const absent = (packageName: string, location: BuildTarget['location']): BuildTarget =>
		({ packageName, distEntry: DIST_ENTRY, location });

	it('passes an empty target list', () => {
		expect(() => assertBuildFresh([], import.meta.url)).not.toThrow();
	});

	it('throws when a workspace target names no package under packages/', () => {
		expect(() => assertBuildFresh([absent('@serfab/not-a-package', 'workspace')], import.meta.url))
			.toThrow(/@serfab\/not-a-package: no workspace under packages\/ declares this name\. Run: yarn install/);
	});

	it('throws when a linked target is not installed', () => {
		expect(() => assertBuildFresh([absent('@nobody/not-installed', 'linked')], import.meta.url))
			.toThrow(/@nobody\/not-installed: not installed .*\. Run: yarn install/);
	});

	it('reports every problem in one throw, one per line', () => {
		const problems = [absent('@serfab/not-a-package', 'workspace'), absent('@nobody/not-installed', 'linked')];

		expect(() => assertBuildFresh(problems, import.meta.url)).toThrow(/@serfab\/not-a-package[\s\S]*@nobody\/not-installed/);
		expect(() => assertBuildFresh(problems, import.meta.url)).toThrow(/Stale build detected/);
	});

	it('rejects a plain directory where a module URL belongs', () => {
		expect(() => assertBuildFresh([], dirname(fileURLToPath(import.meta.url)))).toThrow();
	});
});

/**
 * Fixture shape, mirroring how `../optimystic` and `../quereus` are wired in:
 *
 *   <tmp>/node_modules/@sibling/pkg  ->  <tmp>/sibling-repo/packages/pkg
 *   <tmp>/sibling-repo/package.json      (declares `workspaces`, so it is the
 *                                         checkout named in the remedy)
 *
 * `checkLinkedTarget` is given `<tmp>` — a consuming suite's directory, which is
 * what it takes — and reaches `<tmp>/node_modules` by walking, exactly as it does
 * in a real suite. `resolveLinkedPackage` is given the `node_modules` directory
 * itself, since it classifies one directory and does no walking.
 */
const SIBLING_ENTRY = 'dist/src/index.js';
const LINKED_TARGET: BuildTarget = {
	packageName: '@sibling/pkg',
	distEntry: SIBLING_ENTRY,
	location: 'linked',
};

describe('linked sibling packages', () => {
	let tmp: string;
	let nodeModules: string;
	let installedAt: string;
	let siblingRepo: string;
	let siblingPkg: string;

	beforeEach(() => {
		// `realpath` because macOS hands out a symlinked tmpdir, and the remedy
		// message is built from the resolved path.
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'linked-freshness-')));
		nodeModules = join(tmp, 'node_modules');
		installedAt = join(nodeModules, '@sibling', 'pkg');
		siblingRepo = join(tmp, 'sibling-repo');
		siblingPkg = join(siblingRepo, 'packages', 'pkg');

		mkdirSync(join(nodeModules, '@sibling'), { recursive: true });
		mkdirSync(siblingRepo, { recursive: true });
		writeFileSync(join(siblingRepo, 'package.json'), '{"name":"sibling","workspaces":["packages/*"]}\n');
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** Compiles the sibling working copy — i.e. gives it a `dist` entry point. */
	function buildSibling(): void {
		writeFixture(join(siblingPkg, SIBLING_ENTRY), BUILT);
	}

	function editSibling(mtimeSeconds: number): void {
		writeFixture(join(siblingPkg, 'src', 'index.ts'), mtimeSeconds);
	}

	/** What `yarn install` leaves for a `link:` resolution. */
	function linkSibling(): void {
		mkdirSync(siblingPkg, { recursive: true });
		symlinkSync(siblingPkg, installedAt, 'junction');
	}

	/** What `yarn install` leaves for an ordinary registry dependency. */
	function installCopy(srcMtime: number, distMtime: number): void {
		writeFixture(join(installedAt, SIBLING_ENTRY), distMtime);
		writeFixture(join(installedAt, 'src', 'index.ts'), srcMtime);
	}

	describe('resolveLinkedPackage', () => {
		it('resolves a symlink to the working copy it points at', () => {
			linkSibling();

			expect(resolveLinkedPackage(nodeModules, '@sibling/pkg')).toEqual({ status: 'linked', root: siblingPkg });
		});

		it('reports not-linked for a real directory installed from the registry', () => {
			installCopy(NEW, BUILT);

			expect(resolveLinkedPackage(nodeModules, '@sibling/pkg')).toEqual({ status: 'not-linked' });
		});

		it('reports absent when there is nothing at that path, so the walk can continue', () => {
			expect(resolveLinkedPackage(nodeModules, '@sibling/pkg')).toEqual({ status: 'absent' });
		});

		it('reports unresolved when the symlink points somewhere that no longer exists', () => {
			linkSibling();
			rmSync(siblingRepo, { recursive: true, force: true });

			const resolved = resolveLinkedPackage(nodeModules, '@sibling/pkg');

			expect(resolved.status).toBe('unresolved');
			expect(resolved).toHaveProperty('detail', expect.stringContaining('no longer exists'));
		});
	});

	describe('checkLinkedTarget', () => {
		it('passes a linked sibling whose build postdates its sources', () => {
			linkSibling();
			editSibling(OLD);
			buildSibling();

			expect(checkLinkedTarget(tmp, LINKED_TARGET)).toBeUndefined();
		});

		it('reports a linked sibling edited after its last build, naming its own checkout', () => {
			linkSibling();
			buildSibling();
			editSibling(NEW);

			const problem = checkLinkedTarget(tmp, LINKED_TARGET);

			expect(problem).toContain('dist is stale');
			expect(problem).toContain(`Run in ${siblingRepo}: yarn workspace @sibling/pkg build`);
		});

		it('reports a linked sibling that has never been built', () => {
			linkSibling();
			editSibling(OLD);

			const problem = checkLinkedTarget(tmp, LINKED_TARGET);

			expect(problem).toContain(`not built (missing ${SIBLING_ENTRY})`);
			expect(problem).toContain(`Run in ${siblingRepo}: yarn workspace @sibling/pkg build`);
		});

		it('falls back to a plain build command when the sibling is not in a workspace', () => {
			const lonely = join(tmp, 'lonely');
			writeFixture(join(lonely, SIBLING_ENTRY), BUILT);
			writeFixture(join(lonely, 'src', 'index.ts'), NEW);
			symlinkSync(lonely, installedAt, 'junction');

			expect(checkLinkedTarget(tmp, LINKED_TARGET)).toContain(`Run in ${lonely}: yarn build`);
		});

		it('skips a registry-installed copy even when packing left src newer than dist', () => {
			// The real case this guards: `@optimystic/db-p2p-storage-fs` ships both
			// `src` and `dist`, and packing wrote `src` milliseconds later — so
			// judging it would report a "stale" build that nobody can make fresh.
			installCopy(BUILT + 1, BUILT);

			expect(checkLinkedTarget(tmp, LINKED_TARGET)).toBeUndefined();
		});

		it('reports a dangling symlink as an install problem', () => {
			linkSibling();
			buildSibling();
			rmSync(siblingRepo, { recursive: true, force: true });

			const problem = checkLinkedTarget(tmp, LINKED_TARGET);

			expect(problem).toContain('no longer exists');
			expect(problem).toContain('Run: yarn install');
		});

		it('reports a dependency that is not installed at all', () => {
			expect(checkLinkedTarget(tmp, LINKED_TARGET)).toContain('not installed');
		});
	});
});

/**
 * The `node_modules` walk, on the layout that made it necessary: a package
 * declaring `installConfig.hoistingLimits: "workspaces"` (the reference apps)
 * gets its dependencies installed into its *own* `node_modules`, so the copy its
 * suite loads is not the one at the repo root — and judging the root's copy would
 * report on code that never runs.
 *
 *   <tmp>/node_modules/@sibling/pkg                   -> above the repo root; never consulted
 *   <tmp>/repo/package.json                              (declares `workspaces` — the walk's bound)
 *   <tmp>/repo/node_modules/@sibling/pkg              -> <tmp>/hoisted
 *   <tmp>/repo/packages/app/node_modules/@sibling/pkg -> <tmp>/local
 *   <tmp>/repo/packages/app/test                         (the `fromDir`)
 *
 * The two link targets are *different* working copies on purpose: a fixture where
 * both point at the same directory cannot tell which one the walk picked.
 */
describe('node_modules chain', () => {
	let tmp: string;
	let repo: string;
	let fromDir: string;
	/** `node_modules` directories, nearest first plus the one out of bounds. */
	let appNodeModules: string;
	let repoNodeModules: string;
	let outsideNodeModules: string;
	/** Working copies the links point at, one per `node_modules` in the chain. */
	let local: string;
	let hoisted: string;
	let outside: string;

	beforeEach(() => {
		tmp = realpathSync(mkdtempSync(join(tmpdir(), 'chain-freshness-')));
		repo = join(tmp, 'repo');
		const app = join(repo, 'packages', 'app');
		fromDir = join(app, 'test');
		appNodeModules = join(app, 'node_modules');
		repoNodeModules = join(repo, 'node_modules');
		outsideNodeModules = join(tmp, 'node_modules');
		local = join(tmp, 'local');
		hoisted = join(tmp, 'hoisted');
		outside = join(tmp, 'outside');

		mkdirSync(fromDir, { recursive: true });
		writeFileSync(join(repo, 'package.json'), '{"name":"repo","workspaces":["packages/*"]}\n');
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	/** A built, up-to-date working copy at `root`. */
	function workingCopy(root: string): string {
		writeFixture(join(root, 'src', 'index.ts'), OLD);
		writeFixture(join(root, SIBLING_ENTRY), BUILT);
		return root;
	}

	/** What `yarn install` leaves in `nodeModulesDir` for a `link:` resolution. */
	function link(nodeModulesDir: string, target: string): void {
		mkdirSync(join(nodeModulesDir, '@sibling'), { recursive: true });
		symlinkSync(target, join(nodeModulesDir, '@sibling', 'pkg'), 'junction');
	}

	/** What `yarn install` leaves in `nodeModulesDir` for a registry dependency. */
	function installCopy(nodeModulesDir: string): void {
		writeFixture(join(nodeModulesDir, '@sibling', 'pkg', SIBLING_ENTRY), BUILT);
	}

	it('prefers the package-local install over the one at the repo root', () => {
		link(appNodeModules, workingCopy(local));
		link(repoNodeModules, workingCopy(hoisted));

		expect(resolveLinkedPackageFrom(fromDir, '@sibling/pkg')).toEqual({ status: 'linked', root: local });
	});

	it('walks on to the repo root when the package has no local install', () => {
		link(repoNodeModules, workingCopy(hoisted));

		expect(resolveLinkedPackageFrom(fromDir, '@sibling/pkg')).toEqual({ status: 'linked', root: hoisted });
	});

	it('stops at a package-local registry copy rather than recovering to the root link', () => {
		installCopy(appNodeModules);
		link(repoNodeModules, workingCopy(hoisted));

		// Node would load the local copy, so the root's link is not what runs.
		expect(resolveLinkedPackageFrom(fromDir, '@sibling/pkg')).toEqual({ status: 'not-linked' });
	});

	it('stops at a dangling package-local link rather than falling through to the root', () => {
		link(appNodeModules, workingCopy(local));
		rmSync(local, { recursive: true, force: true });
		link(repoNodeModules, workingCopy(hoisted));

		const resolved = resolveLinkedPackageFrom(fromDir, '@sibling/pkg');

		expect(resolved.status).toBe('unresolved');
		expect(resolved).toHaveProperty('detail', expect.stringContaining('no longer exists'));
	});

	it('reports every directory it searched when the package is nowhere in the chain', () => {
		const resolved = resolveLinkedPackageFrom(fromDir, '@sibling/pkg');

		expect(resolved.status).toBe('unresolved');
		expect(resolved).toHaveProperty('detail', expect.stringContaining('not installed'));
		expect(resolved).toHaveProperty('detail', expect.stringContaining(appNodeModules));
		expect(resolved).toHaveProperty('detail', expect.stringContaining(repoNodeModules));
	});

	it('does not consult a node_modules above the monorepo root', () => {
		link(outsideNodeModules, workingCopy(outside));

		const resolved = resolveLinkedPackageFrom(fromDir, '@sibling/pkg');

		expect(resolved.status).toBe('unresolved');
		expect(resolved).toHaveProperty('detail', expect.not.stringContaining(outsideNodeModules));
	});

	it('judges the package-local working copy, not the hoisted one', () => {
		link(appNodeModules, workingCopy(local));
		link(repoNodeModules, workingCopy(hoisted));
		writeFixture(join(local, 'src', 'index.ts'), NEW);

		const problem = checkLinkedTarget(fromDir, LINKED_TARGET);

		expect(problem).toContain('dist is stale');
		expect(problem).toContain(local);
		expect(problem).not.toContain(hoisted);
	});
});
