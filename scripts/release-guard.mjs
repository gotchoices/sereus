#!/usr/bin/env node
/**
 * Release guard — the last refusal before anything leaves the machine.
 *
 * `release-preflight.mjs` runs before the version exists, so it can only warn about the things that
 * depend on it. This runs immediately after `yarn bump --no-push`, when the version *is* known and
 * the release commit and its tag exist only locally, and before `yarn pub` reaches npm. That makes
 * it the one place where a refusal costs nothing: no tag on origin, no package on the registry.
 *
 * It exists because of 2026-09-10, when a `1.0.0-beta.1` tag was pushed to origin and the publish
 * then correctly refused it for having no dist-tag. The check was right; it simply ran after the
 * push. Everything that can refuse a release now runs here instead.
 *
 * On refusal it prints the commands to undo the unpushed bump rather than running them — undoing a
 * commit is the operator's decision, not a script's.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stdout, argv, env, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

import { publishableWorkspaces } from './lib/published-smoke-support.mjs';
import { registryHasVersion, repoRoot } from './lib/release-support.mjs';
import { assertDistTagForPrerelease, resolveDistTag } from './publish-package.mjs';

/**
 * How to undo an unpushed bump. `--keep`, not `--hard`: it refuses rather than discarding
 * uncommitted work that has nothing to do with the release.
 */
export function undoCommands(version) {
	return [`git tag -d v${version}`, 'git reset --keep HEAD~1'];
}

/**
 * Every refusal that can be decided from the repository alone, in severity order. Kept separate
 * from the registry check below so a broken bump is reported without five network round-trips
 * first — and so a registry outage cannot mask a failure the operator could have fixed offline.
 *
 * `state` is `{ version, tagName, packages: [{ name, version }], tag, tagExists, tagCommit,
 * headCommit }`.
 */
export function localGuardFailures(state) {
	const failures = [];

	const mismatched = state.packages.filter((pkg) => pkg.version !== state.version);
	if (mismatched.length > 0) {
		const detail = mismatched.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ');
		failures.push(
			`the root package.json says ${state.version}, but ${detail} ${mismatched.length === 1 ? 'does' : 'do'} not match.\n` +
			'   All packages in this monorepo share one version; the bump did not reach every workspace.',
		);
	}

	// Reuse the publish's own refusal so the guard and the publish cannot disagree about what
	// counts as a prerelease that needs a tag. Reported against the first package in publish
	// order — the one `yarn pub` would have failed on, five minutes and one push too late.
	try {
		assertDistTagForPrerelease(state.packages[0]?.name ?? 'this release', state.version, state.tag);
	} catch (error) {
		failures.push(error.message.replace(/\n/g, '\n  '));
	}

	if (!state.tagExists) {
		failures.push(
			`tag ${state.tagName} does not exist. \`yarn bump\` creates it, so if it is missing the bump\n` +
			'   did not finish and there is nothing to release.',
		);
	} else if (state.tagCommit !== state.headCommit) {
		failures.push(
			`tag ${state.tagName} points at ${state.tagCommit?.slice(0, 8)}, but HEAD is ${state.headCommit?.slice(0, 8)}.\n` +
			'   Publishing now would ship code the tag does not name.',
		);
	}

	return failures;
}

/**
 * The one refusal that needs the registry: a release with nothing left to publish. Without it,
 * re-running `yarn release` on an already-released version would sail through to the finish step
 * and open a GitHub release page for a version that shipped days ago.
 */
export function alreadyFullyPublishedFailure(version, packages) {
	if (packages.length === 0 || !packages.every((pkg) => pkg.published)) {
		return undefined;
	}
	return (
		`every publishable package already has ${version} on npm, so this release has nothing to publish.\n` +
		'   To finish a half-done release instead of starting one, see docs/releasing.md →\n' +
		'   "Recovering a half-finished release".'
	);
}

/** Cheap git facts about the tag the bump just made. A missing tag is a fact, not an exception. */
function gitState(tagName) {
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
	const headCommit = git('rev-parse', 'HEAD');
	let tagCommit;
	try {
		// `rev-list -n 1` peels an annotated tag down to the commit it names.
		tagCommit = git('rev-list', '-n', '1', tagName);
	} catch {
		tagCommit = undefined;
	}
	return { headCommit, tagExists: tagCommit !== undefined, tagCommit };
}

function reportRefusal(version, failures) {
	stdout.write('\nRelease guard\n');
	stdout.write('─────────────\n\n');
	stdout.write(`Refusing to publish v${version}:\n\n`);
	for (const failure of failures) {
		stdout.write(`!  ${failure}\n\n`);
	}
	stdout.write('Nothing has been pushed and nothing has been published. The release commit and its\n');
	stdout.write('tag exist only on this machine. To undo them:\n\n');
	for (const command of undoCommands(version)) {
		stdout.write(`  ${command}\n`);
	}
	stdout.write('\n`--keep`, not `--hard`: it refuses rather than discarding uncommitted work.\n\n');
}

async function main() {
	const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
	const tagName = `v${version}`;
	const workspaces = publishableWorkspaces(repoRoot);
	const tag = resolveDistTag(argv.slice(2), env);

	const packages = workspaces.map(({ manifest }) => ({ name: manifest.name, version: manifest.version }));
	const local = localGuardFailures({ version, tagName, packages, tag, ...gitState(tagName) });
	if (local.length > 0) {
		reportRefusal(version, local);
		return 1;
	}

	stdout.write(`\nRelease guard: v${version} tagged at HEAD, dist-tag ${tag ?? 'latest (npm default)'}.\n`);
	stdout.write(`Checking whether ${packages.length} package(s) are already on npm...\n`);
	const probed = [];
	for (const pkg of packages) {
		probed.push({ ...pkg, published: await registryHasVersion(pkg.name, version) });
	}

	const alreadyPublished = alreadyFullyPublishedFailure(version, probed);
	if (alreadyPublished !== undefined) {
		reportRefusal(version, [alreadyPublished]);
		return 1;
	}

	const remaining = probed.filter((pkg) => !pkg.published).map((pkg) => pkg.name);
	stdout.write(`Still to publish: ${remaining.join(', ')}\n\n`);
	return 0;
}

// Guard so `scripts/release-guard.test.mjs` can import the pure decisions above without running
// git or reaching the registry as a side effect of loading the module.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	exit(await main().catch((error) => {
		stdout.write(`\nRelease guard failed: ${error.message}\n\n`);
		return 1;
	}));
}
