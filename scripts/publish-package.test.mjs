/**
 * Unit tests for the pure decisions `scripts/publish-package.mjs` makes: which dist-tag to
 * publish under, and whether a prerelease version is allowed to go out under it. The parts that
 * shell out (`yarn clean`, `yarn build`, `yarn npm publish`) are not exercised here — the module
 * guards its `main()` invocation so importing it for these tests never runs them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertDistTagForPrerelease, publishCommand, readManifest, resolveDistTag } from './publish-package.mjs';

function withTempDir(body) {
	const root = mkdtempSync(join(tmpdir(), 'publish-package-test-'));
	try {
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('resolveDistTag: --tag wins over SEREUS_DIST_TAG', () => {
	assert.equal(resolveDistTag(['--tag', 'alpha'], { SEREUS_DIST_TAG: 'next' }), 'alpha');
});

test('resolveDistTag: SEREUS_DIST_TAG alone resolves the tag', () => {
	assert.equal(resolveDistTag([], { SEREUS_DIST_TAG: 'alpha' }), 'alpha');
});

test('resolveDistTag: neither given resolves to no tag at all', () => {
	assert.equal(resolveDistTag([], {}), undefined);
});

test('resolveDistTag: --tag as the final argument with no value is a loud error', () => {
	assert.throws(() => resolveDistTag(['--tag'], {}), /--tag requires a value/);
});

test('resolveDistTag: --tag "" is a loud error, not a silently absent tag', () => {
	assert.throws(() => resolveDistTag(['--tag', ''], {}), /--tag requires a value/);
});

test('resolveDistTag: an unrecognised flag is refused', () => {
	assert.throws(() => resolveDistTag(['--nope'], {}), /unknown flag "--nope"/);
});

test('resolveDistTag: a bare word (a forgotten --tag) is refused, not silently ignored', () => {
	assert.throws(() => resolveDistTag(['alpha'], {}), /unexpected argument "alpha"/);
});

test('resolveDistTag: --tag followed by another flag is a missing value, not a tag named --keep', () => {
	assert.throws(() => resolveDistTag(['--tag', '--keep'], {}), /--tag requires a value/);
});

test('resolveDistTag: a malformed SEREUS_DIST_TAG is refused', () => {
	assert.throws(() => resolveDistTag([], { SEREUS_DIST_TAG: 'not a tag' }), /is not a plausible npm tag name/);
});

test('resolveDistTag: an empty SEREUS_DIST_TAG is treated as unset', () => {
	assert.equal(resolveDistTag([], { SEREUS_DIST_TAG: '' }), undefined);
});

test('resolveDistTag: rejects a tag that is a bare semver version', () => {
	assert.throws(() => resolveDistTag(['--tag', '1.2.3'], {}), /looks like a version, not a tag name/);
});

test('publishCommand: omits --tag entirely when there is none, rather than an explicit --tag latest', () => {
	assert.equal(publishCommand(undefined), 'yarn npm publish --access public');
});

test('publishCommand: carries the resolved tag', () => {
	assert.equal(publishCommand('alpha'), 'yarn npm publish --access public --tag alpha');
});

test('assertDistTagForPrerelease: refuses a prerelease with no tag', () => {
	assert.throws(
		() => assertDistTagForPrerelease('@serfab/cadre-core', '0.10.0-alpha.0', undefined),
		/@serfab\/cadre-core@0\.10\.0-alpha\.0 is a prerelease, but no dist-tag was given/,
	);
});

test('assertDistTagForPrerelease: allows a prerelease published under an explicit tag', () => {
	assert.doesNotThrow(() => assertDistTagForPrerelease('@serfab/cadre-core', '0.10.0-alpha.0', 'alpha'));
});

test('assertDistTagForPrerelease: SEREUS_DIST_TAG=latest is the deliberate escape hatch', () => {
	assert.doesNotThrow(() => assertDistTagForPrerelease('@serfab/cadre-core', '0.10.0-alpha.0', 'latest'));
});

test('assertDistTagForPrerelease: a stable version under a non-latest tag is legitimate', () => {
	assert.doesNotThrow(() => assertDistTagForPrerelease('@serfab/cadre-core', '0.9.0', 'next'));
});

test('assertDistTagForPrerelease: a stable version with no tag is the ordinary path', () => {
	assert.doesNotThrow(() => assertDistTagForPrerelease('@serfab/cadre-core', '0.9.0', undefined));
});

test('readManifest: reads name and version off the package directory', () => {
	withTempDir((dir) => {
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@scope/alpha', version: '1.2.3' }));
		assert.deepEqual(readManifest(dir), { name: '@scope/alpha', version: '1.2.3' });
	});
});

test('readManifest: fails with a clear error naming the file when the version is not valid semver', () => {
	withTempDir((dir) => {
		const manifestPath = join(dir, 'package.json');
		writeFileSync(manifestPath, JSON.stringify({ name: '@scope/alpha', version: 'not-a-version' }));
		assert.throws(() => readManifest(dir), (error) => {
			assert.match(error.message, /"not-a-version" in .* is not a valid semver version/);
			assert.ok(error.message.includes(manifestPath), `expected error to name ${manifestPath}`);
			return true;
		});
	});
});
