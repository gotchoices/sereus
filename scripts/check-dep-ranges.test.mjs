import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-dep-ranges.mjs');

// Each fixture's linked "sibling" lives outside its own root (resolutions point at
// `../<sibling>/...`, same as this repo's real `../optimystic` / `../quereus` layout),
// so it is tagged with a random id to keep concurrent fixtures/tests from colliding
// or leaking into each other's "sibling absent" checks.
function makeFixture({ resolutions, packages }) {
	const root = mkdtempSync(join(tmpdir(), 'dep-range-check-'));
	const siblingTag = randomUUID();
	const taggedResolutions = Object.fromEntries(
		Object.entries(resolutions).map(([name, target]) => [name, target.replace('link:../', `link:../${siblingTag}-`)]),
	);
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'], resolutions: taggedResolutions }));
	mkdirSync(join(root, 'packages'), { recursive: true });
	for (const [name, manifest] of Object.entries(packages)) {
		const dir = join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
	}
	return { root, siblingTag, cleanupPaths: [root] };
}

function makeLinkedSibling(fixture, relativeLinkPath, version) {
	const dir = join(fixture.root, relativeLinkPath.replace('../', `../${fixture.siblingTag}-`));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'linked-sibling', version }));
	fixture.cleanupPaths.push(join(fixture.root, '..', `${fixture.siblingTag}-${relativeLinkPath.replace('../', '').split('/')[0]}`));
}

function run(fixture) {
	const result = spawnSync(process.execPath, [scriptPath], {
		env: { ...process.env, DEP_RANGE_CHECK_ROOT: fixture.root },
		encoding: 'utf8',
	});
	for (const path of fixture.cleanupPaths) {
		rmSync(path, { recursive: true, force: true });
	}
	return result;
}

test('0.x caret excludes a newer linked version (real 2026-07-29 recurrence shape)', () => {
	const fixture = makeFixture({
		resolutions: { '@optimystic/db-core': 'link:../optimystic/packages/db-core' },
		packages: { 'pkg-a': { dependencies: { '@optimystic/db-core': '^0.16.3' } } },
	});
	makeLinkedSibling(fixture, '../optimystic/packages/db-core', '0.17.0');
	const result = run(fixture);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /too old/);
	assert.match(result.stderr, /"@optimystic\/db-core": "\^0\.17\.0"/);
});

test('1.0+ caret admits a newer minor (must not false-positive across the 0.x/1.0 boundary)', () => {
	const fixture = makeFixture({
		resolutions: { '@quereus/quereus': 'link:../quereus/packages/quereus' },
		packages: { 'pkg-a': { dependencies: { '@quereus/quereus': '^4.4.0' } } },
	});
	makeLinkedSibling(fixture, '../quereus/packages/quereus', '4.5.1');
	const result = run(fixture);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /all declared ranges admit/);
});

test('declared range newer than the linked workspace fails the other direction', () => {
	const fixture = makeFixture({
		resolutions: { '@quereus/quereus': 'link:../quereus/packages/quereus' },
		packages: { 'pkg-a': { dependencies: { '@quereus/quereus': '^4.5.0' } } },
	});
	makeLinkedSibling(fixture, '../quereus/packages/quereus', '4.4.0');
	const result = run(fixture);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /behind what is promised/);
});

test('absent sibling workspace is skipped, not failed', () => {
	const fixture = makeFixture({
		resolutions: { '@optimystic/db-core': 'link:../optimystic/packages/db-core' },
		packages: { 'pkg-a': { dependencies: { '@optimystic/db-core': '^0.14.1' } } },
	});
	const result = run(fixture);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /skip:.*linked workspace not found/);
});

test('a satisfied range passes cleanly', () => {
	const fixture = makeFixture({
		resolutions: { '@optimystic/db-core': 'link:../optimystic/packages/db-core' },
		packages: { 'pkg-a': { dependencies: { '@optimystic/db-core': '^0.17.0' } } },
	});
	makeLinkedSibling(fixture, '../optimystic/packages/db-core', '0.17.0');
	const result = run(fixture);
	assert.equal(result.status, 0);
});
