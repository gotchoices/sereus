/**
 * Pins which skipped tests the setup-failure reporter counts as not run.
 *
 * The rule reads state values off Vitest's own task objects (`skipped` with mode
 * `run`, a `failed` suite with errors), so it is checked against a real Vitest
 * run rather than hand-built fakes that could drift from those values. The
 * fixture suite is written into the OS temp directory at run time: committed
 * here as `*.spec.*` it would be collected by the outer run and turn it red.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPORTER = fileURLToPath(new URL('./setup-failure-reporter.ts', import.meta.url));
/** `vitest.mjs` is the package's `bin`, which its `exports` map does not expose. */
const VITEST_BIN = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

/** No imports anywhere in the fixture: nothing resolves `vitest` from the temp directory. */
const FIXTURE: Record<string, string> = {
	'vitest.config.mjs': `export default { test: { globals: true, reporters: ['verbose', ${JSON.stringify(REPORTER)}] } };\n`,
	// The second test sits in a nested suite, which is not itself failed: the
	// walk has to reach the outer suite to count it. The `it.skip` would not
	// have run had setup succeeded, so it stays out of the count.
	'suite-setup.spec.mjs': `
		describe('setup throws', () => {
			beforeAll(() => { throw new Error('suite boot failed'); });
			it('never runs', () => {});
			it.skip('skipped statically', () => {});
			describe('nested', () => {
				it('never runs either', () => {});
			});
		});
	`,
	'module-setup.spec.mjs': `
		beforeAll(() => { throw new Error('module boot failed'); });
		it('never runs', () => {});
	`,
	// A thrown object with no `message` reaches the reporter with `message` undefined.
	'object-thrown.spec.mjs': `
		beforeAll(() => { throw { code: 5 }; });
		it('never runs', () => {});
	`,
	'teardown.spec.mjs': `
		describe('teardown throws', () => {
			afterAll(() => { throw new Error('teardown failed'); });
			it('passes', () => {});
			it('skips at run time', ctx => { ctx.skip(); });
			it.skip('skipped statically', () => {});
		});
	`,
	'plain.spec.mjs': `
		it('passes', () => {});
		it.skip('skipped statically', () => {});
	`,
};

interface VitestRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runVitest(root: string, ...fileFilters: string[]): Promise<VitestRun> {
	return new Promise((resolve, reject) => {
		const args = [VITEST_BIN, 'run', '--root', root, '--config', join(root, 'vitest.config.mjs'), ...fileFilters];
		const child = spawn(process.execPath, args, { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
		child.once('error', reject);
		child.once('close', code => resolve({ code, stdout, stderr }));
	});
}

describe('setup-failure reporter', () => {
	let root: string;

	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-failure-reporter-')));
		for (const [name, source] of Object.entries(FIXTURE)) writeFileSync(join(root, name), source);
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it('counts the tests under a failed beforeAll, and no other skipped test', async () => {
		const run = await runVitest(root);
		const blockStart = run.stdout.indexOf('NOT RUN');
		const block = run.stdout.slice(blockStart);

		expect(run.code, run.stderr).toBe(1);
		expect(blockStart).toBeGreaterThan(run.stdout.indexOf('Test Files'));
		expect(block).toMatch(/^NOT RUN {2}4 tests /);
		expect(block).toContain('suite-setup.spec.mjs > setup throws — 2 tests\n     Error: suite boot failed');
		expect(block).toContain('module-setup.spec.mjs — 1 test\n     Error: module boot failed');
		expect(block).toContain('object-thrown.spec.mjs — 1 test\n     the hook threw a value with no message');
		expect(block).not.toContain('teardown');
		expect(block).not.toContain('plain.spec.mjs');
	});

	it('prints nothing when no setup failed', async () => {
		const run = await runVitest(root, 'plain.spec.mjs');

		expect(run.code, run.stderr).toBe(0);
		expect(run.stdout).toContain('1 passed');
		expect(run.stdout).not.toContain('NOT RUN');
	});
});
