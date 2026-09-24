#!/usr/bin/env node
/**
 * Release check: run this repository's own gates against the *registry* copies of the
 * two sibling projects, instead of the working copies on this disk.
 *
 * Root `package.json` has a `resolutions` block redirecting every `@optimystic/*` and
 * `@quereus/quereus` import to `link:../optimystic/...` and `link:../quereus/...`. So
 * every suite here tests against another project's checkout, often with somebody
 * else's uncommitted edits in it — not against what this repository declares as its
 * dependency range, and not against what a user downloads.
 *
 * Two neighbouring checks cover different halves of that gap and neither covers this
 * one. `scripts/check-dep-ranges.mjs` proves a declared range *admits* the linked
 * version, but installs nothing. `scripts/smoke-published-install.mjs` packs *our*
 * packages and runs one scenario against them in a scratch project, but that project
 * never sees `resolutions` at all. What has never been possible is running this
 * repository's own suites against registry copies of the siblings, and that is this:
 *
 *   1. add a detached git worktree at `HEAD`, outside this repository,
 *   2. delete the `resolutions` key from its root `package.json` — nothing else,
 *   3. `yarn install --no-immutable` there, resolving the siblings from the registry,
 *   4. report the version and path each sibling resolved to,
 *   5. run `yarn build`, `yarn lint`, `yarn typecheck`, `yarn test` in the worktree,
 *   6. remove the worktree.
 *
 * Deliberately NOT a gate and not wired into `yarn test`: it needs the network and
 * runs for many minutes. Run it by hand as a release step — `yarn check:published` —
 * beside `yarn smoke:published`. See docs/testing.md. Chaining it into `yarn test`,
 * `yarn typecheck`, `yarn lint`, `yarn build` or `yarn check` would also make it
 * recursive, since the worktree runs the first four of those.
 *
 * The worktree is built from `HEAD`, so a dirty working tree is refused: the run
 * would otherwise describe a commit rather than what the caller is looking at.
 * `--allow-dirty` proceeds anyway, still from `HEAD`. `--keep` retains the worktree.
 *
 * `--skip-gates` stops after step 4. The install and the report are the fast half —
 * minutes, not the better part of an hour — and they answer the question that fails
 * most often: whether the published siblings resolve at all, and at which versions.
 * It is also the only form of this script that finishes inside an agent's or a
 * reviewer's patience, so it is what proves the steps around the gates still work.
 *
 * Do NOT run `yarn smoke:published` inside the worktree. It packs this repository's
 * own tarballs into its own scratch project outside the repo and never reads
 * `resolutions`, so running it there measures nothing the main tree has not already.
 *
 * The decisions this makes about the manifest, about git's output and about a
 * directory tree live in `scripts/lib/published-check-support.mjs` and are unit-tested
 * by `scripts/check-published.test.mjs`; what stays here is the orchestration and the
 * reporting, which only a real run can cover.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	delinkedManifest,
	dirtyPaths,
	longPath,
	nestedSiblingCopies,
	parseFlags,
	reportedSiblingNames,
	unlinkReparsePoints,
	workspacePackages
} from './lib/published-check-support.mjs';
import { hoistedVersions, readJson } from './lib/published-smoke-support.mjs';
import { capture, run } from './lib/run-command.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `yarn install` in the worktree. Dropping `resolutions` necessarily rewrites the
 * lockfile, and Yarn makes installs immutable by default whenever `CI` is set —
 * without the flag this fails in exactly the environment the check is most wanted in.
 */
const INSTALL_ARGS = ['install', '--no-immutable'];

/**
 * The root scripts run in the worktree, in order. `build` first because every other
 * one reads compiled output: `lint` is type-aware, `typecheck` walks the same
 * programs, and `test` runs against each package's `dist`.
 */
const WORKTREE_GATES = ['build', 'lint', 'typecheck', 'test'];

/**
 * Refuse a tree that differs from `HEAD`. Reporting the paths matters more than the
 * refusal: the usual cause is the caller's own in-progress edit, and the usual fix is
 * to commit it rather than to reach for `--allow-dirty`.
 */
function reportDirtyTree(allowDirty) {
	const dirty = dirtyPaths(capture('git', ['status', '--porcelain'], rootDir));
	if (dirty.length === 0) {
		return true;
	}
	const lines = dirty.map((path) => `  ${path}`).join('\n');
	if (!allowDirty) {
		console.error(`\ncheck-published: the working tree differs from HEAD, and the worktree is built from HEAD:\n${lines}`);
		console.error('Commit first, or pass --allow-dirty to check HEAD anyway (these changes will NOT be checked).');
		return false;
	}
	console.warn(`\ncheck-published: --allow-dirty — HEAD is what gets checked; these changes are NOT in it:\n${lines}`);
	return true;
}

/** Drop `resolutions` from the worktree's root manifest, and say what that changed. */
function delinkWorktree(worktreeDir) {
	const manifestPath = join(worktreeDir, 'package.json');
	const { text, delinked, alsoDropped } = delinkedManifest(readFileSync(manifestPath, 'utf8'));
	writeFileSync(manifestPath, text);

	console.log(`\nde-linked ${delinked.length} sibling package(s) — they now come from the registry:`);
	for (const name of delinked) {
		console.log(`  ${name}`);
	}
	if (alsoDropped.length > 0) {
		console.log(`also dropped with the resolutions key (not sibling links): ${alsoDropped.join(', ')}`);
	}
	return delinked;
}

/**
 * The hoisted view first, then only the workspaces that resolved something else —
 * the same shape `smoke-published-install.mjs` prints, and for the same reason: the
 * point of the run is which artifacts were tested, and a package with its own
 * `node_modules` did not test the hoisted one.
 *
 * NOTE: accepted tradeoff — several names print `(not installed)` on a healthy run
 * and that is not a fault. On 2026-09-24 three of ten did: `@optimystic/demo` has a
 * `resolutions` entry but nothing here depends on it, and `db-p2p-storage-ns`/`-rn`
 * are wanted only by reference apps that hoist into their own `node_modules`, where
 * the second list below shows them resolved. Filtering them out was weighed and
 * declined: hiding a name the root manifest names is the worse failure, because a
 * sibling that genuinely failed to install would then vanish from the report
 * instead of standing out. Revisit if the hoisted list ever grows long enough that
 * the real signal is hard to find in it.
 */
function reportResolved(worktreeDir, workspaces, names) {
	console.log('\n=== what the worktree resolved ===');
	console.log('\n  hoisted at the worktree root:');
	for (const { name, version, dir } of hoistedVersions(worktreeDir, names)) {
		console.log(dir === null
			? `    ${name.padEnd(42)} (not installed)`
			: `    ${name.padEnd(42)} ${String(version).padEnd(12)} ${relative(worktreeDir, dir)}`);
	}

	console.log('\n  workspaces resolving their own copy instead:');
	const copies = nestedSiblingCopies(worktreeDir, workspaces, names);
	for (const { consumer, name, version, dir } of copies) {
		console.log(`    ${consumer} → ${name} ${version}  at ${relative(worktreeDir, dir)}`);
	}
	if (copies.length === 0) {
		console.log('    none — every workspace resolves the same copy the worktree root does.');
	}
}

/**
 * Delete the worktree, links first.
 *
 * `docs/testing.md` records a Windows `git worktree remove --force` that followed the
 * `link:` junctions and emptied the sibling checkouts they pointed at. This worktree
 * has no `resolutions` and so no sibling junctions, but it is full of the ones yarn
 * writes for the workspaces themselves; unlinking first keeps every delete below
 * confined to the worktree whatever it does with reparse points.
 */
function removeWorktree(worktreeDir, scratchDir) {
	const links = unlinkReparsePoints(worktreeDir);
	console.log(`\nunlinked ${links.length} symlink(s)/junction(s), then removing ${worktreeDir}`);
	try {
		run('git', ['worktree', 'remove', '--force', worktreeDir], rootDir, { quiet: true });
	} catch (err) {
		// Windows: git gives up on deep `node_modules` paths with `Filename too long`,
		// having already de-registered the worktree. Finish the delete in a path form
		// Windows accepts, then clear any registration git did leave behind.
		console.log(`note: git could not remove the worktree (${err.message}); deleting the files directly.`);
		rmSync(longPath(worktreeDir), { recursive: true, force: true });
		run('git', ['worktree', 'prune'], rootDir, { quiet: true });
	}
	rmSync(longPath(scratchDir), { recursive: true, force: true });
}

function cleanup(worktreeDir, scratchDir, { added, ok, keep }) {
	if (!added) {
		// `git worktree add` never got as far as registering anything, so there is no
		// worktree to name in the advice below and nothing but an empty scratch
		// directory to drop.
		rmSync(longPath(scratchDir), { recursive: true, force: true });
		return;
	}
	if (!ok || keep) {
		console.log(`\nworktree left in place: ${worktreeDir}`);
		console.log(`remove it with: git worktree remove --force "${worktreeDir}"  (then "git worktree prune" if that reports Filename too long)`);
		return;
	}
	try {
		removeWorktree(worktreeDir, scratchDir);
	} catch (err) {
		console.log(`\nnote: could not remove the worktree ${worktreeDir}: ${err.message}`);
		console.log('Clear the registration with: git worktree prune');
	}
}

function main(flags) {
	if (!reportDirtyTree(flags.allowDirty)) {
		return 1;
	}

	const head = capture('git', ['rev-parse', 'HEAD'], rootDir).trim();
	// Outside this repository, for the same reason the smoke's scratch project is:
	// inside, the root `workspaces` glob and the ESLint config would both see it.
	const scratchDir = mkdtempSync(join(tmpdir(), 'sereus-check-published-'));
	const worktreeDir = join(scratchDir, 'repo');
	console.log(`check-published: checking ${head} against the published sibling packages.`);
	console.log(`worktree: ${worktreeDir}`);

	let added = false;
	let ok = false;
	try {
		run('git', ['worktree', 'add', '--detach', worktreeDir, head], rootDir);
		added = true;
		delinkWorktree(worktreeDir);

		run('yarn', INSTALL_ARGS, worktreeDir);

		// Printed before any gate runs, so it survives a failure in one of them. The
		// names come from *this* repo's manifest, since the worktree's no longer has a
		// `resolutions` block to read them from.
		const workspaces = workspacePackages(worktreeDir);
		reportResolved(worktreeDir, workspaces, reportedSiblingNames(readJson(join(rootDir, 'package.json')), workspaces));

		for (const gate of flags.skipGates ? [] : WORKTREE_GATES) {
			run('yarn', [gate], worktreeDir);
		}

		ok = true;
		console.log(flags.skipGates
			? `\ncheck-published: installed — ${head} resolves the published siblings above. No gate was run (--skip-gates).`
			: `\ncheck-published: PASSED — ${head} builds, lints, type-checks and tests against the published siblings.`);
		return 0;
	} finally {
		cleanup(worktreeDir, scratchDir, { added, ok, keep: flags.keep });
	}
}

let exitCode;
try {
	exitCode = main(parseFlags(process.argv.slice(2)));
} catch (err) {
	console.error(`\ncheck-published: FAILED — ${err.message}`);
	exitCode = 1;
}
process.exit(exitCode);
