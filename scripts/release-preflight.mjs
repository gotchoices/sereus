#!/usr/bin/env node
/**
 * Release preflight — the confirmation gate in front of `yarn bump && yarn pub`.
 *
 * `yarn pub` publishes to npm, which is irreversible for a given version number. This script
 * deliberately does NOT run the checks itself: a release should not silently spend twenty minutes
 * re-running what you just ran, and a gate that is slow gets bypassed. Instead it states what
 * `yarn check` covers, reports the facts it can establish cheaply, and requires an explicit typed
 * confirmation that the check was run.
 *
 * Matches the shape used by the sibling repositories (`../optimystic/scripts/release-preflight.mjs`,
 * `../quereus/scripts/release-guard.js`) so that releasing any of the three feels the same.
 *
 * Bypass for automation: `--yes` / `-y`, or `CI=1` in the environment. Without a TTY and without an
 * explicit bypass it aborts rather than assuming consent.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
 * Warnings that depend only on inputs, so they can be unit-tested. Order is severity-descending:
 * whatever is most likely to produce a bad publish comes first.
 */
export function warningsFor(facts, plannedTag) {
	const warnings = [];
	if (plannedTag === undefined) {
		warnings.push(
			'No dist-tag set, so this publishes as `latest` — the version plain `npm install` returns. ' +
			'For a prerelease use `SEREUS_DIST_TAG=alpha yarn release` (publish-package refuses a ' +
			'prerelease version without a tag, so it would fail at publish time anyway).'
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

function report(facts, plannedTag) {
	stdout.write('\nRelease preflight\n');
	stdout.write('─────────────────\n\n');
	stdout.write('`yarn pub` publishes to npm. A published version cannot be replaced.\n\n');
	stdout.write('Run `yarn check` first if you have not already. It covers:\n');
	for (const [command, purpose] of CHECK_STEPS) {
		stdout.write(`  • ${command.padEnd(22)}${purpose}\n`);
	}
	stdout.write('\n');

	if (facts.ok) {
		stdout.write(`Working tree: ${facts.dirty ? 'DIRTY — uncommitted changes present' : 'clean'}\n`);
		stdout.write(`Branch:       ${facts.branch}\n`);
		if (facts.behind !== '0') stdout.write(`Upstream:     ${facts.behind} commit(s) BEHIND origin\n`);
		else if (facts.ahead !== '0') stdout.write(`Upstream:     ${facts.ahead} commit(s) ahead of origin (bump will push)\n`);
		else stdout.write('Upstream:     in sync\n');
	}
	stdout.write(`Dist-tag:     ${plannedTag ?? 'none — publishes as `latest`'}\n\n`);

	const warnings = warningsFor(facts, plannedTag);
	for (const warning of warnings) stdout.write(`!  ${warning}\n\n`);
}

async function main() {
	const facts = gitFacts();
	const plannedTag = resolvePlannedDistTag(argv, env);

	report(facts, plannedTag);

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
