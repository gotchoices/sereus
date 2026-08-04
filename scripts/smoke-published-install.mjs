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
 * Flags: `--skip-build` (reuse existing `dist/`), `--keep` (keep the scratch dir even
 * on success).
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(scriptDir, '..');

const args = new Set(process.argv.slice(2));
const skipBuild = args.has('--skip-build');
const keepScratch = args.has('--keep');

/**
 * Packages whose resolved version is worth printing on top of the `@serfab/*`,
 * `@optimystic/*` and `@quereus/*` set derived from the manifests. `libp2p` is the
 * transport core; `@libp2p/websockets` is what the scenario itself constructs.
 */
const EXTRA_REPORTED = ['libp2p', '@libp2p/websockets'];

/** The scratch project imports these directly, so it must declare them itself. */
const SCENARIO_DIRECT_DEPS = ['@optimystic/db-p2p', '@libp2p/websockets'];

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * `.cmd` shims (yarn, npm on Windows) cannot be spawned without a shell on modern
 * node, so shell out there and quote anything with whitespace. `stdio: 'inherit'`
 * streams as it goes — a silent redirect would let an agent runner's idle timer expire.
 */
function run(command, commandArgs, cwd) {
	const useShell = process.platform === 'win32';
	const finalArgs = useShell
		? commandArgs.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg))
		: commandArgs;
	console.log(`\n$ ${command} ${commandArgs.join(' ')}   (in ${cwd})`);
	const result = spawnSync(command, finalArgs, { cwd, stdio: 'inherit', shell: useShell });
	if (result.error) {
		throw new Error(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${commandArgs.join(' ')} exited with code ${result.status}`);
	}
}

/**
 * The publishable set is whatever the root `pub:*` scripts publish — one source of
 * truth, so a new publishable package is covered the moment it gets a `pub:` script.
 */
function publishableWorkspaces() {
	const scripts = readJson(join(rootDir, 'package.json')).scripts ?? {};
	const workspaces = [];
	for (const [name, body] of Object.entries(scripts)) {
		if (!name.startsWith('pub:')) {
			continue;
		}
		const match = /publish-package\.js\s+(\S+)/.exec(body);
		if (!match) {
			throw new Error(`root script "${name}" does not name a package directory: ${body}`);
		}
		const dir = join(rootDir, 'packages', match[1]);
		const manifest = readJson(join(dir, 'package.json'));
		workspaces.push({ dir, manifest, tarballName: `${manifest.name.replace('@', '').replace('/', '-')}.tgz` });
	}
	if (workspaces.length === 0) {
		throw new Error('no `pub:*` scripts found in the root package.json — nothing to pack');
	}
	return workspaces;
}

/**
 * The declared range for a package the scratch project must depend on directly.
 * Read off the in-repo manifests: `pack` only rewrites `workspace:` protocol ranges,
 * so for a registry dependency the packed manifest carries this exact string.
 */
function declaredRange(workspaces, depName) {
	for (const { manifest } of workspaces) {
		const range = manifest.dependencies?.[depName];
		if (range) {
			return range;
		}
	}
	throw new Error(`no publishable workspace declares "${depName}" — the scratch project cannot pin it`);
}

/** Every `@serfab/*`, `@optimystic/*` and `@quereus/*` name the publishable set depends on. */
function reportedPackages(workspaces) {
	const names = new Set(EXTRA_REPORTED);
	for (const { manifest } of workspaces) {
		names.add(manifest.name);
		for (const depName of Object.keys(manifest.dependencies ?? {})) {
			if (depName.startsWith('@serfab/') || depName.startsWith('@optimystic/') || depName.startsWith('@quereus/')) {
				names.add(depName);
			}
		}
	}
	return [...names].sort();
}

/**
 * Locate `spec` as node would from `fromDir`: walk up checking `node_modules/<spec>`.
 * Resolving from the *consumer's* directory rather than the project root is the whole
 * point — a naive lookup at the root once reported `@quereus/quereus` 0.16.4 while
 * `@serfab/cadre-core` was loading a nested 4.6.0 one level down.
 *
 * A directory walk rather than `createRequire().resolve` because several of these
 * packages are ESM-only with no `require` export condition, and `@quereus/quereus`
 * does not export `./package.json` at all — both make `require.resolve` throw on
 * packages that are installed and working.
 */
function findPackageDir(fromDir, spec) {
	let dir = fromDir;
	for (;;) {
		const candidate = join(dir, 'node_modules', ...spec.split('/'));
		if (existsSync(join(candidate, 'package.json'))) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
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
	const baseline = new Map();
	for (const name of reportedPackages(workspaces)) {
		const dir = findPackageDir(projectDir, name);
		if (!dir) {
			console.log(`    ${name.padEnd(42)} (not installed)`);
			continue;
		}
		const version = readJson(join(dir, 'package.json')).version;
		baseline.set(name, dir);
		console.log(`    ${name.padEnd(42)} ${String(version).padEnd(12)} ${relative(projectDir, dir)}`);
	}

	// Every dependency, not only the reported ones: a nested duplicate of anything is
	// worth seeing, and npm only nests where it could not hoist.
	const hoisted = (name) => {
		if (!baseline.has(name)) {
			baseline.set(name, findPackageDir(projectDir, name));
		}
		return baseline.get(name);
	};

	console.log('\n  nested copies (a package resolving something other than the hoisted one):');
	let nested = 0;
	for (const { manifest } of workspaces) {
		const consumerDir = findPackageDir(projectDir, manifest.name);
		if (!consumerDir) {
			continue;
		}
		for (const depName of Object.keys(manifest.dependencies ?? {})) {
			const dir = findPackageDir(consumerDir, depName);
			if (!dir || dir === hoisted(depName)) {
				continue;
			}
			nested += 1;
			const version = readJson(join(dir, 'package.json')).version;
			console.log(`    ${manifest.name} → ${depName} ${version}  at ${relative(projectDir, dir)}`);
		}
	}
	if (nested === 0) {
		console.log('    none — every package resolves the same copy the project root does.');
	}
}

/**
 * Fail loudly if npm satisfied one of our own packages from the registry instead of
 * from the tarball just packed. The versions would look identical in the report above,
 * so without this check the smoke could silently test the *last* release rather than
 * this build.
 */
function assertOurPackagesCameFromTarballs(projectDir, workspaces) {
	const lockPath = join(projectDir, 'package-lock.json');
	if (!existsSync(lockPath)) {
		console.log('\nnote: no package-lock.json written; cannot confirm the tarballs were used.');
		return true;
	}
	const lock = readJson(lockPath);
	const entries = lock.packages ?? {};
	const wrong = [];
	for (const { manifest, tarballName } of workspaces) {
		const entry = entries[`node_modules/${manifest.name}`];
		const resolved = entry?.resolved ?? '(absent from lockfile)';
		if (!resolved.includes(tarballName)) {
			wrong.push({ name: manifest.name, resolved });
		}
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

function writeScratchProject(projectDir, workspaces, tarballDir) {
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
	copyFileSync(join(scriptDir, 'lib', 'published-smoke-scenario.mjs'), join(projectDir, 'scenario.mjs'));
	return dependencies;
}

function cleanup(scratchDir, ok) {
	if (!ok || keepScratch) {
		console.log(`\nscratch project left in place: ${scratchDir}`);
		return;
	}
	try {
		rmSync(scratchDir, { recursive: true, force: true });
	} catch (err) {
		console.log(`\nnote: could not remove scratch dir ${scratchDir}: ${err.message}`);
	}
}

function main() {
	const workspaces = publishableWorkspaces();
	console.log(`smoke-published-install: ${workspaces.length} publishable workspace(s): ${workspaces.map((w) => w.manifest.name).join(', ')}`);

	if (skipBuild) {
		console.log('--skip-build: reusing whatever is already in each package\'s dist/.');
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
			run('yarn', ['workspace', manifest.name, 'pack', '--out', join(tarballDir, tarballName)], rootDir);
		}
		console.log(`\npacked: ${readdirSync(tarballDir).join(', ')}`);

		const dependencies = writeScratchProject(projectDir, workspaces, tarballDir);
		console.log('\nscratch project dependencies:');
		for (const [name, range] of Object.entries(dependencies)) {
			console.log(`  ${name.padEnd(42)} ${range}`);
		}

		run('npm', ['install', '--no-audit', '--no-fund'], projectDir);

		// Printed before any case runs, so it survives a crash in the scenario.
		reportResolved(projectDir, workspaces);
		if (!assertOurPackagesCameFromTarballs(projectDir, workspaces)) {
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
		cleanup(scratchDir, ok);
	}
}

let exitCode;
try {
	exitCode = main();
} catch (err) {
	console.error(`\nsmoke-published-install: FAILED — ${err.message}`);
	exitCode = 1;
}
process.exit(exitCode);
