/**
 * Unit tests for the decisions `scripts/release-finish.mjs` makes after npm already has the
 * packages: which `gh release create` arguments a given version and dist-tag earn, and which
 * commands are still left to run when one of the steps fails.
 *
 * The pushes, the `gh` invocation and the notes reset are not exercised here — the module guards
 * its `main()` invocation, so importing it for these tests never pushes anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FINISH_STEPS, ghReleaseArgs, notesResetCommands, parseFinishFlags, remainingCommands } from './release-finish.mjs';

test('a stable release under no dist-tag is the plain case: latest, not a prerelease', () => {
	assert.deepEqual(ghReleaseArgs({ version: '0.14.0', tag: undefined }), [
		'release', 'create', 'v0.14.0', '--verify-tag', '--notes-file', '.release-notes.pending.md',
	]);
});

test('a semver prerelease is marked as one on GitHub', () => {
	const args = ghReleaseArgs({ version: '1.0.0-beta.1', tag: 'beta' });
	assert.ok(args.includes('--prerelease'));
	// Under a non-latest tag it is also not what `npm install` returns, so it is not "Latest".
	assert.ok(args.includes('--latest=false'));
});

test('a stable version published under a non-latest tag must not claim the Latest badge', () => {
	const args = ghReleaseArgs({ version: '0.14.0', tag: 'next' });
	assert.ok(args.includes('--latest=false'), 'a `next` release is not what npm install returns');
	assert.ok(!args.includes('--prerelease'), '0.14.0 is not a semver prerelease');
});

test('an explicit latest tag is the same as no tag as far as the badge goes', () => {
	assert.ok(!ghReleaseArgs({ version: '1.0.0-beta.1', tag: 'latest' }).includes('--latest=false'));
	assert.ok(ghReleaseArgs({ version: '1.0.0-beta.1', tag: 'latest' }).includes('--prerelease'));
});

test('--verify-tag is always passed, so no release page is created against an unpushed tag', () => {
	for (const tag of [undefined, 'latest', 'next']) {
		assert.ok(ghReleaseArgs({ version: '0.14.0', tag }).includes('--verify-tag'));
	}
});

test('the notes file is passed as its own argument, never interpolated into a command string', () => {
	const args = ghReleaseArgs({ version: '0.14.0', tag: undefined, notesFile: 'notes.md' });
	assert.equal(args[args.indexOf('--notes-file') + 1], 'notes.md');
});

test('a failed push lists every step, because none of them have run', () => {
	assert.deepEqual(remainingCommands('push-commit', { version: '0.14.0', tag: undefined, ghEnabled: true }), [
		'git push origin HEAD',
		'git push origin v0.14.0',
		'gh release create v0.14.0 --verify-tag --notes-file .release-notes.pending.md',
		'node scripts/release-finish.mjs --notes-only',
	]);
});

test('a failed tag push does not tell the operator to push the commit again', () => {
	const commands = remainingCommands('push-tag', { version: '0.14.0', tag: undefined, ghEnabled: true });
	assert.deepEqual(commands[0], 'git push origin v0.14.0');
	assert.ok(!commands.includes('git push origin HEAD'));
});

test('a failed gh release leaves only the release and the notes reset', () => {
	assert.deepEqual(remainingCommands('gh-release', { version: '1.0.0-beta.1', tag: 'beta', ghEnabled: true }), [
		'gh release create v1.0.0-beta.1 --verify-tag --prerelease --latest=false --notes-file .release-notes.pending.md',
		'node scripts/release-finish.mjs --notes-only',
	]);
});

test('a failed notes reset leaves exactly one command', () => {
	assert.deepEqual(remainingCommands('reset-notes', { version: '0.14.0', tag: undefined, ghEnabled: true }), [
		'node scripts/release-finish.mjs --notes-only',
	]);
});

test('with the GitHub release skipped, recovery is the pushes and nothing else', () => {
	assert.deepEqual(remainingCommands('push-commit', { version: '0.14.0', tag: undefined, ghEnabled: false }), [
		'git push origin HEAD',
		'git push origin v0.14.0',
	]);
	// The pending notes were never consumed, so there is nothing to reset.
	assert.deepEqual(remainingCommands('reset-notes', { version: '0.14.0', tag: undefined, ghEnabled: false }), []);
});

test('an unknown step is a loud error, not an empty recovery list', () => {
	assert.throws(
		() => remainingCommands('publish', { version: '0.14.0', tag: undefined, ghEnabled: true }),
		/unknown finish step "publish"/,
	);
});

test('the steps run in the order the recovery text depends on', () => {
	assert.deepEqual([...FINISH_STEPS], ['push-commit', 'push-tag', 'gh-release', 'reset-notes']);
});

test('the notes reset commits what it staged, then pushes it', () => {
	assert.deepEqual(notesResetCommands('0.14.0', true), [
		['commit', '-m', 'chore: open release notes after v0.14.0'],
		['push', 'origin', 'HEAD'],
	]);
});

test('the notes reset pushes even with nothing to commit, so a re-run cannot strand the commit', () => {
	// `--notes-only` after a rejected push finds the file already reset. Skipping the push there
	// would call the release finished while the reset commit is still only on this machine.
	assert.deepEqual(notesResetCommands('0.14.0', false), [['push', 'origin', 'HEAD']]);
});

test('--notes-only is this script\'s own flag; everything else is left for the dist-tag parser', () => {
	assert.deepEqual(parseFinishFlags([]), { notesOnly: false, rest: [] });
	assert.deepEqual(parseFinishFlags(['--notes-only']), { notesOnly: true, rest: [] });
	assert.deepEqual(parseFinishFlags(['--tag', 'next']), { notesOnly: false, rest: ['--tag', 'next'] });
	assert.deepEqual(parseFinishFlags(['--notes-only', '--tag', 'next']), { notesOnly: true, rest: ['--tag', 'next'] });
});
