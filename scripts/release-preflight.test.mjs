/**
 * Unit tests for the pure decisions `scripts/release-preflight.mjs` makes: whether the interactive
 * prompt is bypassed, whether a typed answer counts as confirmation, which dist-tag the publish
 * will actually use, and which warnings a given tree state earns.
 *
 * The interactive path and the git shell-outs are not exercised here — the module guards its
 * `main()` invocation, so importing it for these tests never prompts or publishes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	CHECK_STEPS,
	CONFIRM_WORD,
	isConfirmed,
	resolveBypass,
	resolvePlannedDistTag,
	warningsFor,
} from './release-preflight.mjs';

test('bypasses only on an explicit flag or CI', () => {
	assert.equal(resolveBypass(['--yes'], {}), true);
	assert.equal(resolveBypass(['-y'], {}), true);
	assert.equal(resolveBypass([], { CI: '1' }), true);
	assert.equal(resolveBypass([], { CI: 'true' }), true);

	assert.equal(resolveBypass([], {}), false);
	assert.equal(resolveBypass(['--tag', 'alpha'], {}), false);
	// A falsy-but-present CI value is not consent.
	assert.equal(resolveBypass([], { CI: '0' }), false);
	assert.equal(resolveBypass([], { CI: 'false' }), false);
	assert.equal(resolveBypass([], { CI: '' }), false);
});

test('confirmation is case- and whitespace-insensitive, but nothing else passes', () => {
	assert.equal(isConfirmed(CONFIRM_WORD), true);
	assert.equal(isConfirmed(`  ${CONFIRM_WORD.toUpperCase()}  `), true);

	assert.equal(isConfirmed('y'), false);
	assert.equal(isConfirmed('yes'), false);
	assert.equal(isConfirmed(''), false);
	assert.equal(isConfirmed(`${CONFIRM_WORD}!`), false);
	assert.equal(isConfirmed(undefined), false);
	assert.equal(isConfirmed(null), false);
});

test('planned dist-tag mirrors publish-package resolution: flag beats env, blank env is none', () => {
	assert.equal(resolvePlannedDistTag(['--tag', 'alpha'], {}), 'alpha');
	assert.equal(resolvePlannedDistTag([], { SEREUS_DIST_TAG: 'next' }), 'next');
	// An explicit flag wins over the environment.
	assert.equal(resolvePlannedDistTag(['--tag', 'alpha'], { SEREUS_DIST_TAG: 'next' }), 'alpha');
	// Whitespace-only or absent means "no tag", i.e. npm's default.
	assert.equal(resolvePlannedDistTag([], { SEREUS_DIST_TAG: '   ' }), undefined);
	assert.equal(resolvePlannedDistTag([], {}), undefined);
	// A dangling --tag with no value must not be read as a tag.
	assert.equal(resolvePlannedDistTag(['--tag'], {}), undefined);
});

test('a missing dist-tag is always warned about, because it publishes as latest', () => {
	const clean = { ok: true, dirty: false, ahead: '0', behind: '0' };
	const warnings = warningsFor(clean, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /latest/);

	assert.deepEqual(warningsFor(clean, 'alpha'), []);
});

test('dirty tree and behind-origin each earn their own warning', () => {
	const dirty = { ok: true, dirty: true, ahead: '0', behind: '0' };
	assert.equal(warningsFor(dirty, 'alpha').length, 1);
	assert.match(warningsFor(dirty, 'alpha')[0], /DIRTY/);

	const behind = { ok: true, dirty: false, ahead: '0', behind: '3' };
	assert.equal(warningsFor(behind, 'alpha').length, 1);
	assert.match(warningsFor(behind, 'alpha')[0], /BEHIND/);

	// Worst case: all three at once, most severe first.
	const bad = { ok: true, dirty: true, ahead: '0', behind: '2' };
	const warnings = warningsFor(bad, undefined);
	assert.equal(warnings.length, 3);
	assert.match(warnings[0], /latest/);
});

test('unavailable git facts produce no tree warnings rather than throwing', () => {
	const warnings = warningsFor({ ok: false }, 'alpha');
	assert.deepEqual(warnings, []);
	// The dist-tag warning is independent of git and must still fire.
	assert.equal(warningsFor({ ok: false }, undefined).length, 1);
});

test('being ahead of origin is not a warning — bump pushes', () => {
	const ahead = { ok: true, dirty: false, ahead: '5', behind: '0' };
	assert.deepEqual(warningsFor(ahead, 'alpha'), []);
});

test('the advertised check steps match the scripts a release actually depends on', () => {
	const commands = CHECK_STEPS.map(([command]) => command);
	assert.deepEqual(commands, [
		'yarn lint',
		'yarn build',
		'yarn typecheck',
		'yarn test',
		'yarn smoke:published',
	]);
	// Every step must carry a reason; a bare command list stops being read.
	for (const [command, purpose] of CHECK_STEPS) {
		assert.ok(purpose.length > 0, `${command} has no stated purpose`);
	}
});
