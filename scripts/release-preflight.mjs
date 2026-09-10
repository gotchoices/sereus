#!/usr/bin/env node
/**
 * Release preflight — the confirmation gate in front of the release chain.
 *
 * `yarn release` is five steps: this script, `yarn bump --no-push`, `release-guard.mjs`, `yarn pub`,
 * `release-finish.mjs`. This one runs before the version has been chosen, so it can only judge the
 * things that do not depend on it. Everything that needs the version — the dist-tag refusal, the tag
 * checks — belongs to the guard, which runs after the bump and still before anything is pushed.
 *
 * `yarn pub` publishes to npm, which is irreversible for a given version number. This script
 * deliberately does NOT run the checks itself: a release should not silently spend twenty minutes
 * re-running what you just ran, and a gate that is slow gets bypassed. Instead it states what
 * `yarn check` covers, reports the facts it can establish cheaply, and requires an explicit typed
 * confirmation that the check was run.
 *
 * It does hard-refuse two things, because both would otherwise fail in `release-finish.mjs` — after
 * the publish, when a failure can no longer stop anything: an unusable `gh`, and pending release
 * notes nobody wrote. `SEREUS_GH_RELEASE=0` skips the GitHub release entirely, and with it both
 * checks.
 *
 * Matches the shape used by the sibling repositories (`../optimystic/scripts/release-preflight.mjs`,
 * `../quereus/scripts/release-guard.js`) so that releasing any of the three feels the same.
 *
 * Bypass for automation: `--yes` / `-y`, or `CI=1` in the environment. Without a TTY and without an
 * explicit bypass it aborts rather than assuming consent. The bypass skips the *prompt*; it does not
 * skip the refusals above.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PENDING_NOTES_FILE, ghReleaseEnabled, notesHaveContent, repoRoot } from './lib/release-support.mjs';

/** What the operator must type. Deliberately not "y" — this publishes. */
export const CONFIRM_WORD = 'checked';

/** Every step `yarn check` runs, in order, with what each one is for. */
export const CHECK_STEPS = Object.freeze([
	['yarn lint', 'eslint across the monorepo'],
	['yarn build', 'every package compiles (tests load dist, not src)'],
	['yarn typecheck', 'tsc plus the typecheck-coverage gates'],
	['yarn test', 'every workspace suite, including the real-network integration scenarios'],
	['yarn smoke:published', 'packed tarballs install and run from a clean project'],
]);

/** True when the caller has explicitly opted out of the interactive prompt. */
export function resolveBypass(args, environment) {
	if (args.includes('--yes') || args.includes('-y')) return true;
	const ci = environment['CI'];
	return ci === '1' || ci === 'true';
}

/** Whether a typed answer counts as confirmation. Case- and whitespace-insensitive. */
export function isConfirmed(answer) {
	return typeof answer === 'string' && answer.trim().toLowerCase() === CONFIRM_WORD;
}

/**
 * The dist-tag `yarn pub` will use, mirroring `publish-package.mjs`'s own resolution so the
 * preflight cannot claim one thing while the publish does another. `undefined` means npm's
 * default, which is `latest`.
 */
export function resolvePlannedDistTag(args, environment) {
	const flagIndex = args.indexOf('--tag');
	if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) return args[flagIndex + 1];
	const fromEnv = environment['SEREUS_DIST_TAG'];
	return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : undefined;
}

/**
 * How the pending-notes file stands: absent, present but never written into, or ready to ship as a
 * GitHub release body. `undefined` text means the file does not exist.
 */
export function notesState(text) {
	if (text === undefined) return 'missing';
	return notesHaveContent(text) ? 'ok' : 'empty';
}

/**
 * Hard refusals, as opposed to the warnings below. Each one names a failure that would otherwise
 * surface in `release-finish.mjs`, after npm already has the packages — which is to say, at the one
 * moment when finding it out is useless.
 *
 * `ghAuth` is `'ok' | 'unauthenticated' | 'missing'`; `notes` is what `notesState` returned.
 */
export function releaseBlockers({ ghEnabled, ghAuth, notes }) {
	if (!ghEnabled) return [];
	const blockers = [];
	const hatch = 'set SEREUS_GH_RELEASE=0 to release without a GitHub release page';

	if (ghAuth === 'missing') {
		blockers.push(
			'`gh` could not be run, so the GitHub release cannot be created. Install the GitHub CLI\n' +
			`   from https://cli.github.com and make sure it is on PATH, or ${hatch}.`,
		);
	} else if (ghAuth === 'unauthenticated') {
		blockers.push(
			'`gh auth status` failed — the GitHub CLI is not logged in, so the GitHub release cannot\n' +
			`   be created. Run \`gh auth login\`, or ${hatch}.`,
		);
	}

	if (notes === 'missing') {
		blockers.push(
			`${PENDING_NOTES_FILE} does not exist, so this release has no notes to publish.\n` +
			`   Write this release's notes into it, or ${hatch}.`,
		);
	} else if (notes === 'empty') {
		blockers.push(
			`${PENDING_NOTES_FILE} has nothing beyond its header, so the GitHub release would go out\n` +
			`   with empty notes. Write this release's notes into it, or ${hatch}.`,
		);
	}

	return blockers;
}

/**
 * Warnings that depend only on inputs, so they can be unit-tested. Order is severity-descending:
 * whatever is most likely to produce a bad publish comes first.
 */
export function warningsFor(facts, plannedTag, ghEnabled = true) {
	const warnings = [];
	if (!ghEnabled) {
		warnings.push(
			'SEREUS_GH_RELEASE=0 — no GitHub release will be created, and the pending notes will be ' +
			'left untouched. The push and the npm publish still happen.'
		);
	}
	if (plannedTag === undefined) {
		warnings.push(
			'No dist-tag set, so this publishes as `latest` — the version plain `npm install` returns. ' +
			'For a prerelease use `SEREUS_DIST_TAG=alpha yarn release` (release-guard refuses a ' +
			'prerelease version without a tag right after the bump, before anything is pushed).'
		);
	}
	if (facts.ok && facts.dirty) {
		warnings.push('Working tree is DIRTY. `yarn bump` commits whatever is staged.');
	}
	if (facts.ok && facts.behind !== '0') {
		warnings.push(`Branch is ${facts.behind} commit(s) BEHIND origin — you would publish code origin does not have.`);
	}
	return warnings;
}

/** Cheap, objectively-determinable git facts. Never throws: a missing upstream is reported, not fatal. */
function gitFacts() {
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
	try {
		return {
			ok: true,
			branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
			dirty: git('status', '--porcelain').length > 0,
			ahead: git('rev-list', '--count', '@{upstream}..HEAD'),
			behind: git('rev-list', '--count', 'HEAD..@{upstream}'),
		};
	} catch {
		return { ok: false };
	}
}

/** Whether `gh` is usable at all, and whether it is logged in. A spawn failure is "missing". */
function ghAuthState() {
	const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
	if (result.error) return 'missing';
	return result.status === 0 ? 'ok' : 'unauthenticated';
}

/** The pending notes as text, or `undefined` when the file is not there at all. */
function readPendingNotes() {
	const path = join(repoRoot, PENDING_NOTES_FILE);
	return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function report(facts, plannedTag, ghEnabled, ghAuth, notes) {
	stdout.write('\nRelease preflight\n');
	stdout.write('─────────────────\n\n');
	stdout.write('`yarn pub` publishes to npm. A published version cannot be replaced.\n');
	stdout.write('Nothing is pushed until every package is on npm: the bump stays local, the guard can\n');
	stdout.write('still refuse, and `release-finish` does the push and the GitHub release at the end.\n\n');
	stdout.write('Run `yarn check` first if you have not already. It covers:\n');
	for (const [command, purpose] of CHECK_STEPS) {
		stdout.write(`  • ${command.padEnd(22)}${purpose}\n`);
	}
	stdout.write('\n');

	if (facts.ok) {
		stdout.write(`Working tree: ${facts.dirty ? 'DIRTY — uncommitted changes present' : 'clean'}\n`);
		stdout.write(`Branch:       ${facts.branch}\n`);
		if (facts.behind !== '0') stdout.write(`Upstream:     ${facts.behind} commit(s) BEHIND origin\n`);
		else if (facts.ahead !== '0') stdout.write(`Upstream:     ${facts.ahead} commit(s) ahead of origin (release-finish will push)\n`);
		else stdout.write('Upstream:     in sync\n');
	}
	stdout.write(`Dist-tag:     ${plannedTag ?? 'none — publishes as `latest`'}\n`);
	stdout.write(`GitHub rel.:  ${ghEnabled ? `gh ${ghAuth}, notes ${notes}` : 'skipped (SEREUS_GH_RELEASE=0)'}\n\n`);

	const warnings = warningsFor(facts, plannedTag, ghEnabled);
	for (const warning of warnings) stdout.write(`!  ${warning}\n\n`);
}

async function main() {
	const facts = gitFacts();
	const plannedTag = resolvePlannedDistTag(argv, env);
	const ghEnabled = ghReleaseEnabled(env);
	const ghAuth = ghEnabled ? ghAuthState() : 'ok';
	const notes = ghEnabled ? notesState(readPendingNotes()) : 'ok';

	report(facts, plannedTag, ghEnabled, ghAuth, notes);

	const blockers = releaseBlockers({ ghEnabled, ghAuth, notes });
	if (blockers.length > 0) {
		stdout.write('Refusing to start a release:\n\n');
		for (const blocker of blockers) stdout.write(`!  ${blocker}\n\n`);
		stdout.write('Nothing was bumped, pushed, or published.\n\n');
		return 1;
	}

	if (resolveBypass(argv, env)) {
		stdout.write('Preflight bypassed (--yes / CI). Proceeding.\n\n');
		return 0;
	}

	if (!stdin.isTTY) {
		stdout.write('No interactive terminal available, and no --yes flag. Aborting rather than\n');
		stdout.write('assuming consent to publish. Re-run with `--yes` if this is intentional.\n\n');
		return 1;
	}

	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const answer = await rl.question(`Type "${CONFIRM_WORD}" to confirm \`yarn check\` passed, then bump and publish: `);
		if (!isConfirmed(answer)) {
			stdout.write('\nAborted. Nothing was bumped or published.\n\n');
			return 1;
		}
		stdout.write('\n');
	} finally {
		rl.close();
	}
	return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	exit(await main());
}
