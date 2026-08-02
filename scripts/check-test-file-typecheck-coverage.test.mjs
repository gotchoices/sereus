import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-test-file-typecheck-coverage.mjs');

// NOTE: every case spawns the gate, which boots Vitest — roughly half a second each, so the suite
// costs ~0.5 s per test and nothing else. Fine at this size; if it ever grows past a minute, share
// one fixture root across the cases that only differ in their allowlist.

/**
 * `packages` maps a package directory name to its files; `rootFiles` writes files at the fixture
 * root (used for the allowlist, and for a `test-harness/` sibling above `packages/` that mirrors the
 * real `integration-tests` case of collecting a spec from outside its own package).
 */
function makeFixture(packages, rootFiles = {}) {
	const root = mkdtempSync(join(tmpdir(), 'test-file-typecheck-coverage-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }));
	mkdirSync(join(root, 'packages'), { recursive: true });
	const write = (base, files) => {
		for (const [relPath, content] of Object.entries(files)) {
			const filePath = join(base, relPath);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, content);
		}
	};
	write(root, rootFiles);
	for (const [name, files] of Object.entries(packages)) {
		const dir = join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		write(dir, files);
	}
	return root;
}

function run(root) {
	try {
		return spawnSync(process.execPath, [scriptPath], {
			env: { ...process.env, TEST_FILE_TYPECHECK_COVERAGE_CHECK_ROOT: root },
			encoding: 'utf8',
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// Fixture vitest configs must be import-free plain objects: a tmpdir workspace has no node_modules,
// so `import { defineConfig } from 'vitest/config'` would not resolve there.
const vitestConfig = (testConfig) => `export default ${JSON.stringify({ test: testConfig })};\n`;
const SRC_FILE = 'export const x = 1;\n';
const SPEC_FILE = 'export const spec = 1;\n';
const TYPECHECK_SCRIPT = 'tsc -p tsconfig.typecheck.json --noEmit';
const allowlist = (entries) => JSON.stringify(entries, null, 2);

test('package whose collected test files are all inside its type-check program passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /every test file Vitest collects is inside its package's type-check program \(1 files across 1 packages; 0 allowlisted\)/);
});

test('test directory excluded from the type-check program is caught (the headline regression)', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			// Exactly what cadre-provider did to get past a batch of test type errors.
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'], exclude: ['src/**/__tests__/**'] }),
			'src/index.ts': SRC_FILE,
			'src/__tests__/a.test.ts': SPEC_FILE,
			'src/__tests__/b.test.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['src/**/__tests__/**/*.test.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pkg-a/);
	assert.match(result.stderr, /2 of 2 collected test\/setup file\(s\) are not in the type-check program/);
	assert.match(result.stderr, /src\/__tests__\/a\.test\.ts/);
	assert.match(result.stderr, /1 package\(s\) run test files that are never type-checked/);
});

test('a whole-directory exclusion lists at most ten files and says how many more there are', () => {
	const specs = Object.fromEntries(
		Array.from({ length: 12 }, (_unused, index) => [`test/spec-${String(index).padStart(2, '0')}.spec.ts`, SPEC_FILE]),
	);
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			...specs,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /12 of 12 collected test\/setup file\(s\)/);
	assert.match(result.stderr, /test\/spec-09\.spec\.ts/);
	assert.doesNotMatch(result.stderr, /test\/spec-10\.spec\.ts/);
	assert.match(result.stderr, /… and 2 more/);
});

test('typecheck repointed at a build config that omits test/ is caught', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.build.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not in the type-check program/);
	assert.match(result.stderr, /tsconfig\.build\.json/);
});

test('package whose vitest config collects zero files passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\(0 files across 1 packages/);
});

test('package with no vitest config at all is not checked or mentioned', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /pkg-a/);
	assert.match(result.stdout, /\(0 files across 0 packages/);
});

test('a file collected by only one of several vitest `projects` is still checked', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			// `test/e2e` is deliberately outside the program; only the e2e project collects it.
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'], exclude: ['test/e2e/**'] }),
			'src/index.ts': SRC_FILE,
			'test/unit.spec.ts': SPEC_FILE,
			'test/e2e/net.e2e.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({
				projects: [
					{ test: { name: 'unit', include: ['test/**/*.spec.ts'], exclude: ['test/e2e/**'] } },
					{ test: { name: 'e2e', include: ['test/e2e/**/*.spec.ts'] } },
				],
			}),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /1 of 2 collected test\/setup file\(s\)/);
	assert.match(result.stderr, /test\/e2e\/net\.e2e\.spec\.ts/);
});

test('setupFiles and globalSetup outside the program are caught alongside specs', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test/*.spec.ts', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'test/setup.ts': SRC_FILE,
			'test/global-setup.ts': 'export default function setup() {}\n',
			'vitest.config.ts': vitestConfig({
				include: ['test/**/*.spec.ts'],
				setupFiles: ['test/setup.ts'],
				globalSetup: ['./test/global-setup.ts'],
			}),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /2 of 3 collected test\/setup file\(s\)/);
	assert.match(result.stderr, /test\/setup\.ts/);
	assert.match(result.stderr, /test\/global-setup\.ts/);
});

test('a spec collected from outside the package passes when the program includes it', () => {
	const root = makeFixture(
		{
			'pkg-a': {
				'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
				'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
				'tsconfig.typecheck.json': JSON.stringify({
					extends: './tsconfig.json',
					compilerOptions: { rootDir: '../..' },
					include: ['src', 'test', 'vitest.config.ts', '../../test-harness/**/*.ts'],
				}),
				'src/index.ts': SRC_FILE,
				'test/a.spec.ts': SPEC_FILE,
				// Mirrors integration-tests reaching up into the shared test-harness/ tree.
				'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts', '../../test-harness/**/*.spec.ts'] }),
			},
		},
		{ 'test-harness/build-freshness.spec.ts': SPEC_FILE },
	);
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /\(2 files across 1 packages/);
});

test('a spec collected from outside the package fails when the program omits it', () => {
	const root = makeFixture(
		{
			'pkg-a': {
				'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
				'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
				'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'] }),
				'src/index.ts': SRC_FILE,
				'test/a.spec.ts': SPEC_FILE,
				'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts', '../../test-harness/**/*.spec.ts'] }),
			},
		},
		{ 'test-harness/build-freshness.spec.ts': SPEC_FILE },
	);
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /\.\.\/\.\.\/test-harness\/build-freshness\.spec\.ts/);
});

test('a vitest config that throws on load fails with the package named, not an unhandled rejection', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': 'throw new Error("boom-config");\n',
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pkg-a/);
	assert.match(result.stderr, /Vitest could not collect its test files/);
	assert.match(result.stderr, /boom-config/);
});

test('vitest.config.mts is handled the same as vitest.config.ts', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.mts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.mts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /test\/a\.spec\.ts/);
});

test('with two -p flags, coverage by the second program passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit && tsc -p ui/tsconfig.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'ui/tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['../test'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test('with two -p flags, coverage by neither fails', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit && tsc -p ui/tsconfig.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'ui/tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['./src'] }),
			'ui/src/app.ts': SRC_FILE,
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /test\/a\.spec\.ts/);
	assert.match(result.stderr, /ui\/tsconfig\.json/);
});

test('bare `tsc --noEmit` with no -p flag defaults to ./tsconfig.json', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src', 'test', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

test('package with a vitest config but no tsc-based typecheck script fails', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { test: 'vitest run' } }),
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no tsc-based `typecheck` script/);
});

test('typecheck script pointing at a missing tsconfig fails with a readable reason', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /missing config/);
});

test('a package with an unreadable package.json is named, not left to abort the sweep', () => {
	const root = makeFixture({
		'pkg-broken': {
			'package.json': '{ not json',
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'test/a.spec.ts': SPEC_FILE,
			'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pkg-broken/);
	assert.match(result.stderr, /package\.json could not be read/);
	// The sweep still reached the healthy package rather than dying on the broken one.
	assert.doesNotMatch(result.stderr, /at JSON\.parse/);
	assert.match(result.stderr, /1 package\(s\) run test files that are never type-checked/);
});

test('no packages directory at all is treated as nothing to check', () => {
	const root = mkdtempSync(join(tmpdir(), 'test-file-typecheck-coverage-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root' }));
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
});

// --- allowlist ---------------------------------------------------------------------------------

const ORPHAN_PACKAGE = {
	'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: TYPECHECK_SCRIPT } }),
	'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
	'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
	'src/index.ts': SRC_FILE,
	'test/a.spec.ts': SPEC_FILE,
	'vitest.config.ts': vitestConfig({ include: ['test/**/*.spec.ts'] }),
};

const COVERED_PACKAGE = {
	...ORPHAN_PACKAGE,
	'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'test', 'vitest.config.ts'] }),
};

test('an allowlisted orphan passes and is reported in the success line', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-a': { reason: 'deprecated package, tests bit-rotted against upstream types', files: ['test/a.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 allowlisted/);
});

test('an allowlisted file that is now inside the program fails as a stale entry', () => {
	const root = makeFixture({ 'pkg-a': COVERED_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-a': { reason: 'deprecated package, tests bit-rotted against upstream types', files: ['test/a.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /stale allowlist entry: pkg-a test\/a\.spec\.ts is now inside the type-check program — delete the entry/);
});

test('an allowlisted file Vitest no longer collects fails as a stale entry', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-a': { reason: 'deprecated package, tests bit-rotted against upstream types', files: ['test/a.spec.ts', 'test/renamed.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /stale allowlist entry: pkg-a test\/renamed\.spec\.ts is no longer collected by Vitest/);
});

test('an allowlist entry naming a package that is not a Vitest workspace fails', () => {
	const root = makeFixture({ 'pkg-a': COVERED_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-gone': { reason: 'stale', files: ['test/a.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pkg-gone is not a workspace package with a Vitest config/);
});

test('an allowlist entry with a blank reason fails', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-a': { reason: '   ', files: ['test/a.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /needs a non-empty `reason`/);
});

test('an allowlist entry with no files array fails', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({ 'pkg-a': { reason: 'deprecated' } }),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /needs a non-empty `files` array/);
});

test('an allowlist entry with an empty files array fails', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({ 'pkg-a': { reason: 'deprecated', files: [] } }),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /needs a non-empty `files` array/);
});

test('an allowlist entry with an absolute or escaping path fails', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': allowlist({
			'pkg-a': { reason: 'deprecated', files: ['../../elsewhere/a.spec.ts'] },
		}),
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /must be a package-relative path that does not escape the package/);
});

test('a malformed allowlist file fails with a readable parse error', () => {
	const root = makeFixture({ 'pkg-a': COVERED_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': '{ not json',
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /scripts\/test-typecheck-allowlist\.json is not readable JSON/);
	assert.doesNotMatch(result.stderr, /at Object\./);
});

test('an allowlist file that is a JSON array rather than an object fails', () => {
	const root = makeFixture({ 'pkg-a': COVERED_PACKAGE }, {
		'scripts/test-typecheck-allowlist.json': '["pkg-a"]',
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /must be a JSON object keyed by package name/);
});

test('no allowlist file at all is treated as an empty allowlist', () => {
	const root = makeFixture({ 'pkg-a': ORPHAN_PACKAGE });
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /test\/a\.spec\.ts/);
	assert.doesNotMatch(result.stderr, /allowlist problem/);
});
