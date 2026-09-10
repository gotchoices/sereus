/**
 * Unit tests for the refusals `scripts/release-guard.mjs` makes between `yarn bump --no-push` and
 * `yarn pub` — the point where a refusal still costs nothing, because the release commit and its
 * tag exist only locally and npm has nothing.
 *
 * The git shell-outs and the registry probe are not exercised here; the module guards its `main()`
 * invocation, so importing it for these tests never runs them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alreadyFullyPublishedFailure, localGuardFailures, undoCommands } from './release-guard.mjs';

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** A release that should sail through: every package bumped, tag at HEAD, stable version. */
function healthy(overrides = {}) {
	return {
		version: '0.14.0',
		tagName: 'v0.14.0',
		packages: [
			{ name: '@serfab/quereus-plugin-sereus', version: '0.14.0' },
			{ name: '@serfab/cadre-core', version: '0.14.0' },
		],
		tag: undefined,
		tagExists: true,
		tagCommit: HEAD,
		headCommit: HEAD,
		...overrides,
	};
}

test('the happy path refuses nothing', () => {
	assert.deepEqual(localGuardFailures(healthy()), []);
});

test('a package left behind by the bump is refused, and named', () => {
	const failures = localGuardFailures(healthy({
		packages: [
			{ name: '@serfab/quereus-plugin-sereus', version: '0.14.0' },
			{ name: '@serfab/cadre-core', version: '0.13.0' },
		],
	}));
	assert.equal(failures.length, 1);
	assert.match(failures[0], /root package\.json says 0\.14\.0/);
	assert.match(failures[0], /@serfab\/cadre-core@0\.13\.0/);
	// The package that did bump is not named as a problem.
	assert.doesNotMatch(failures[0], /quereus-plugin-sereus/);
});

test('the 2026-09-10 case: a prerelease with no dist-tag is refused before anything is pushed', () => {
	const failures = localGuardFailures(healthy({
		version: '1.0.0-beta.1',
		tagName: 'v1.0.0-beta.1',
		packages: [
			{ name: '@serfab/quereus-plugin-sereus', version: '1.0.0-beta.1' },
			{ name: '@serfab/cadre-core', version: '1.0.0-beta.1' },
		],
	}));
	assert.equal(failures.length, 1);
	assert.match(failures[0], /is a prerelease, but no dist-tag was given/);
	// Reported against the first package in publish order — the one `yarn pub` would hit first.
	assert.match(failures[0], /@serfab\/quereus-plugin-sereus@1\.0\.0-beta\.1/);
});

test('a prerelease under an explicit dist-tag is fine, including the deliberate latest', () => {
	const prerelease = { version: '1.0.0-beta.1', tagName: 'v1.0.0-beta.1', packages: [{ name: '@serfab/cadre-core', version: '1.0.0-beta.1' }] };
	assert.deepEqual(localGuardFailures(healthy({ ...prerelease, tag: 'beta' })), []);
	assert.deepEqual(localGuardFailures(healthy({ ...prerelease, tag: 'latest' })), []);
});

test('a stable version under a non-latest dist-tag is legitimate', () => {
	assert.deepEqual(localGuardFailures(healthy({ tag: 'next' })), []);
});

test('a missing tag is refused — the bump did not finish', () => {
	const failures = localGuardFailures(healthy({ tagExists: false, tagCommit: undefined }));
	assert.equal(failures.length, 1);
	assert.match(failures[0], /tag v0\.14\.0 does not exist/);
});

test('a tag that is not at HEAD is refused, naming both commits', () => {
	const other = '9876543210fedcba9876543210fedcba98765432';
	const failures = localGuardFailures(healthy({ tagCommit: other }));
	assert.equal(failures.length, 1);
	assert.match(failures[0], /tag v0\.14\.0 points at 98765432/);
	assert.match(failures[0], /HEAD is a1b2c3d4/);
});

test('several problems at once are all reported, not just the first', () => {
	const failures = localGuardFailures(healthy({
		version: '1.0.0-beta.1',
		tagName: 'v1.0.0-beta.1',
		packages: [{ name: '@serfab/cadre-core', version: '0.14.0' }],
		tagExists: false,
		tagCommit: undefined,
	}));
	assert.equal(failures.length, 3);
});

test('a release with nothing left to publish is refused', () => {
	const failure = alreadyFullyPublishedFailure('0.13.0', [
		{ name: '@serfab/quereus-plugin-sereus', published: true },
		{ name: '@serfab/cadre-core', published: true },
	]);
	assert.match(failure, /already has 0\.13\.0 on npm/);
	// It points at recovery rather than at starting over.
	assert.match(failure, /Recovering a half-finished release/);
});

test('a partly-published release is not refused — that is exactly what a resumed publish is for', () => {
	assert.equal(
		alreadyFullyPublishedFailure('0.14.0', [
			{ name: '@serfab/quereus-plugin-sereus', published: true },
			{ name: '@serfab/cadre-core', published: false },
		]),
		undefined,
	);
	assert.equal(
		alreadyFullyPublishedFailure('0.14.0', [{ name: '@serfab/cadre-core', published: false }]),
		undefined,
	);
	// An empty publishable set is someone else's error to report, not a "fully published" release.
	assert.equal(alreadyFullyPublishedFailure('0.14.0', []), undefined);
});

test('the undo instructions name this release, and keep uncommitted work', () => {
	assert.deepEqual(undoCommands('1.0.0-beta.1'), [
		'git tag -d v1.0.0-beta.1',
		'git reset --keep HEAD~1',
	]);
	// `--hard` would discard work the release has nothing to do with.
	assert.ok(!undoCommands('0.14.0').some((command) => command.includes('--hard')));
});
