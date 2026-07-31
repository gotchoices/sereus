import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'check-vitest-typecheck-coverage.mjs');

function makeFixture(packages) {
	const root = mkdtempSync(join(tmpdir(), 'vitest-typecheck-coverage-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }));
	mkdirSync(join(root, 'packages'), { recursive: true });
	for (const [name, files] of Object.entries(packages)) {
		const dir = join(root, 'packages', name);
		mkdirSync(dir, { recursive: true });
		for (const [relPath, content] of Object.entries(files)) {
			const filePath = join(dir, relPath);
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, content);
		}
	}
	return root;
}

function run(root) {
	try {
		return spawnSync(process.execPath, [scriptPath], {
			env: { ...process.env, VITEST_TYPECHECK_COVERAGE_CHECK_ROOT: root },
			encoding: 'utf8',
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const VITEST_CONFIG = 'export default {};\n';
const SRC_FILE = 'export const x = 1;\n';

test('package with vitest.config.ts inside a tsconfig.typecheck.json program passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /every vitest\.config\.ts is inside/);
});

test('config file removed from the type-check program is caught (proves the guard actually catches drift)', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			// vitest.config.ts left out of `include` here — the exact regression this guard exists for.
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /pkg-a/);
	assert.match(result.stderr, /not in the type-check program/);
	assert.match(result.stderr, /1 package\(s\) have a vitest\.config\.ts outside their type-check program/);
});

test('package with no vitest.config.ts at all is not mentioned', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'src/index.ts': SRC_FILE,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
	assert.doesNotMatch(result.stdout, /pkg-a/);
});

test('typecheck script repointed at a config that omits vitest.config.ts is caught', () => {
	const root = makeFixture({
		'pkg-a': {
			// Mirrors the real regression: someone repoints `typecheck` back at the build config,
			// which deliberately does not include the vitest config.
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.build.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not in the type-check program/);
});

test('bare `tsc --noEmit` with no -p flag defaults to ./tsconfig.json', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
});

test('`-p` flag placed after other tsc args is still found', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not in the type-check program/);
});

test('glob include (e.g. **/*.ts) covering the root config file counts as covered', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc --noEmit -p tsconfig.json' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['**/*.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
});

test('vitest.config.mts is checked too (renaming the config must not bypass the gate)', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.mts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /vitest\.config\.mts is not in the type-check program/);
});

test('vitest.config.mts inside the program passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src', 'vitest.config.mts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.mts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
});

test('long-form `--project` flag is honored, not silently defaulted to ./tsconfig.json', () => {
	const root = makeFixture({
		'pkg-a': {
			// tsconfig.json *would* cover the file; the script points elsewhere, so this must fail.
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc --project tsconfig.build.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {}, include: ['src', 'vitest.config.ts'] }),
			'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not in the type-check program/);
	assert.match(result.stderr, /tsconfig\.build\.json/);
});

test('with two -p flags, coverage by either one passes', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.build.json --noEmit && tsc -p tsconfig.typecheck.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'tsconfig.typecheck.json': JSON.stringify({ extends: './tsconfig.json', include: ['src', 'vitest.config.ts'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 0);
});

test('with two -p flags, coverage by neither fails', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.build.json --noEmit && tsc -p tsconfig.other.json --noEmit' } }),
			'tsconfig.json': JSON.stringify({ compilerOptions: {} }),
			'tsconfig.build.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'tsconfig.other.json': JSON.stringify({ extends: './tsconfig.json', include: ['src'] }),
			'src/index.ts': SRC_FILE,
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /not in the type-check program/);
});

test('package with no typecheck script at all fails rather than being skipped', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { test: 'vitest run' } }),
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no tsc-based `typecheck` script/);
});

test('vitest.config.ts present but typecheck script is not tsc-based fails with a readable reason', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'node scripts/custom-typecheck.mjs' } }),
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no tsc-based `typecheck` script/);
});

test('typecheck script points at a missing tsconfig fails with a readable reason', () => {
	const root = makeFixture({
		'pkg-a': {
			'package.json': JSON.stringify({ name: 'pkg-a', scripts: { typecheck: 'tsc -p tsconfig.typecheck.json --noEmit' } }),
			'vitest.config.ts': VITEST_CONFIG,
		},
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /missing config/);
});

test('no packages directory at all is treated as nothing to check', () => {
	const root = mkdtempSync(join(tmpdir(), 'vitest-typecheck-coverage-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root' }));
	const result = run(root);
	assert.equal(result.status, 0);
});
