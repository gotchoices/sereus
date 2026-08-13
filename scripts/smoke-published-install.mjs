#!/usr/bin/env node
/**
 * Release gate: install what a customer installs, then run a real node against it.
 *
 * Every suite in this repo resolves `@optimystic/*` and `@quereus/quereus` through the
 * root `package.json` `resolutions` block, which points at `link:../optimystic/...` and
 * `link:../quereus/...`. A green suite therefore proves the code works against the
 * sibling working copies on this machine; it says nothing about the tarballs on npm.
 * `scripts/check-dep-ranges.mjs` proves the declared range *admits* the version we
 * develop against, but it never installs anything, so it cannot prove the published
 * artifact at that version works. This script closes that half:
 *
 *   1. pack every publishable workspace (yarn rewrites `workspace:^` to `^<version>`,
 *      so the tarballs are exactly what `yarn npm publish` would upload),
 *   2. install them with **npm** into a scratch project under the OS temp dir, with
 *      everything else resolved from the public registry,
 *   3. run the cadre-of-one control-DB scenario there
 *      (`scripts/lib/published-smoke-scenario.mjs`, a port of
 *      `packages/cadre-core/test/control-database-solo.spec.ts`),
 *   4. report the resolved version *and path* of every dependency that matters.
 *
 * Deliberately NOT wired into `yarn test`: it needs the network and takes tens of
 * seconds. Run it as a release step — `yarn smoke:published`.
 *
 * npm, not yarn, inside the scratch project: yarn would walk upward looking for a
 * workspace root. The scratch project lives outside this repo for the same reason —
 * no `resolutions` or workspace inheritance can leak in.
 *
 * Flags: `--skip-build` (reuse existing `dist/`, refused if any of it is stale),
 * `--keep` (keep the scratch dir even on success).
 *
 * The decisions this makes about the repo and about an installed tree live in
 * `scripts/lib/published-smoke-support.mjs` and are unit-tested by
 * `scripts/smoke-published-install.test.mjs`; what stays here is the orchestration
 * and the reporting.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	declaredRange,
	hoistedVersions,
	nestedCopies,
	parseFlags,
	publishableWorkspaces,
	reportedPackages,
	staleWorkspaces,
	tarballProvenance
} from './lib/published-smoke-support.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');

/**
 * Packages whose resolved version is worth printing on top of the `@serfab/*`,
 * `@optimystic/*` and `@quereus/*` set derived from the manifests (which covers only
 * those three scopes, and only `dependencies`). `libp2p` is the transport core; the
 * three `@libp2p/*` entries are what the scenario itself constructs — websockets for
 * the transport, and crypto + peer-id for the sibling identity the warm-start cases
 * mint. A nested copy of either of the latter two is worth seeing: a peerId minted
 * against one copy and recorded through a `@serfab/cadre-core` holding another is a
 * mismatch that would otherwise surface only as a confusing assertion failure.
 */
const EXTRA_REPORTED = ['libp2p', '@libp2p/websockets', '@libp2p/crypto', '@libp2p/peer-id'];

/**
 * The scratch project imports these directly, so it must declare them itself.
 *
 * `@optimystic/db-p2p-storage-fs` is here for the warm-start cases, which restart
 * across real files rather than a shared heap object. It is also the one
 * `@optimystic/*` package with no root `resolutions` entry (see `docs/STATUS.md` →
 * "declared range"), so it always resolves from the registry — which makes exercising
 * it here more interesting than the linked ones, not less.
 *
 * `@libp2p/crypto` + `@libp2p/peer-id` mint the throwaway sibling identity whose
 * signed `CadrePeer` row puts the device in a cadre it is the last member of.
 */
const SCENARIO_DIRECT_DEPS = [
	'@optimystic/db-p2p',
	'@optimystic/db-p2p-storage-fs',
	'@libp2p/websockets',
	'@libp2p/crypto',
	'@libp2p/peer-id'
];

/**
 * `.cmd` shims (yarn, npm on Windows) cannot be spawned without a shell on modern
 * node, so shell out there and quote anything with whitespace.
 *
 * Output streams as it goes by default — a silent redirect would let an agent
 * runner's idle timer expire on the multi-minute `yarn build`. `quiet` captures
 * instead, and is only for commands that finish in well under a second: `yarn pack`
 * lists every file it archives, which is ~900 lines across the publishable set and
 * buries the report this script exists to print. A quiet command that fails echoes
 * everything it captured before throwing.
 *
 * NOTE: only the win32 branch has ever run. If this is ever used on macOS or Linux,
 * expect the first failure here (`shell: false`) and in the `file:` spec's backslash
 * normalisation in `writeScratchProject`.
 */
function run(command, commandArgs, cwd, { quiet = false } = {}) {
	const useShell = process.platform === 'win32';
	const finalArgs = useShell
		? commandArgs.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg))
		: commandArgs;
	console.log(`\n$ ${command} ${commandArgs.join(' ')}   (in ${cwd})`);
	const result = spawnSync(command, finalArgs, {
		cwd,
		stdio: quiet ? 'pipe' : 'inherit',
		shell: useShell,
		encoding: quiet ? 'utf8' : undefined
	});
	if (result.error) {
		throw new Error(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		if (quiet) {
			process.stderr.write(result.stdout ?? '');
			process.stderr.write(result.stderr ?? '');
		}
		throw new Error(`${command} ${commandArgs.join(' ')} exited with code ${result.status}`);
	}
}

/**
 * The hoisted view first, then only the *differences* each installed package sees from
 * its own directory. Printing every package's full view is ~100 near-identical lines;
 * the delta pass is where the signal is, because a nested duplicate is exactly the
 * failure this report exists to make visible — a run once reported `@quereus/quereus`
 * 0.16.4 at the root while `@serfab/cadre-core` loaded a nested 4.6.0.
 */
function reportResolved(projectDir, workspaces) {
	console.log('\n=== resolved dependency versions ===');
	console.log('\n  hoisted into the consuming project:');
	for (const { name, version, dir } of hoistedVersions(projectDir, reportedPackages(workspaces, EXTRA_REPORTED))) {
		console.log(dir === null
			? `    ${name.padEnd(42)} (not installed)`
			: `    ${name.padEnd(42)} ${String(version).padEnd(12)} ${relative(projectDir, dir)}`);
	}

	console.log('\n  nested copies (a package resolving something other than the hoisted one):');
	const copies = nestedCopies(projectDir, workspaces);
	for (const { consumer, dep, version, dir } of copies) {
		console.log(`    ${consumer} → ${dep} ${version}  at ${relative(projectDir, dir)}`);
	}
	if (copies.length === 0) {
		console.log('    none — every package resolves the same copy the project root does.');
	}
}

/** Fail loudly if npm satisfied one of our own packages from anywhere but the packed tarball. */
function reportProvenance(projectDir, workspaces) {
	const { lockfilePresent, wrong } = tarballProvenance(projectDir, workspaces);
	if (!lockfilePresent) {
		console.log('\nnote: no package-lock.json written; cannot confirm the tarballs were used.');
		return true;
	}
	if (wrong.length === 0) {
		return true;
	}
	console.error('\nsmoke-published-install: these packages were NOT installed from the packed tarballs:');
	for (const { name, resolved } of wrong) {
		console.error(`  ${name} resolved to ${resolved}`);
	}
	console.error('The scenario below would be testing a previously published build, not this one.');
	return false;
}

/**
 * Refuse `--skip-build` when `dist` is missing or older than `src`. `pack` does not
 * build, so the tarballs would carry the previous build and a pass would mean nothing.
 */
function reportStaleBuilds(workspaces) {
	const stale = staleWorkspaces(workspaces);
	if (stale.length === 0) {
		console.log('--skip-build: reusing each package\'s existing dist/ (checked newer than its src/).');
		return true;
	}
	console.error('\nsmoke-published-install: --skip-build would pack output that does not match src:');
	for (const { name, reason } of stale) {
		console.error(`  ${name}: ${reason === 'missing' ? 'never built — no dist/' : 'dist/ is older than src/'}`);
	}
	console.error('Re-run without --skip-build so the tarballs carry the source in this working tree.');
	return false;
}

function writeScratchProject(scenarioPath, projectDir, workspaces, tarballDir) {
	const dependencies = {};
	for (const { manifest, tarballName } of workspaces) {
		// A relative `file:` spec, and declared at the top level so each tarball also
		// satisfies the others' registry ranges (`@serfab/cadre-host` depends on
		// `@serfab/cadre-cli@^0.9.0`, which the hoisted tarball answers).
		dependencies[manifest.name] = `file:${relative(projectDir, join(tarballDir, tarballName)).split('\\').join('/')}`;
	}
	for (const depName of SCENARIO_DIRECT_DEPS) {
		dependencies[depName] = declaredRange(workspaces, depName);
	}
	writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify({
		name: 'sereus-published-smoke',
		version: '0.0.0',
		private: true,
		type: 'module',
		dependencies
	}, null, 2)}\n`);
	copyFileSync(scenarioPath, join(projectDir, 'scenario.mjs'));
	return dependencies;
}

function cleanup(scratchDir, ok, keep) {
	if (!ok || keep) {
		console.log(`\nscratch project left in place: ${scratchDir}`);
		return;
	}
	try {
		rmSync(scratchDir, { recursive: true, force: true });
	} catch (err) {
		console.log(`\nnote: could not remove scratch dir ${scratchDir}: ${err.message}`);
	}
}

function main(flags) {
	const workspaces = publishableWorkspaces(rootDir);
	console.log(`smoke-published-install: ${workspaces.length} publishable workspace(s): ${workspaces.map((w) => w.manifest.name).join(', ')}`);

	if (flags.skipBuild) {
		if (!reportStaleBuilds(workspaces)) {
			return 1;
		}
	} else {
		// `pack` does not build. Without this the tarballs carry a stale (or absent) dist.
		run('yarn', ['build'], rootDir);
	}

	const scratchDir = mkdtempSync(join(tmpdir(), 'sereus-published-smoke-'));
	const tarballDir = join(scratchDir, 'tarballs');
	const projectDir = join(scratchDir, 'project');
	mkdirSync(tarballDir);
	mkdirSync(projectDir);
	console.log(`scratch root: ${scratchDir}`);

	let ok = false;
	try {
		for (const { manifest, tarballName } of workspaces) {
			run('yarn', ['workspace', manifest.name, 'pack', '--out', join(tarballDir, tarballName)], rootDir, { quiet: true });
		}
		console.log(`\npacked: ${readdirSync(tarballDir).join(', ')}`);

		const dependencies = writeScratchProject(join(scriptDir, 'lib', 'published-smoke-scenario.mjs'), projectDir, workspaces, tarballDir);
		console.log('\nscratch project dependencies:');
		for (const [name, range] of Object.entries(dependencies)) {
			console.log(`  ${name.padEnd(42)} ${range}`);
		}

		run('npm', ['install', '--no-audit', '--no-fund'], projectDir);

		// Printed before any case runs, so it survives a crash in the scenario.
		reportResolved(projectDir, workspaces);
		if (!reportProvenance(projectDir, workspaces)) {
			return 1;
		}

		console.log('\n=== cadre-of-one control-DB scenario, against the installed packages ===');
		const scenario = spawnSync(process.execPath, ['scenario.mjs'], { cwd: projectDir, stdio: 'inherit' });
		if (scenario.error) {
			throw new Error(`could not run the scenario: ${scenario.error.message}`);
		}
		if (scenario.status !== 0) {
			console.error(`\nsmoke-published-install: FAILED — the scenario exited with code ${scenario.status}.`);
			return 1;
		}
		ok = true;
		console.log('\nsmoke-published-install: PASSED — the packed tarballs install and run from a clean project.');
		return 0;
	} finally {
		cleanup(scratchDir, ok, flags.keep);
	}
}

let exitCode;
try {
	exitCode = main(parseFlags(process.argv.slice(2)));
} catch (err) {
	console.error(`\nsmoke-published-install: FAILED — ${err.message}`);
	exitCode = 1;
}
process.exit(exitCode);
