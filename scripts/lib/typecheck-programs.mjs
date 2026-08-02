/**
 * Shared helpers for the two type-check coverage gates:
 *
 *   - `scripts/check-vitest-typecheck-coverage.mjs` — is each package's `vitest.config.ts` itself
 *     inside a `tsc` program?
 *   - `scripts/check-test-file-typecheck-coverage.mjs` — are the test files that config makes Vitest
 *     run inside a `tsc` program?
 *
 * Pure helpers only: no top-level side effects, no `process.exit`, no logging — either gate imports
 * this without inheriting the other's failure semantics.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const parseConfigHost = {
	...ts.sys,
	onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
		throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
	},
};

export function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

// Both gates compare paths that arrive from two different producers: TypeScript hands back
// platform-separated paths, Vitest hands back forward-slashed ones (`C:/projects/...` on Windows),
// and the two can even disagree on drive-letter case. Every path on either side of a comparison goes
// through here first, so none of that leaks into the comparison.
export function normalizePath(path) {
	const resolved = resolve(path);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Vitest resolves any of these; a package that renames its config to `.mts` must not slip past the
// gate just because the filename changed.
const VITEST_CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts'];

export function vitestConfigPaths(packageDir) {
	return VITEST_CONFIG_NAMES.map((name) => join(packageDir, name)).filter((path) => existsSync(path));
}

// NOTE: mirrors the root package.json `workspaces` field (`packages/*`). If workspaces ever grow a
// second root (e.g. `apps/*`), teach this function about it or those packages go unchecked silently.
export function workspacePackageDirs(root) {
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
// assuming a fixed filename) is what lets the gates catch "someone repoints typecheck at
// tsconfig.build.json", not just "the file forgot vitest.config.ts".
// NOTE: flag scraping, not shell parsing — every package invokes plain `tsc` today. If a package
// ever type-checks through a wrapper (`node tools/typecheck.mjs`) the `tsc` sniff in the callers
// still accepts it and this falls back to `./tsconfig.json`, which may be the wrong program.
const PROJECT_FLAG = /(?:^|\s)(?:-p|--project)[\s=]+(\S+)/g;

export function tsconfigPathsForTypecheckScript(packageDir, script) {
	const explicit = [...script.matchAll(PROJECT_FLAG)].map((match) => join(packageDir, match[1]));
	return explicit.length > 0 ? explicit : [join(packageDir, 'tsconfig.json')];
}

// Asks TypeScript itself which files a tsconfig's program resolves to (following `extends` and
// expanding `include`/`exclude`), rather than pattern-matching the `include` array: `include` can
// reach a file by directory, by glob, or not at all, and only the resolved file list settles it.
export function resolvedProgramFiles(tsconfigPath) {
	const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, parseConfigHost);
	if (!parsed) {
		throw new Error(`unable to parse ${tsconfigPath}`);
	}
	const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
	if (errors.length > 0) {
		throw new Error(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
	}
	return new Set(parsed.fileNames.map(normalizePath));
}
