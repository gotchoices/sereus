#!/usr/bin/env node
/**
 * Gate: every workspace package that has a `vitest.config.ts` must also have that file inside
 * the TypeScript program its `typecheck` script actually compiles. Vitest never type-checks its
 * own config file, so a config that uses a setting a newer Vitest removed or renamed keeps
 * running with that setting silently ignored unless something else catches it. This happened:
 * `test.poolOptions.forks.singleFork` was removed in Vitest 4, `packages/integration-tests/vitest.config.ts`
 * kept it, and the integration suite ran its network-binding scenarios in parallel for a whole
 * major version unnoticed. The fix was pulling `vitest.config.ts` into each package's type-check
 * program (`tsconfig.typecheck.json` or the package's main `tsconfig.json`); this script guards
 * that from drifting back. See tickets/plan/16-debt-guard-vitest-config-typechecked.md and
 * docs/STATUS.md "Type-check coverage".
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// VITEST_TYPECHECK_COVERAGE_CHECK_ROOT lets check-vitest-typecheck-coverage.test.mjs point the
// gate at a fixture workspace instead of this repo, without copying the script around.
const rootDir = process.env.VITEST_TYPECHECK_COVERAGE_CHECK_ROOT
	? process.env.VITEST_TYPECHECK_COVERAGE_CHECK_ROOT
	: join(dirname(fileURLToPath(import.meta.url)), '..');

const parseConfigHost = {
	...ts.sys,
	onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
		throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
	},
};

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

// Vitest resolves any of these; a package that renames its config to `.mts` must not slip past the
// gate just because the filename changed.
const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts'];

function vitestConfigPaths(packageDir) {
	return VITEST_CONFIG_NAMES.map((name) => join(packageDir, name)).filter((path) => existsSync(path));
}

// NOTE: mirrors the root package.json `workspaces` field (`packages/*`). If workspaces ever grow a
// second root (e.g. `apps/*`), teach this function about it or those packages go unchecked silently.
function workspacePackageDirs(root) {
	const packagesDir = join(root, 'packages');
	if (!existsSync(packagesDir)) {
		return [];
	}
	return readdirSync(packagesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(packagesDir, entry.name))
		.filter((dir) => existsSync(join(dir, 'package.json')));
}

// A `typecheck` script may invoke `tsc` with one or more `-p`/`--project <config>` flags (e.g.
// `tsc -p tsconfig.typecheck.json --noEmit`), or with none at all — `tsc --noEmit` alone
// resolves `./tsconfig.json` by tsc's own default. Extracting the literal project args (rather than
// assuming a fixed filename) is what lets this catch "someone repoints typecheck at
// tsconfig.build.json", not just "the file forgot vitest.config.ts".
// NOTE: flag scraping, not shell parsing — every package invokes plain `tsc` today. If a package
// ever type-checks through a wrapper (`node tools/typecheck.mjs`) the `tsc` sniff below still
// accepts it and this falls back to `./tsconfig.json`, which may be the wrong program.
const PROJECT_FLAG = /(?:^|\s)(?:-p|--project)[\s=]+(\S+)/g;

function tsconfigPathsForTypecheckScript(packageDir, script) {
	const explicit = [...script.matchAll(PROJECT_FLAG)].map((match) => join(packageDir, match[1]));
	return explicit.length > 0 ? explicit : [join(packageDir, 'tsconfig.json')];
}

// Asks TypeScript itself which files a tsconfig's program resolves to (following `extends` and
// expanding `include`/`exclude`), rather than pattern-matching the `include` array: `include` can
// reach a file by directory, by glob, or not at all, and only the resolved file list settles it.
function resolvedProgramFiles(tsconfigPath) {
	const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, parseConfigHost);
	if (!parsed) {
		throw new Error(`unable to parse ${tsconfigPath}`);
	}
	const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	if (errors.length > 0) {
		throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
	}
	return new Set(parsed.fileNames.map((fileName) => resolve(fileName)));
}

function checkPackage(packageDir) {
	const configPaths = vitestConfigPaths(packageDir);
	if (configPaths.length === 0) {
		return null;
	}
	const manifest = readJson(join(packageDir, 'package.json'));
	const configNames = configPaths.map((path) => basename(path)).join(', ');
	const fail = (reason) => ({ packageName: manifest.name, packageDir, reason });

	const typecheckScript = manifest.scripts?.typecheck;
	if (!typecheckScript?.includes('tsc')) {
		return fail(`has ${configNames} but no tsc-based \`typecheck\` script, so it is never type-checked`);
	}

	const tsconfigPaths = tsconfigPathsForTypecheckScript(packageDir, typecheckScript);
	const missingConfigs = tsconfigPaths.filter((tsconfigPath) => !existsSync(tsconfigPath));
	if (missingConfigs.length > 0) {
		return fail(`typecheck script "${typecheckScript}" points at missing config(s): ${missingConfigs.join(', ')}`);
	}

	// A package covered by any one of its typecheck programs is covered; parse them all up front so
	// each uncovered config file can be named in one message.
	const programs = tsconfigPaths.map((tsconfigPath) => resolvedProgramFiles(tsconfigPath));
	const uncovered = configPaths.filter((path) => !programs.some((files) => files.has(resolve(path))));
	if (uncovered.length > 0) {
		return fail(`${uncovered.map((path) => basename(path)).join(', ')} is not in the type-check program resolved from ${tsconfigPaths.join(', ')} (typecheck script: "${typecheckScript}")`);
	}
	return null;
}

function main() {
	const failures = [];
	for (const packageDir of workspacePackageDirs(rootDir)) {
		try {
			const failure = checkPackage(packageDir);
			if (failure) {
				failures.push(failure);
			}
		} catch (error) {
			failures.push({ packageName: packageDir, packageDir, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	if (failures.length === 0) {
		console.log('check-vitest-typecheck-coverage: every vitest.config.ts is inside its package\'s type-check program.');
		return 0;
	}

	console.error('check-vitest-typecheck-coverage: vitest.config.ts not covered by `yarn typecheck`:\n');
	for (const failure of failures) {
		console.error(`  ${failure.packageName} (${failure.packageDir})`);
		console.error(`    ${failure.reason}`);
		console.error('');
	}
	console.error(`${failures.length} package(s) have a vitest.config.ts outside their type-check program.`);
	return 1;
}

process.exit(main());
