/**
 * Unit tests for the decisions `scripts/smoke-published-install.mjs` makes about the
 * repository and about an installed `node_modules` tree
 * (`scripts/lib/published-smoke-support.mjs`).
 *
 * The smoke script itself needs the network and ~40 s, so in practice it runs by hand
 * at release time — and its guards only ever fire in the *passing* direction there. A
 * guard that has never been seen to fail is not a guard. Each one below is pinned in
 * both directions against a fixture tree: the provenance check must reject a registry
 * fallback, the staleness check must reject an old `dist`, `declaredRange` must reject
 * a disagreement, and the resolution walk must find a nested copy rather than the
 * hoisted one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	declaredRange,
	findPackageDir,
	hoistedVersions,
	nestedCopies,
	parseFlags,
	publishableWorkspaces,
	reportedPackages,
	staleWorkspaces,
	tarballProvenance
} from './lib/published-smoke-support.mjs';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'smoke-published-install.mjs');

/** Seconds since epoch; `dist` sits between OLD and NEW so either side can be the newer one. */
const OLD = 1_700_000_000;
const BUILT = OLD + 100;
const NEW = BUILT + 100;

function withTempDir(body) {
	const root = mkdtempSync(join(tmpdir(), 'published-smoke-test-'));
	try {
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeFile(path, contents, mtimeSeconds) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
	if (mtimeSeconds !== undefined) {
		utimesSync(path, mtimeSeconds, mtimeSeconds);
	}
}

function writeManifest(dir, manifest) {
	writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
}

/** A repo root with one `pub:` script per named package. */
function makeRepo(root, packages) {
	const scripts = Object.fromEntries(
		Object.keys(packages).map((dir) => [`pub:${dir}`, `node scripts/publish-package.js ${dir}`])
	);
	writeManifest(root, { name: 'fixture-root', scripts });
	for (const [dir, manifest] of Object.entries(packages)) {
		writeManifest(join(root, 'packages', dir), manifest);
	}
	return root;
}

/** Install `name`@`version` into `<dir>/node_modules`, as npm would. */
function installPackage(dir, name, version) {
	const target = join(dir, 'node_modules', ...name.split('/'));
	writeManifest(target, { name, version });
	return target;
}

test('publishableWorkspaces derives the set from the root pub: scripts', () => {
	withTempDir((root) => {
		makeRepo(root, { alpha: { name: '@scope/alpha', version: '1.0.0' }, beta: { name: '@scope/beta', version: '2.0.0' } });
		const workspaces = publishableWorkspaces(root);
		assert.deepEqual(workspaces.map((w) => w.manifest.name), ['@scope/alpha', '@scope/beta']);
		assert.deepEqual(workspaces.map((w) => w.tarballName), ['scope-alpha.tgz', 'scope-beta.tgz']);
	});
});

test('publishableWorkspaces matches a `publish-package.mjs` script body, not only `.js`', () => {
	withTempDir((root) => {
		writeManifest(root, {
			name: 'fixture-root',
			scripts: { 'pub:alpha': 'node scripts/publish-package.mjs alpha' },
		});
		writeManifest(join(root, 'packages', 'alpha'), { name: '@scope/alpha', version: '1.0.0' });
		const workspaces = publishableWorkspaces(root);
		assert.deepEqual(workspaces.map((w) => w.manifest.name), ['@scope/alpha']);
	});
});

test('publishableWorkspaces fails when no pub: script exists', () => {
	withTempDir((root) => {
		writeManifest(root, { name: 'fixture-root', scripts: { build: 'tsc' } });
		assert.throws(() => publishableWorkspaces(root), /no `pub:\*` scripts/);
	});
});

test('publishableWorkspaces fails when a pub: script names no package directory', () => {
	withTempDir((root) => {
		writeManifest(root, { name: 'fixture-root', scripts: { 'pub:alpha': 'echo nope' } });
		assert.throws(() => publishableWorkspaces(root), /does not name a package directory/);
	});
});

test('declaredRange reads the range off whichever workspace declares it, dev or not', () => {
	const workspaces = [
		{ manifest: { name: '@scope/alpha', dependencies: { '@optimystic/db-p2p': '^0.18.0' } } },
		{ manifest: { name: '@scope/beta', devDependencies: { '@libp2p/websockets': '^10.1.3' } } }
	];
	assert.equal(declaredRange(workspaces, '@optimystic/db-p2p'), '^0.18.0');
	assert.equal(declaredRange(workspaces, '@libp2p/websockets'), '^10.1.3');
});

test('declaredRange rejects a disagreement rather than picking the first match', () => {
	const workspaces = [
		{ manifest: { name: '@scope/alpha', dependencies: { dep: '^1.0.0' } } },
		{ manifest: { name: '@scope/beta', dependencies: { dep: '^2.0.0' } } }
	];
	assert.throws(() => declaredRange(workspaces, 'dep'), /disagree on the range for "dep"/);
});

test('declaredRange fails when nothing declares the dependency', () => {
	assert.throws(
		() => declaredRange([{ manifest: { name: '@scope/alpha' } }], 'dep'),
		/no publishable workspace declares "dep"/
	);
});

test('reportedPackages covers our scopes plus the extras, and skips everything else', () => {
	const workspaces = [{
		manifest: {
			name: '@serfab/alpha',
			dependencies: { '@optimystic/db-p2p': '^1', '@quereus/quereus': '^1', '@serfab/beta': '^1', 'lodash': '^1' }
		}
	}];
	assert.deepEqual(
		reportedPackages(workspaces, ['libp2p']),
		['@optimystic/db-p2p', '@quereus/quereus', '@serfab/alpha', '@serfab/beta', 'libp2p']
	);
});

test('findPackageDir prefers the nested copy and falls back to the hoisted one', () => {
	withTempDir((root) => {
		const consumer = installPackage(root, '@scope/alpha', '1.0.0');
		installPackage(root, 'dep', '5.0.0');
		const nested = installPackage(consumer, 'dep', '4.0.0');

		assert.equal(findPackageDir(consumer, 'dep'), nested);
		assert.equal(findPackageDir(root, 'dep'), join(root, 'node_modules', 'dep'));
		assert.equal(findPackageDir(root, 'absent'), null);
	});
});

test('hoistedVersions reports a missing package rather than throwing', () => {
	withTempDir((root) => {
		installPackage(root, 'dep', '5.0.0');
		assert.deepEqual(
			hoistedVersions(root, ['dep', 'absent']).map(({ name, version }) => ({ name, version })),
			[{ name: 'dep', version: '5.0.0' }, { name: 'absent', version: null }]
		);
	});
});

test('nestedCopies reports only the deps that resolve away from the hoisted copy', () => {
	withTempDir((root) => {
		const workspaces = [{
			manifest: { name: '@scope/alpha', dependencies: { nested: '^4', shared: '^5' } }
		}];
		const consumer = installPackage(root, '@scope/alpha', '1.0.0');
		installPackage(root, 'nested', '5.0.0');
		installPackage(root, 'shared', '5.0.0');
		installPackage(consumer, 'nested', '4.0.0');

		assert.deepEqual(
			nestedCopies(root, workspaces).map(({ consumer: c, dep, version }) => ({ consumer: c, dep, version })),
			[{ consumer: '@scope/alpha', dep: 'nested', version: '4.0.0' }]
		);
	});
});

test('tarballProvenance accepts a package installed from the packed tarball', () => {
	withTempDir((root) => {
		writeFile(join(root, 'package-lock.json'), JSON.stringify({
			packages: { 'node_modules/@scope/alpha': { resolved: '../tarballs/scope-alpha.tgz' } }
		}));
		const { lockfilePresent, wrong } = tarballProvenance(root, [
			{ manifest: { name: '@scope/alpha' }, tarballName: 'scope-alpha.tgz' }
		]);
		assert.equal(lockfilePresent, true);
		assert.deepEqual(wrong, []);
	});
});

test('tarballProvenance catches a silent registry fallback', () => {
	withTempDir((root) => {
		// The published 0.9.0 would report the same version as the tarball, so the
		// lockfile's `resolved` is the only place the difference shows.
		writeFile(join(root, 'package-lock.json'), JSON.stringify({
			packages: { 'node_modules/@scope/alpha': { resolved: 'https://registry.npmjs.org/@scope/alpha/-/alpha-0.9.0.tgz' } }
		}));
		const { wrong } = tarballProvenance(root, [{ manifest: { name: '@scope/alpha' }, tarballName: 'scope-alpha.tgz' }]);
		assert.deepEqual(wrong.map((entry) => entry.name), ['@scope/alpha']);
		assert.match(wrong[0].resolved, /registry\.npmjs\.org/);
	});
});

test('tarballProvenance catches a package missing from the lockfile entirely', () => {
	withTempDir((root) => {
		writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
		const { wrong } = tarballProvenance(root, [{ manifest: { name: '@scope/alpha' }, tarballName: 'scope-alpha.tgz' }]);
		assert.deepEqual(wrong, [{ name: '@scope/alpha', resolved: '(absent from lockfile)' }]);
	});
});

test('tarballProvenance reports no lockfile rather than claiming the tarballs were used', () => {
	withTempDir((root) => {
		assert.deepEqual(
			tarballProvenance(root, [{ manifest: { name: '@scope/alpha' }, tarballName: 'scope-alpha.tgz' }]),
			{ lockfilePresent: false, wrong: [] }
		);
	});
});

test('staleWorkspaces passes a dist built after its src', () => {
	withTempDir((root) => {
		writeFile(join(root, 'alpha', 'src', 'index.ts'), 'x', OLD);
		writeFile(join(root, 'alpha', 'dist', 'index.js'), 'x', BUILT);
		assert.deepEqual(staleWorkspaces([{ dir: join(root, 'alpha'), manifest: { name: '@scope/alpha' } }]), []);
	});
});

test('staleWorkspaces catches a dist older than its src', () => {
	withTempDir((root) => {
		writeFile(join(root, 'alpha', 'src', 'index.ts'), 'x', NEW);
		writeFile(join(root, 'alpha', 'dist', 'index.js'), 'x', BUILT);
		assert.deepEqual(
			staleWorkspaces([{ dir: join(root, 'alpha'), manifest: { name: '@scope/alpha' } }]),
			[{ name: '@scope/alpha', reason: 'stale' }]
		);
	});
});

test('staleWorkspaces catches a package that was never built', () => {
	withTempDir((root) => {
		writeFile(join(root, 'alpha', 'src', 'index.ts'), 'x', OLD);
		assert.deepEqual(
			staleWorkspaces([{ dir: join(root, 'alpha'), manifest: { name: '@scope/alpha' } }]),
			[{ name: '@scope/alpha', reason: 'missing' }]
		);
	});
});

test('staleWorkspaces sees a nested source file, not only the top level', () => {
	withTempDir((root) => {
		writeFile(join(root, 'alpha', 'src', 'index.ts'), 'x', OLD);
		writeFile(join(root, 'alpha', 'src', 'deep', 'nested.ts'), 'x', NEW);
		writeFile(join(root, 'alpha', 'dist', 'index.js'), 'x', BUILT);
		assert.deepEqual(
			staleWorkspaces([{ dir: join(root, 'alpha'), manifest: { name: '@scope/alpha' } }]),
			[{ name: '@scope/alpha', reason: 'stale' }]
		);
	});
});

test('staleWorkspaces treats a package shipped without src as fresh', () => {
	withTempDir((root) => {
		writeFile(join(root, 'alpha', 'dist', 'index.js'), 'x', BUILT);
		assert.deepEqual(staleWorkspaces([{ dir: join(root, 'alpha'), manifest: { name: '@scope/alpha' } }]), []);
	});
});

test('parseFlags accepts the documented flags and defaults both to false', () => {
	assert.deepEqual(parseFlags([]), { skipBuild: false, keep: false });
	assert.deepEqual(parseFlags(['--skip-build', '--keep']), { skipBuild: true, keep: true });
});

test('parseFlags rejects a typo instead of silently starting a full build', () => {
	assert.throws(() => parseFlags(['--skipbuild']), /unknown flag "--skipbuild"/);
});

test('the script exits non-zero on an unknown flag without packing anything', () => {
	const result = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /unknown flag "--nope"/);
	assert.doesNotMatch(result.stdout, /publishable workspace/);
});
