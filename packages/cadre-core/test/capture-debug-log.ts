import debug from 'debug';
import { format } from 'node:util';

/**
 * Run `body` with the `debug` namespaces in `namespaces` enabled and debug's sink captured,
 * returning the lines it emitted. `body` also receives the lines captured so far, to check
 * what was logged before some point inside it. The enabled set and the sink are
 * process-global in `debug`, so both are put back even when `body` throws.
 *
 * Not a `*.spec.ts` file, so the vitest glob never runs it as a suite.
 */
export async function captureDebugLog(
	namespaces: string,
	body: (captured: readonly string[]) => Promise<void>
): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debug.disable();
	const previousLog = debug.log;
	debug.enable(namespaces);
	debug.log = function (this: unknown, ...args: unknown[]): void { lines.push(format(...args)); };
	try {
		await body(lines);
	} finally {
		debug.log = previousLog;
		debug.disable();
		if (previousNamespaces) debug.enable(previousNamespaces);
	}
	return lines;
}
