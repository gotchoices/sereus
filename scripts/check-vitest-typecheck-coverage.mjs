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
 *
 * The sibling gate `scripts/check-test-file-typecheck-coverage.mjs` enforces the level out from
 * here: the *test files* this config makes Vitest run are also inside a `tsc` program. Shared
 * mechanics (workspace discovery, `-p` scraping, program resolution) live in
 * `scripts/lib/typecheck-programs.mjs`.
 */
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	readJson,
	normalizePath,
	vitestConfigPaths,
	workspacePackageDirs,
	tsconfigPathsForTypecheckScript,
	resolvedProgramFiles,
} from './lib/typecheck-programs.mjs';

// VITEST_TYPECHECK_COVERAGE_CHECK_ROOT lets check-vitest-typecheck-coverage.test.mjs point the
// gate at a fixture workspace instead of this repo, without copying the script around.
const rootDir = process.env.VITEST_TYPECHECK_COVERAGE_CHECK_ROOT
	? process.env.VITEST_TYPECHECK_COVERAGE_CHECK_ROOT
	: join(dirname(fileURLToPath(import.meta.url)), '..');

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
	const uncovered = configPaths.filter((path) => !programs.some((files) => files.has(normalizePath(path))));
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
