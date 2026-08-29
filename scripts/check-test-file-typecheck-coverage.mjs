#!/usr/bin/env node
/**
 * Gate: every test file Vitest actually collects — plus every `setupFiles` / `globalSetup` module it
 * executes alongside them — must be inside the TypeScript program its package's `typecheck` script
 * compiles. Vitest strips types and runs; it never type-checks the files it executes, so a test file
 * only has type safety if some `tsc` program happens to include it. Nothing enforced that, and it
 * bit once: `cadre-provider` excluded its own test directory from `tsconfig.typecheck.json` to get
 * past a batch of errors and no follow-up was filed, while a hand-maintained doc simultaneously claimed
 * packages were covered that weren't and uncovered that were. See
 * tickets/complete/debt-guard-test-files-typechecked.md and docs/testing.md "Type-check coverage".
 *
 * The sibling gate `scripts/check-vitest-typecheck-coverage.mjs` enforces the level in from here
 * (each `vitest.config.ts` is itself type-checked). Shared mechanics live in
 * `scripts/lib/typecheck-programs.mjs`.
 *
 * The collected-file list comes from Vitest itself (`createVitest` + `globTestSpecifications()`),
 * not from re-implementing its globbing: several packages use nested `projects:` with per-project
 * `include`/`exclude`, and `integration-tests` collects a spec from outside its own package
 * (`../../test-harness/`). Globbing resolves the config without importing or running any test file.
 */
import { existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';
import {
	readJson,
	normalizePath,
	vitestConfigPaths,
	workspacePackageDirs,
	tsconfigPathsForTypecheckScript,
	resolvedProgramFiles,
} from './lib/typecheck-programs.mjs';

// TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT lets check-test-file-typecheck-coverage.test.mjs point the
// gate at a fixture workspace instead of this repo, without copying the script around. The allowlist
// is read relative to that root too, so a fixture can supply its own.
const rootDir = process.env.TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT
	? process.env.TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT
	: join(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWLIST_NAME = 'scripts/test-typecheck-allowlist.json';
const MAX_LISTED_FILES = 10;
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function toPosix(path) {
	return path.replace(/\\/g, '/');
}

function displayPath(path) {
	return toPosix(relative(rootDir, path));
}

// NOTE: only files with a TypeScript extension are checked. A `.js` test file cannot be inside a
// `tsc` program unless its config sets `allowJs` (none here does) and the repo has zero JS test
// files today, so such a file passes this gate unchecked rather than failing it unfixably.
// NOTE: `.svelte` is deliberately a non-issue here — every Vitest `include` in the repo targets
// `*.ts`, so no `.svelte` file is ever collected. Svelte type-check coverage is a separate,
// already-recorded gap (docs/testing.md → "Known coverage gaps").
function isTypeScriptFile(path) {
	const lower = toPosix(path).toLowerCase();
	return TS_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// NOTE: a collected module that resolves inside node_modules (a `globalSetup` re-exported by a
// dependency, say) is not this repo's code to type-check — skip it instead of reporting an orphan
// nobody here can fix.
function isInsideNodeModules(path) {
	return toPosix(path).toLowerCase().includes('/node_modules/');
}

// Vitest resolves the config (including `extends`, plugins and nested `projects:`) and globs the
// matching files without importing or executing any of them — `globalSetup` does not run here.
async function collectRunFiles(packageDir) {
	// Isolated `cacheDir` for the reason spelled out in `check-stale-build-guard-wiring.mjs`: a gate
	// boots Vitest in a different mode and config from a real run, so it should not share the
	// package's dependency-optimizer cache. Hygiene, not a fix for an observed failure — see the
	// honesty note at that site.
	const vitest = await createVitest('test', {
		root: packageDir,
		watch: false,
		cacheDir: join(tmpdir(), `test-file-typecheck-coverage-cache-${basename(packageDir)}`),
	});
	try {
		const files = (await vitest.globTestSpecifications()).map((specification) => specification.moduleId);
		// Setup and global-setup modules are executed by Vitest exactly like specs are, and are
		// type-checked exactly as much as specs are: not at all. Same gate applies.
		for (const project of vitest.projects) {
			files.push(...(project.config.setupFiles ?? []), ...(project.config.globalSetup ?? []));
		}
		return [...new Set(files)];
	} finally {
		await vitest.close();
	}
}

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

function readManifest(packageDir) {
	const manifest = readJson(join(packageDir, 'package.json'));
	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
		throw new Error('package.json is not a JSON object');
	}
	return manifest;
}

/**
 * Resolves one package into `{ collected, orphans }`, or an `error` string when the package cannot
 * be resolved at all (unreadable manifest, broken Vitest config, no `tsc` typecheck script, missing
 * tsconfig). Never throws: one broken package must report as that package's failure, not abort the
 * sweep — so the manifest read is inside the guard too, not ahead of it.
 */
async function gatherPackage(packageDir) {
	const record = {
		packageName: displayPath(packageDir),
		packageDir,
		typecheckScript: '',
		tsconfigPaths: [],
		collected: [],
		collectedAbs: new Set(),
		orphans: [],
		orphanAbs: new Set(),
		error: null,
	};

	try {
		const manifest = readManifest(packageDir);
		record.packageName = typeof manifest.name === 'string' ? manifest.name : record.packageName;
		record.typecheckScript = typeof manifest.scripts?.typecheck === 'string' ? manifest.scripts.typecheck : '';
	} catch (error) {
		record.error = `package.json could not be read: ${describeError(error)}`;
		return record;
	}

	try {
		record.collected = (await collectRunFiles(packageDir))
			.filter((file) => isTypeScriptFile(file) && !isInsideNodeModules(file))
			.map((file) => ({ abs: normalizePath(file), rel: toPosix(relative(packageDir, file)) }))
			.sort((a, b) => a.rel.localeCompare(b.rel));
		record.collectedAbs = new Set(record.collected.map((file) => file.abs));
	} catch (error) {
		record.error = `Vitest could not collect its test files: ${describeError(error)}`;
		return record;
	}

	if (!record.typecheckScript.includes('tsc')) {
		record.error = `has a Vitest config but no tsc-based \`typecheck\` script, so its ${record.collected.length} collected test/setup file(s) are never type-checked`;
		return record;
	}

	record.tsconfigPaths = tsconfigPathsForTypecheckScript(packageDir, record.typecheckScript);
	const missingConfigs = record.tsconfigPaths.filter((tsconfigPath) => !existsSync(tsconfigPath));
	if (missingConfigs.length > 0) {
		record.error = `typecheck script "${record.typecheckScript}" points at missing config(s): ${missingConfigs.map(displayPath).join(', ')}`;
		return record;
	}

	try {
		// A file covered by any one of the package's typecheck programs is covered — `cadre-host`
		// really does run two passes (its package config plus `ui/tsconfig.json`).
		const programs = record.tsconfigPaths.map((tsconfigPath) => resolvedProgramFiles(tsconfigPath));
		record.orphans = record.collected.filter((file) => !programs.some((programFiles) => programFiles.has(file.abs)));
		record.orphanAbs = new Set(record.orphans.map((file) => file.abs));
	} catch (error) {
		record.error = `could not resolve the type-check program(s) ${record.tsconfigPaths.map(displayPath).join(', ')}: ${describeError(error)}`;
	}
	return record;
}

function readAllowlist() {
	const allowlistPath = join(rootDir, ALLOWLIST_NAME);
	if (!existsSync(allowlistPath)) {
		return { allowlist: {}, error: null };
	}
	let parsed;
	try {
		parsed = readJson(allowlistPath);
	} catch (error) {
		return { allowlist: {}, error: `${ALLOWLIST_NAME} is not readable JSON: ${describeError(error)}` };
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { allowlist: {}, error: `${ALLOWLIST_NAME} must be a JSON object keyed by package name` };
	}
	return { allowlist: parsed, error: null };
}

function allowlistedFilesFor(allowlist, packageName) {
	const entry = allowlist[packageName];
	if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.files)) {
		return [];
	}
	return entry.files.filter((file) => typeof file === 'string' && file.trim() !== '');
}

/**
 * The allowlist is validated, not merely consulted. A silently-stale exemption is exactly how the
 * written record drifted from reality last time, so a package that gets fixed must fail this gate
 * until its justification is deleted.
 */
function validateAllowlist(allowlist, records) {
	const problems = [];
	const byName = new Map(records.map((record) => [record.packageName, record]));

	for (const [packageName, entry] of Object.entries(allowlist)) {
		const record = byName.get(packageName);
		if (!record) {
			problems.push(`stale allowlist entry: ${packageName} is not a workspace package with a Vitest config — delete the entry`);
			continue;
		}
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			problems.push(`invalid allowlist entry: ${packageName} must be an object with \`reason\` and \`files\``);
			continue;
		}
		if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
			problems.push(`invalid allowlist entry: ${packageName} needs a non-empty \`reason\` recording why these files cannot be type-checked`);
		}
		if (!Array.isArray(entry.files) || entry.files.length === 0) {
			problems.push(`invalid allowlist entry: ${packageName} needs a non-empty \`files\` array of package-relative paths`);
			continue;
		}
		for (const file of entry.files) {
			if (typeof file !== 'string' || file.trim() === '') {
				problems.push(`invalid allowlist entry: ${packageName} \`files\` must contain non-empty package-relative path strings`);
				continue;
			}
			if (isAbsolute(file) || toPosix(file).split('/').includes('..')) {
				problems.push(`invalid allowlist entry: ${packageName} ${file} must be a package-relative path that does not escape the package`);
				continue;
			}
			if (record.error) {
				// The package failed to resolve, so neither staleness direction is knowable — it is
				// already reported as its own failure.
				continue;
			}
			const abs = normalizePath(join(record.packageDir, file));
			if (!record.collectedAbs.has(abs)) {
				problems.push(`stale allowlist entry: ${packageName} ${file} is no longer collected by Vitest — delete the entry`);
			} else if (!record.orphanAbs.has(abs)) {
				problems.push(`stale allowlist entry: ${packageName} ${file} is now inside the type-check program — delete the entry`);
			}
		}
	}
	return problems;
}

function printFileList(files) {
	for (const file of files.slice(0, MAX_LISTED_FILES)) {
		console.error(`      ${file}`);
	}
	if (files.length > MAX_LISTED_FILES) {
		console.error(`      … and ${files.length - MAX_LISTED_FILES} more`);
	}
}

async function main() {
	const records = [];
	for (const packageDir of workspacePackageDirs(rootDir)) {
		if (vitestConfigPaths(packageDir).length === 0) {
			continue;
		}
		records.push(await gatherPackage(packageDir));
	}

	const { allowlist, error: allowlistError } = readAllowlist();
	const allowlistProblems = allowlistError ? [allowlistError] : validateAllowlist(allowlist, records);

	const failures = [];
	let allowlistedCount = 0;
	let collectedCount = 0;
	for (const record of records) {
		collectedCount += record.collected.length;
		if (record.error) {
			failures.push({ record, reason: record.error, files: [] });
			continue;
		}
		const allowlisted = new Set(
			allowlistedFilesFor(allowlist, record.packageName).map((file) => normalizePath(join(record.packageDir, file))),
		);
		const reported = record.orphans.filter((file) => !allowlisted.has(file.abs));
		allowlistedCount += record.orphans.length - reported.length;
		if (reported.length > 0) {
			failures.push({
				record,
				reason: `${reported.length} of ${record.collected.length} collected test/setup file(s) are not in the type-check program resolved from ${record.tsconfigPaths.map(displayPath).join(', ')} (typecheck script: "${record.typecheckScript}"):`,
				files: reported.map((file) => file.rel),
			});
		}
	}

	if (failures.length === 0 && allowlistProblems.length === 0) {
		console.log(`check-test-file-typecheck-coverage: every test file Vitest collects is inside its package's type-check program (${collectedCount} files across ${records.length} packages; ${allowlistedCount} allowlisted).`);
		return 0;
	}

	if (failures.length > 0) {
		console.error('check-test-file-typecheck-coverage: test files Vitest runs that `tsc` never checks:\n');
		for (const failure of failures) {
			console.error(`  ${failure.record.packageName} (${displayPath(failure.record.packageDir)})`);
			console.error(`    ${failure.reason}`);
			printFileList(failure.files);
			console.error('');
		}
		console.error(`${failures.length} package(s) run test files that are never type-checked.`);
	}

	if (allowlistProblems.length > 0) {
		console.error(`\ncheck-test-file-typecheck-coverage: problems in ${ALLOWLIST_NAME}:\n`);
		for (const problem of allowlistProblems) {
			console.error(`  ${problem}`);
		}
		console.error(`\n${allowlistProblems.length} allowlist problem(s).`);
	}
	return 1;
}

// `process.exit` rather than `process.exitCode`: Vitest is heavy enough that a stray handle would
// hang the gate, and every instance has already been closed by here.
// NOTE: stdout/stderr writes are asynchronous for pipes on macOS (synchronous on Linux and Windows),
// so a very long failure list piped to another process could in principle be truncated by the exit.
// Fine today — the list is capped at ten files per package. If the cap ever grows, await a drain
// instead of exiting straight away.
process.exit(await main());
