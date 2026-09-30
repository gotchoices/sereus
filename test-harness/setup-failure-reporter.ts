/**
 * Vitest reporter that names the tests a failed setup hook kept from running.
 *
 * When a `beforeAll` throws, Vitest marks every test under it `skipped`, so its
 * summary line (`Tests  1 passed | 3 skipped`) counts them together with tests
 * someone skipped on purpose and shows no failure for them. This reporter adds
 * one block after that summary listing them as not run. It prints nothing when
 * there are none, and leaves the exit code and Vitest's own output alone.
 *
 * List it after the reporter that prints the summary, in the config's
 * `reporters` — a `--reporter` flag on the command line replaces that list and
 * drops this one.
 *
 * Type-only imports: the file has no runtime dependency, so any package's
 * Vitest config can name it by relative path.
 */

import type { Reporter, TestCase, TestModule, TestSuite } from 'vitest/node';

type Container = TestSuite | TestModule;

function ranAnyTest(container: Container): boolean {
	for (const test of container.children.allTests()) {
		const { state } = test.result();
		if (state === 'passed' || state === 'failed') return true;
	}
	return false;
}

/**
 * A failed `afterAll` also leaves its suite `failed` with errors, so the state
 * alone does not say which hook threw; a test that passed or failed shows the
 * setup got far enough for the body to run.
 *
 * NOTE: accepted tradeoff — a suite whose every test calls `ctx.skip()` at run
 * time and whose `afterAll` then throws looks identical to a setup failure and
 * is reported as not run. Vitest's reporter API does not say which hook an
 * error came from. Revisit if a suite with that shape appears.
 */
function diedInSetup(container: Container): boolean {
	return container.state() === 'failed' && container.errors().length > 0 && !ranAnyTest(container);
}

/** Nearest enclosing suite, or the module itself, whose setup failed. */
function setupFailureAncestor(test: TestCase): Container | undefined {
	let container: Container = test.parent;
	while (!diedInSetup(container)) {
		if (container.type === 'module') return undefined;
		container = container.parent;
	}
	return container;
}

/** Mode `run` excludes `it.skip`, `describe.skip`, `todo` and tests filtered out by `only` or `-t`. */
function wasMeantToRun(test: TestCase): boolean {
	return test.result().state === 'skipped' && test.options.mode === 'run';
}

/** Number of tests not run, per suite or module whose setup failed, in run order. */
function countNotRun(testModules: ReadonlyArray<TestModule>): Map<Container, number> {
	const counts = new Map<Container, number>();
	for (const testModule of testModules) {
		for (const test of testModule.children.allTests()) {
			if (!wasMeantToRun(test)) continue;
			const failed = setupFailureAncestor(test);
			if (failed) counts.set(failed, (counts.get(failed) ?? 0) + 1);
		}
	}
	return counts;
}

function tests(count: number): string {
	return count === 1 ? '1 test' : `${count} tests`;
}

function containerLabel(container: Container): string {
	return container.type === 'module'
		? container.relativeModuleId
		: `${container.module.relativeModuleId} > ${container.fullName}`;
}

function firstErrorLine(container: Container): string {
	const [error] = container.errors();
	if (!error) return 'no error recorded';
	const firstLine = error.message.split('\n', 1)[0] ?? '';
	return error.name ? `${error.name}: ${firstLine}` : firstLine;
}

function formatNotRunBlock(counts: ReadonlyMap<Container, number>): string {
	let total = 0;
	const groups: string[] = [];
	for (const [container, count] of counts) {
		total += count;
		groups.push(`   ${containerLabel(container)} — ${tests(count)}\n     ${firstErrorLine(container)}`);
	}
	const heading = ` NOT RUN  ${tests(total)} did not run because a setup hook (beforeAll) failed. Count as failed, not skipped.`;
	return `\n${heading}\n${groups.join('\n')}\n\n`;
}

export default class SetupFailureReporter implements Reporter {
	onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
		const counts = countNotRun(testModules);
		if (counts.size > 0) process.stdout.write(formatNotRunBlock(counts));
	}
}
