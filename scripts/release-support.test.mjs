/**
 * Unit tests for the decisions the release chain shares — the `SEREUS_GH_RELEASE` hatch, what
 * counts as written release notes, and the one that matters most: whether a version is already on
 * npm, and what happens when the registry does not answer.
 *
 * The registry probe is exercised through an injected `fetchImpl`, so these run offline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_REGISTRY,
	EMPTY_NOTES_HEADER,
	ghReleaseEnabled,
	interpretPackument,
	notesAreReset,
	notesHaveContent,
	registryHasVersion,
	registryUrl,
} from './lib/release-support.mjs';

/** A `fetch` stand-in that answers once with the given status and body. */
function respondWith(status, body) {
	return async () => ({ status, text: async () => body });
}

const PACKUMENT = JSON.stringify({ versions: { '0.12.0': {}, '0.13.0': {} } });

test('ghReleaseEnabled: only an explicit 0 or false turns the GitHub release off', () => {
	assert.equal(ghReleaseEnabled({}), true);
	assert.equal(ghReleaseEnabled({ SEREUS_GH_RELEASE: '1' }), true);
	assert.equal(ghReleaseEnabled({ SEREUS_GH_RELEASE: '' }), true);

	assert.equal(ghReleaseEnabled({ SEREUS_GH_RELEASE: '0' }), false);
	assert.equal(ghReleaseEnabled({ SEREUS_GH_RELEASE: 'false' }), false);
});

test('notesHaveContent: the empty header alone is not notes, with or without trailing whitespace', () => {
	assert.equal(notesHaveContent(EMPTY_NOTES_HEADER), false);
	// A trailing newline or two must not read as content — a byte-length rule would be fooled here.
	assert.equal(notesHaveContent(`${EMPTY_NOTES_HEADER}\n\n`), false);
	assert.equal(notesHaveContent(`${EMPTY_NOTES_HEADER}   \n\t\n`), false);
	assert.equal(notesHaveContent(''), false);
	assert.equal(notesHaveContent(undefined), false);
});

test('notesHaveContent: any non-blank line after the heading is notes', () => {
	assert.equal(notesHaveContent(`${EMPTY_NOTES_HEADER}\n- fixed the thing\n`), true);
	assert.equal(notesHaveContent(`${EMPTY_NOTES_HEADER}## Fixed\n`), true);
	// Leading blank lines before the heading do not change the answer.
	assert.equal(notesHaveContent(`\n\n# Heading\nbody\n`), true);
	// Notes with no heading at all are still notes.
	assert.equal(notesHaveContent('just the notes, no heading\n'), true);
	// CRLF is the same file on this repo's primary platform.
	assert.equal(notesHaveContent('# Release notes — pending\r\n\r\n- a change\r\n'), true);
	assert.equal(notesHaveContent('# Release notes — pending\r\n\r\n'), false);
});

test('notesAreReset: a checkout that turned the header into CRLF is still a reset file', () => {
	assert.equal(notesAreReset(EMPTY_NOTES_HEADER), true);
	// core.autocrlf=true with no .gitattributes hands back CRLF for a file git stores with LF.
	assert.equal(notesAreReset(EMPTY_NOTES_HEADER.replace('\n', '\r\n')), true);

	assert.equal(notesAreReset(EMPTY_NOTES_HEADER + '- a change\n'), false);
	assert.equal(notesAreReset(''), false);
	assert.equal(notesAreReset(undefined), false);
});

test('registryUrl: scoped names are percent-encoded, and the registry is overridable', () => {
	assert.equal(registryUrl('@serfab/cadre-core', {}), `${DEFAULT_REGISTRY}/@serfab%2fcadre-core`);
	assert.equal(registryUrl('semver', {}), `${DEFAULT_REGISTRY}/semver`);
	assert.equal(registryUrl('semver', { npm_config_registry: 'https://example.test/' }), 'https://example.test/semver');
	// An explicit override beats npm's own configured registry.
	assert.equal(
		registryUrl('semver', { npm_config_registry: 'https://npm.test', SEREUS_NPM_REGISTRY: 'https://mine.test' }),
		'https://mine.test/semver',
	);
	// A blank value is not an override.
	assert.equal(registryUrl('semver', { SEREUS_NPM_REGISTRY: '  ' }), `${DEFAULT_REGISTRY}/semver`);
});

test('interpretPackument: a version present in the map is already published', () => {
	assert.equal(interpretPackument({ status: 200, body: PACKUMENT }, '@serfab/cadre-core', '0.13.0'), true);
});

test('interpretPackument: a version absent from the map is not published', () => {
	assert.equal(interpretPackument({ status: 200, body: PACKUMENT }, '@serfab/cadre-core', '1.0.0-beta.1'), false);
});

test('interpretPackument: a 404 is a real answer — the package has never been published', () => {
	assert.equal(interpretPackument({ status: 404, body: '{}' }, '@serfab/brand-new', '0.1.0'), false);
});

test('interpretPackument: any other status is unknown, and unknown must throw rather than skip', () => {
	for (const status of [401, 403, 429, 500, 502, 503]) {
		assert.throws(
			() => interpretPackument({ status, body: '' }, '@serfab/cadre-core', '0.13.0'),
			new RegExp(`answered HTTP ${status}`),
			`HTTP ${status} must not be read as "not published"`,
		);
	}
});

test('interpretPackument: a 200 that is not a readable packument throws rather than guessing', () => {
	assert.throws(
		() => interpretPackument({ status: 200, body: '<html>proxy</html>' }, '@serfab/cadre-core', '0.13.0'),
		/is not JSON/,
	);
	assert.throws(
		() => interpretPackument({ status: 200, body: '{"name":"x"}' }, '@serfab/cadre-core', '0.13.0'),
		/no `versions` map/,
	);
});

test('registryHasVersion: answers from the packument the registry returned', async () => {
	assert.equal(
		await registryHasVersion('@serfab/cadre-core', '0.13.0', { fetchImpl: respondWith(200, PACKUMENT), environment: {} }),
		true,
	);
	assert.equal(
		await registryHasVersion('@serfab/cadre-core', '0.14.0', { fetchImpl: respondWith(200, PACKUMENT), environment: {} }),
		false,
	);
});

test('registryHasVersion: an unreachable registry throws, and says so is not the same as "not published"', async () => {
	const offline = async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org'); };
	await assert.rejects(
		() => registryHasVersion('@serfab/cadre-core', '0.13.0', { fetchImpl: offline, environment: {} }),
		(error) => {
			assert.match(error.message, /could not reach the npm registry/);
			assert.match(error.message, /not the same answer as "not published"/);
			return true;
		},
	);
});

test('registryHasVersion: asks the registry for the package it was given', async () => {
	const seen = [];
	const record = async (url, init) => {
		seen.push({ url, accept: init?.headers?.accept });
		return { status: 200, text: async () => PACKUMENT };
	};
	await registryHasVersion('@serfab/cadre-core', '0.13.0', { fetchImpl: record, environment: {} });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, `${DEFAULT_REGISTRY}/@serfab%2fcadre-core`);
	// The abbreviated packument is a fraction of the full one and carries every version key.
	assert.equal(seen[0].accept, 'application/vnd.npm.install-v1+json');
});
