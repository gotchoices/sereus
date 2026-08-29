#!/usr/bin/env node
/**
 * Gate: a package that OWNS a stale-build guard setup module must actually execute it.
 *
 * Several suites run other packages' COMPILED output, so a source edit with no following build is
 * invisible to them. `test-harness/build-freshness.ts` is the answer: a package imports it from a
 * setup module and names that module in its Vitest config's `globalSetup`, and the suite aborts
 * when a linked package's `src` is newer than its `dist`.
 *
 * Deleting that one config line switches the guard off and nothing notices. The setup file stays on
 * disk, stays type-checked, and stays imported by the package's `build-targets.spec.ts`, so no lint
 * rule and no test fails — the suite simply goes back to reporting green about code it never ran.
 * That is the exact failure the guard exists to prevent, and it previously cost three repeated
 * investigations of a bug that had been fixed but not rebuilt.
 *
 * So this gate asserts the wiring rather than the guard: every module that imports the freshness
 * harness must appear in what Vitest will actually execute for its package. It says nothing about
 * WHAT the guard compares — that is the harness's business.
 *
 * The executed list comes from Vitest itself (`createVitest` → each project's resolved
 * `globalSetup` / `setupFiles`), not from reading the config as text, so a config that computes its
 * setup list, or spreads a shared base, or defines several projects, is handled the same as a
 * literal array. `globalSetup` is where these belong and where all of them sit today;
 * `setupFiles` is accepted too because Vitest runs those as well, and a gate that failed a working
 * wiring would just get switched off.
 *
 * Sibling gates in the same family, both written after the same kind of silent drift:
 * `scripts/check-vitest-typecheck-coverage.mjs` (every `vitest.config.ts` is type-checked) and
 * `scripts/check-test-file-typecheck-coverage.mjs` (every file Vitest collects is type-checked).
 * Neither covers this direction: the second asks Vitest which setup files it executes, so a package
 * that stops executing one simply drops out of its list.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, basename, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import { normalizePath, vitestConfigPaths, workspacePackageDirs, readJson } from './lib/typecheck-programs.mjs';

// STALE_BUILD_GUARD_WIRING_CHECK_ROOT lets the companion test point the gate at a fixture
// workspace instead of this repo, without copying the script around.
const rootDir = process.env.STALE_BUILD_GUARD_WIRING_CHECK_ROOT
	? process.env.STALE_BUILD_GUARD_WIRING_CHECK_ROOT
	: join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Matches an import/re-export/dynamic-import whose SPECIFIER names the freshness harness, so a
 * file that merely mentions it in prose (several configs do, explaining why they wire it) is not
 * mistaken for one that uses it.
 */
const HARNESS_IMPORT = /(?:from|import)\s*\(?\s*['"][^'"]*build-freshness[^'"]*['"]/;

/** Config paths are written with forward slashes on every platform, so report them that way. */
function toPosix(path) {
	return path.split(sep).join('/');
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.turbo', '.yarn']);
const SOURCE_EXT = /\.(?:m|c)?[jt]sx?$/;

/** Every source file under `dir` that imports the freshness harness. */
function harnessImporters(dir) {
	const found = [];
	const walk = (current) => {
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;	// unreadable directory is not this gate's business
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(path);
				continue;
			}
			if (!SOURCE_EXT.test(entry.name)) continue;
			// A Vitest CONFIG that imports the harness is not itself a setup module — it would be
			// wiring the guard inline, which is a different (and fine) shape.
			if (/^vitest\.config\./.test(entry.name)) continue;
			if (HARNESS_IMPORT.test(readFileSync(path, 'utf-8'))) found.push(normalizePath(path));
		}
	};
	walk(dir);
	return found;
}

/**
 * What Vitest will actually execute for this package, resolved across every project it defines.
 * Matching files are neither imported nor run here — `globTestSpecifications` is deliberately not
 * called, and `globalSetup` does not execute during config resolution.
 */
async function executedSetupModules(packageDir) {
	// `cacheDir` is redirected to a throwaway directory so a GATE never writes into the dependency
	// optimizer cache a real run of that package reads. Hygiene, not a fix for anything observed: a
	// gate boots Vitest in a different mode and config from a real run, and the two sharing
	// `node_modules/.vite` is a coupling with no upside.
	//
	// HONESTY NOTE, because the first version of this comment claimed otherwise: this was written
	// while chasing whole-package collection failures (`Cannot read properties of undefined (reading
	// 'config')`), and it did NOT cause them and did not fix them. That symptom is Vitest workers
	// failing to start on a memory-saturated machine — a single spec collects fine, the same suite
	// fails once dozens of workers spawn. If you meet that error, check free memory and stray node
	// processes before suspecting anything in this repo.
	const vitest = await createVitest('test', {
		root: packageDir,
		watch: false,
		cacheDir: join(tmpdir(), `stale-build-guard-wiring-cache-${basename(packageDir)}`),
	});
	try {
		const modules = [];
		for (const project of vitest.projects) {
			modules.push(...(project.config.globalSetup ?? []), ...(project.config.setupFiles ?? []));
		}
		return modules.map((path) => normalizePath(path));
	} finally {
		await vitest.close();
	}
}

async function checkPackage(packageDir) {
	if (vitestConfigPaths(packageDir).length === 0) return [];
	const importers = harnessImporters(packageDir);
	if (importers.length === 0) return [];
	const packageName = readJson(join(packageDir, 'package.json')).name;
	const executed = new Set(await executedSetupModules(packageDir));
	return importers
		.filter((path) => !executed.has(path))
		// `normalizePath` lowercases on win32, so relate the two through it as well — mixing a
		// normalized path against a native `packageDir` yields an absolute path, not a relative one.
		.map((path) => ({ packageName, relativePath: toPosix(relative(normalizePath(packageDir), path)) }));
}

async function main() {
	const failures = [];
	for (const packageDir of workspacePackageDirs(rootDir)) {
		failures.push(...(await checkPackage(packageDir)));
	}
	if (failures.length === 0) {
		console.log('Stale-build guard wiring OK: every module importing the freshness harness is executed by its package.');
		return;
	}
	console.error('Stale-build guard is wired OFF in these packages — their suites would report green about code they never ran:\n');
	for (const { packageName, relativePath } of failures) {
		console.error(`  ${packageName}`);
		console.error(`    ${relativePath} imports the stale-build freshness harness, but Vitest does not execute it.`);
		console.error(`    Add it to that package's vitest config:  globalSetup: ['./${relativePath}'],\n`);
	}
	process.exitCode = 1;
}

await main();
