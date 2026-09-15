import debug from 'debug';

const timing = debug('sereus:cadre:timing');

/**
 * Await one step of a longer operation between two `sereus:cadre:timing` lines:
 * `[<scope>:<id>] <step>: start` before it, then `<step>: <n>ms` — or
 * `<step>: failed after <n>ms` — once it settles. The start line is what matters on a
 * device: a step that never settles leaves a start with no matching end, so a trace
 * names the step that hung rather than only the last one that finished.
 *
 * The text is built here rather than passed as `%s`/`%d` arguments: `debug`'s browser
 * build, which React Native bundles, leaves placeholders for the console to fill, and
 * RN's console prints them unfilled, so a device trace would read `[%s:%s] %s: start`.
 */
export async function timedStep<T>(scope: string, id: string, step: string, op: () => Promise<T>): Promise<T> {
	const label = `[${scope}:${id}] ${step}`;
	timing(`${label}: start`);
	const t0 = performance.now();
	try {
		const result = await op();
		timing(`${label}: ${Math.round(performance.now() - t0)}ms`);
		return result;
	} catch (error) {
		timing(`${label}: failed after ${Math.round(performance.now() - t0)}ms`);
		throw error;
	}
}
