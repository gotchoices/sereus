/**
 * Unit tests for the decisions `scripts/check-published.mjs` makes about a manifest,
 * about git's output, and about a directory tree
 * (`scripts/lib/published-check-support.mjs`).
 *
 * The check itself adds a git worktree, installs from the network and runs every root
 * gate in it — many minutes — so in practice it runs by hand at release time, where
 * its guards only ever fire in the passing direction. A guard never seen to fail is
 * not a guard. Nothing here drives a worktree: what is pinned is the manifest edit
 * (the one thing the worktree differs by), the dirty-tree reading that decides
 * whether the run describes what the caller is looking at, the set of packages the
 * report covers, and the link removal that stands between a cleanup and the Windows
 * data loss `docs/testing.md` records.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	delinkedManifest,
	dirtyPaths,
	nestedSiblingCopies,
	parseFlags,
	reparsePointsUnder,
	reportedSiblingNames,
	unlinkReparsePoints,
	workspacePackages
} from './lib/published-check-support.mjs';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-published.mjs');

function withTempDir(body) {
	const root = mkdtempSync(join(tmpdir(), 'check-published-test-'));
	try {
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2));
}

const ROOT_MANIFEST = {
	name: 'sereus-workspace',
	private: true,
	workspaces: ['packages/*'],
	resolutions: {
		'@optimystic/db-core': 'link:../optimystic/packages/db-core',
		'@quereus/quereus': 'link:../quereus/packages/quereus',
		'some-transitive': '1.2.3'
	},
	scripts: { build: 'tsc' }
};

test('delinkedManifest drops the whole resolutions key and nothing else', () => {
	const { text, delinked, alsoDropped } = delinkedManifest(JSON.stringify(ROOT_MANIFEST));
	const result = JSON.parse(text);

	assert.equal(result.resolutions, undefined);
	assert.deepEqual(result.workspaces, ['packages/*']);
	assert.deepEqual(result.scripts, { build: 'tsc' });
	assert.equal(result.name, 'sereus-workspace');
	assert.deepEqual(delinked, ['@optimystic/db-core', '@quereus/quereus']);
	assert.deepEqual(alsoDropped, ['some-transitive']);
	assert.ok(text.endsWith('\n'));
});

test('delinkedManifest is a no-op report on a manifest with no resolutions', () => {
	const { delinked, alsoDropped } = delinkedManifest(JSON.stringify({ name: 'x' }));

	assert.deepEqual(delinked, []);
	assert.deepEqual(alsoDropped, []);
});

test('dirtyPaths reads a modified, a staged and an untracked path out of porcelain', () => {
	// Untracked counts: the worktree is built from HEAD, where a new file is as
	// absent as an unstaged edit.
	const porcelain = ' M docs/testing.md\nA  scripts/check-published.mjs\n?? scratch.log\n';

	assert.deepEqual(dirtyPaths(porcelain), ['docs/testing.md', 'scripts/check-published.mjs', 'scratch.log']);
});

test('dirtyPaths reads a clean tree as clean', () => {
	assert.deepEqual(dirtyPaths(''), []);
	assert.deepEqual(dirtyPaths('\n'), []);
});

test('reportedSiblingNames covers the linked set plus sibling deps that were never linked', () => {
	const workspaces = [
		{ dir: 'a', manifest: { name: 'a', dependencies: { '@optimystic/db-p2p': '^1.5.0', lodash: '^4' } } },
		{ dir: 'b', manifest: { name: 'b', devDependencies: { '@quereus/quereus': '^4.19.4' }, peerDependencies: { '@optimystic/db-core': '^1.5.0' } } }
	];

	assert.deepEqual(reportedSiblingNames(ROOT_MANIFEST, workspaces), [
		'@optimystic/db-core',
		'@optimystic/db-p2p',
		'@quereus/quereus',
		'some-transitive'
	]);
});

test('workspacePackages reads every packages/* manifest and skips directories without one', () => {
	withTempDir((root) => {
		writeJson(join(root, 'packages', 'alpha', 'package.json'), { name: '@serfab/alpha' });
		writeJson(join(root, 'packages', 'beta', 'package.json'), { name: '@serfab/beta' });
		mkdirSync(join(root, 'packages', 'not-a-package'), { recursive: true });

		assert.deepEqual(workspacePackages(root).map(({ manifest }) => manifest.name), ['@serfab/alpha', '@serfab/beta']);
	});
});

test('nestedSiblingCopies reports only a workspace resolving away from the hoisted copy', () => {
	withTempDir((root) => {
		writeJson(join(root, 'node_modules', '@optimystic', 'db-core', 'package.json'), { name: '@optimystic/db-core', version: '1.5.0' });
		writeJson(join(root, 'packages', 'app', 'package.json'), { name: '@serfab/app' });
		writeJson(join(root, 'packages', 'app', 'node_modules', '@optimystic', 'db-core', 'package.json'), { name: '@optimystic/db-core', version: '1.4.0' });
		writeJson(join(root, 'packages', 'lib', 'package.json'), { name: '@serfab/lib' });

		const copies = nestedSiblingCopies(root, workspacePackages(root), ['@optimystic/db-core']);

		assert.deepEqual(copies.map(({ consumer, name, version }) => ({ consumer, name, version })), [
			{ consumer: '@serfab/app', name: '@optimystic/db-core', version: '1.4.0' }
		]);
	});
});

/**
 * The documented Windows hazard, in both directions: `docs/testing.md` records a
 * recursive delete that followed a checkout's junctions and emptied the sibling
 * repositories they pointed at. So the link must go and its target must not.
 */
test('unlinkReparsePoints removes the link and leaves what it points at', () => {
	withTempDir((root) => {
		const target = join(root, 'target');
		const doomed = join(root, 'tree', 'node_modules', 'dep');
		mkdirSync(join(root, 'tree', 'node_modules'), { recursive: true });
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'keep-me.txt'), 'tracked source someone else owns\n');
		// 'junction' is what yarn writes on Windows and is ignored on POSIX.
		symlinkSync(target, doomed, 'junction');
		writeFileSync(join(root, 'tree', 'plain.txt'), 'not a link\n');

		assert.deepEqual(reparsePointsUnder(join(root, 'tree')), [doomed]);

		const removed = unlinkReparsePoints(join(root, 'tree'));

		assert.deepEqual(removed, [doomed]);
		assert.equal(existsSync(doomed), false);
		assert.equal(readFileSync(join(target, 'keep-me.txt'), 'utf8'), 'tracked source someone else owns\n');
		assert.ok(lstatSync(join(root, 'tree', 'plain.txt')).isFile());
	});
});

test('reparsePointsUnder does not descend into a link, so a cycle cannot hang it', () => {
	withTempDir((root) => {
		const tree = join(root, 'tree');
		mkdirSync(tree, { recursive: true });
		symlinkSync(tree, join(tree, 'self'), 'junction');

		assert.deepEqual(reparsePointsUnder(tree), [join(tree, 'self')]);
	});
});

test('parseFlags accepts the documented flags and defaults both to false', () => {
	assert.deepEqual(parseFlags([]), { allowDirty: false, keep: false });
	assert.deepEqual(parseFlags(['--allow-dirty', '--keep']), { allowDirty: true, keep: true });
});

test('parseFlags rejects a typo instead of silently checking the wrong commit', () => {
	assert.throws(() => parseFlags(['--allowdirty']), /unknown flag "--allowdirty"/);
});

test('the script exits non-zero on an unknown flag without adding a worktree', () => {
	const result = spawnSync(process.execPath, [scriptPath, '--nope'], { encoding: 'utf8' });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /unknown flag "--nope"/);
});
