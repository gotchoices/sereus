#!/usr/bin/env node
/**
 * Release finish — everything that happens *after* npm has the packages.
 *
 * The ordering rule this repo now follows is that nothing leaves the machine until every package is
 * on npm, so the push and the GitHub release both happen here, at the end. That has one consequence
 * worth stating loudly: every failure in this script happens after an irreversible publish. A
 * failure here is not a failed release, it is an unfinished one, and the operator's job is to finish
 * it rather than start over. So each failure prints "npm publish succeeded" first, then the exact
 * commands still left to run, and exits non-zero.
 *
 * Steps, in order:
 *   1. `git push origin HEAD`, then `git push origin v{version}` — explicit, never `--follow-tags`,
 *      so an unrelated local tag is never pushed as a side effect of a release.
 *   2. `gh release create` from `.release-notes.pending.md`.
 *   3. Reset the pending notes to their empty header and commit that.
 *
 * `--notes-only` runs step 3 alone — it is what the recovery text points at when steps 1 and 2 have
 * already landed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdout, argv, env, exit } from 'node:process';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

import {
	EMPTY_NOTES_HEADER,
	PENDING_NOTES_FILE,
	ghReleaseEnabled,
	notesAreReset,
	repoRoot,
} from './lib/release-support.mjs';
import { resolveDistTag } from './publish-package.mjs';

/** The steps, in the order they run. Recovery text is "this step onward", so the order is the API. */
export const FINISH_STEPS = Object.freeze(['push-commit', 'push-tag', 'gh-release', 'reset-notes']);

/**
 * `gh release create` arguments, as argv — never an interpolated command string, so a dist-tag
 * never reaches a shell.
 *
 * `--verify-tag` makes gh refuse when the tag is not on origin, which is what keeps a release page
 * from being created against a tag a failed push left behind. `--latest=false` goes on whenever the
 * packages went out under a dist-tag other than `latest`, so GitHub's "Latest" badge agrees with
 * what `npm install` returns — a stable version published under `next` is still not the latest.
 */
export function ghReleaseArgs({ version, tag, notesFile = PENDING_NOTES_FILE }) {
	const args = ['release', 'create', `v${version}`, '--verify-tag'];
	if (semver.prerelease(version) !== null) {
		args.push('--prerelease');
	}
	if (tag !== undefined && tag !== 'latest') {
		args.push('--latest=false');
	}
	args.push('--notes-file', notesFile);
	return args;
}

/**
 * The commands still left to run, starting at the step that failed. Only the remaining ones: after
 * a `gh release create` failure the push has already landed, and telling the operator to push again
 * invites them to wonder whether the earlier steps really worked.
 */
export function remainingCommands(fromStep, { version, tag, ghEnabled }) {
	const start = FINISH_STEPS.indexOf(fromStep);
	if (start === -1) {
		throw new Error(`unknown finish step "${fromStep}"`);
	}
	const commands = [];
	for (const step of FINISH_STEPS.slice(start)) {
		switch (step) {
			case 'push-commit':
				commands.push('git push origin HEAD');
				break;
			case 'push-tag':
				commands.push(`git push origin v${version}`);
				break;
			case 'gh-release':
				// With the hatch set there is no release page and no notes to consume, so neither
				// this step nor the reset below is part of the release at all.
				if (ghEnabled) {
					commands.push(`gh ${ghReleaseArgs({ version, tag }).join(' ')}`);
				}
				break;
			case 'reset-notes':
				if (ghEnabled) {
					commands.push('node scripts/release-finish.mjs --notes-only');
				}
				break;
		}
	}
	return commands;
}

/** `--notes-only` is this script's own flag; everything else is left for `resolveDistTag` to judge. */
export function parseFinishFlags(args) {
	const flags = { notesOnly: false, rest: [] };
	for (const arg of args) {
		if (arg === '--notes-only') {
			flags.notesOnly = true;
		} else {
			flags.rest.push(arg);
		}
	}
	return flags;
}

function run(command, args) {
	stdout.write(`  ${command} ${args.join(' ')}\n`);
	execFileSync(command, args, { stdio: 'inherit', cwd: repoRoot });
}

/**
 * Rewrite the pending-notes file to its empty header and stage it, answering whether that left
 * anything to commit. Two ways it leaves nothing: the file is already reset, or its only difference
 * was line endings, which normalize away on `git add`. Either way `git commit` would exit non-zero
 * with nothing staged, which here would read as a failed release rather than a finished one.
 */
function stagePendingNotesReset() {
	const path = join(repoRoot, PENDING_NOTES_FILE);
	if (notesAreReset(readFileSync(path, 'utf8'))) {
		stdout.write(`${PENDING_NOTES_FILE} is already reset — nothing to commit.\n`);
		return false;
	}
	writeFileSync(path, EMPTY_NOTES_HEADER, 'utf8');
	run('git', ['add', PENDING_NOTES_FILE]);
	const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', PENDING_NOTES_FILE], {
		encoding: 'utf8',
		cwd: repoRoot,
	}).trim();
	if (staged === '') {
		stdout.write(`${PENDING_NOTES_FILE} was already open for the next release — nothing to commit.\n`);
		return false;
	}
	return true;
}

/**
 * The git commands the notes reset runs, given whether staging left anything to commit.
 *
 * The push is unconditional. A run whose commit landed but whose push was rejected (someone else
 * pushed to `master` meanwhile — the failure this step is likeliest to hit) is told to re-run
 * `--notes-only`, and by then the file *is* reset; skipping the push on that second run would
 * report the release finished with the reset commit still sitting on this machine. `git push` with
 * nothing to send is a no-op, so running it either way costs one round-trip.
 */
export function notesResetCommands(version, hasStagedChange) {
	const commands = [];
	if (hasStagedChange) {
		commands.push(['commit', '-m', `chore: open release notes after v${version}`]);
	}
	commands.push(['push', 'origin', 'HEAD']);
	return commands;
}

/** Open a fresh pending-notes file for the next release, and get it to origin. */
function resetPendingNotes(version) {
	for (const args of notesResetCommands(version, stagePendingNotesReset())) {
		run('git', args);
	}
}

function reportUnfinished(step, error, context) {
	stdout.write('\nnpm publish succeeded — every package is on npm.\n');
	stdout.write('This failure is in the steps that follow the publish, so do NOT start the release\n');
	stdout.write('over; finish it.\n\n');
	stdout.write(`Failed step: ${step}\n`);
	stdout.write(`  ${error.message}\n\n`);
	stdout.write('Remaining commands:\n\n');
	for (const command of remainingCommands(step, context)) {
		stdout.write(`  ${command}\n`);
	}
	stdout.write('\n');
}

async function main() {
	const { notesOnly, rest } = parseFinishFlags(argv.slice(2));
	const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
	const tag = resolveDistTag(rest, env);
	const ghEnabled = ghReleaseEnabled(env);
	const context = { version, tag, ghEnabled };

	stdout.write(`\nRelease finish — v${version}\n`);
	stdout.write('─────────────────────────\n\n');
	// NOTE: the dist-tag is re-resolved here from argv/env, not read back from the registry. Inside
	// `yarn release` that is the same value the publish used, because one environment runs the whole
	// chain. Publishing by hand in one shell and finishing in another loses it, and a *stable*
	// version published under `next` would then be created without `--latest=false` and claim the
	// GitHub "Latest" badge. Printing it is the cheap guard; if that ever bites, read the tag back
	// with `npm dist-tag ls <name>` instead of trusting the environment.
	stdout.write(`Dist-tag: ${tag ?? 'latest (npm default)'}\n\n`);

	let step = notesOnly ? 'reset-notes' : 'push-commit';
	try {
		if (!notesOnly) {
			run('git', ['push', 'origin', 'HEAD']);
			step = 'push-tag';
			run('git', ['push', 'origin', `v${version}`]);
			if (!ghEnabled) {
				stdout.write('\nSEREUS_GH_RELEASE=0 — no GitHub release created, and the pending notes are left\n');
				stdout.write(`untouched: nothing consumed them, so wiping ${PENDING_NOTES_FILE} would lose them.\n\n`);
				return 0;
			}
			step = 'gh-release';
			run('gh', ghReleaseArgs({ version, tag }));
			step = 'reset-notes';
		} else if (!ghEnabled) {
			stdout.write(`SEREUS_GH_RELEASE=0 — ${PENDING_NOTES_FILE} left untouched.\n\n`);
			return 0;
		}
		resetPendingNotes(version);
	} catch (error) {
		reportUnfinished(step, error, context);
		return 1;
	}

	stdout.write(`\nReleased v${version}: pushed, published, and the GitHub release is up.\n\n`);
	return 0;
}

// Guard so `scripts/release-finish.test.mjs` can import the pure decisions above without pushing
// or creating a release as a side effect of loading the module.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	exit(await main().catch((error) => {
		// Only the setup ahead of the first step can land here — reading the root manifest, or a
		// dist-tag `resolveDistTag` refuses. Nothing has been pushed at that point, so this is a
		// plain failure and not an unfinished release; report it as one instead of as a stack trace.
		stdout.write(`\nRelease finish could not start: ${error.message}\n\n`);
		return 1;
	}));
}
