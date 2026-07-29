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
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkBuildFreshness, checkLinkedTarget, resolveLinkedPackage, type BuildTarget } from './build-freshness.js';

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
 * Fixture shape, mirroring how `../optimystic` and `../quereus` are wired in:
 *
 *   <tmp>/node_modules/@sibling/pkg  ->  <tmp>/sibling-repo/packages/pkg
 *   <tmp>/sibling-repo/package.json      (declares `workspaces`, so it is the
 *                                         checkout named in the remedy)
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

		it('reports unresolved when the dependency is not installed at all', () => {
			const resolved = resolveLinkedPackage(nodeModules, '@sibling/pkg');

			expect(resolved.status).toBe('unresolved');
			expect(resolved).toHaveProperty('detail', expect.stringContaining('not installed'));
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

			expect(checkLinkedTarget(nodeModules, LINKED_TARGET)).toBeUndefined();
		});

		it('reports a linked sibling edited after its last build, naming its own checkout', () => {
			linkSibling();
			buildSibling();
			editSibling(NEW);

			const problem = checkLinkedTarget(nodeModules, LINKED_TARGET);

			expect(problem).toContain('dist is stale');
			expect(problem).toContain(`Run in ${siblingRepo}: yarn workspace @sibling/pkg build`);
		});

		it('reports a linked sibling that has never been built', () => {
			linkSibling();
			editSibling(OLD);

			const problem = checkLinkedTarget(nodeModules, LINKED_TARGET);

			expect(problem).toContain(`not built (missing ${SIBLING_ENTRY})`);
			expect(problem).toContain(`Run in ${siblingRepo}: yarn workspace @sibling/pkg build`);
		});

		it('falls back to a plain build command when the sibling is not in a workspace', () => {
			const lonely = join(tmp, 'lonely');
			writeFixture(join(lonely, SIBLING_ENTRY), BUILT);
			writeFixture(join(lonely, 'src', 'index.ts'), NEW);
			symlinkSync(lonely, installedAt, 'junction');

			expect(checkLinkedTarget(nodeModules, LINKED_TARGET)).toContain(`Run in ${lonely}: yarn build`);
		});

		it('skips a registry-installed copy even when packing left src newer than dist', () => {
			// The real case this guards: `@optimystic/db-p2p-storage-fs` ships both
			// `src` and `dist`, and packing wrote `src` milliseconds later — so
			// judging it would report a "stale" build that nobody can make fresh.
			installCopy(BUILT + 1, BUILT);

			expect(checkLinkedTarget(nodeModules, LINKED_TARGET)).toBeUndefined();
		});

		it('reports a dangling symlink as an install problem', () => {
			linkSibling();
			buildSibling();
			rmSync(siblingRepo, { recursive: true, force: true });

			const problem = checkLinkedTarget(nodeModules, LINKED_TARGET);

			expect(problem).toContain('no longer exists');
			expect(problem).toContain('Run: yarn install');
		});

		it('reports a dependency that is not installed at all', () => {
			expect(checkLinkedTarget(nodeModules, LINKED_TARGET)).toContain('not installed');
		});
	});
});
