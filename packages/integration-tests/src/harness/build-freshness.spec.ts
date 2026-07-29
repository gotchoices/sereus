/**
 * Unit tests for the stale-build guard.
 *
 * The guard's worst failure mode is silent: if it stops detecting staleness it
 * never fires, and nothing else in the suite notices. These tests pin both
 * directions — stale is reported, fresh (and touched-test-file) is not.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkBuildFreshness } from './build-freshness.js';

const DIST_ENTRY = 'dist/index.js';
/** Seconds since epoch; `dist` sits between OLD and NEW so either side can win. */
const OLD = 1_700_000_000;
const BUILT = OLD + 100;
const NEW = BUILT + 100;

describe('checkBuildFreshness', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'build-freshness-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Writes `<root>/<relPath>` with the given mtime, creating parent dirs. */
	function writeAt(relPath: string, mtimeSeconds: number): void {
		const full = join(root, relPath);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, '// fixture\n');
		utimesSync(full, mtimeSeconds, mtimeSeconds);
	}

	function buildDist(): void {
		writeAt(DIST_ENTRY, BUILT);
	}

	it('reports missing when the dist entry point does not exist', () => {
		writeAt('src/index.ts', OLD);

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('missing');
	});

	it('reports fresh when every source predates the build', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/nested/deep/helper.ts', OLD);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('reports stale when a top-level source postdates the build', () => {
		writeAt('src/index.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('reports stale when a deeply nested source postdates the build', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/a/b/c/deep.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('ignores test and spec files, which are not build inputs', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/index.test.ts', NEW);
		writeAt('src/index.spec.ts', NEW);
		writeAt('src/component.test.tsx', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('ignores the test and __tests__ directories', () => {
		writeAt('src/index.ts', OLD);
		writeAt('src/__tests__/fixture.ts', NEW);
		writeAt('src/test/helper.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});

	it('still trips on a non-test file living beside excluded ones', () => {
		writeAt('src/index.test.ts', NEW);
		writeAt('src/constants.ts', NEW);
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBe('stale');
	});

	it('reports fresh when there is no src directory to compare against', () => {
		buildDist();

		expect(checkBuildFreshness(root, DIST_ENTRY)).toBeUndefined();
	});
});
