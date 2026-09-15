/**
 * founding-progress.ts — the feedback Settings gives while a strand is being
 * founded, kept free of React Native so the node test project can run it.
 *
 * On a phone, founding can take far longer than it does headless, and a founding
 * that never finished looked exactly like a tap that never registered: nothing on
 * screen, nothing in logcat. So Settings shows elapsed seconds while founding runs,
 * reports the elapsed time with the result, and logs both ends.
 */

/** How long founding may run before Settings says it is slow but still running. */
export const FOUNDING_SLOW_HINT_MS = 30_000;

/** The founding action in progress: "Create Chat Strand" or "Create Closed Strand + Invite". */
export type FoundingKind = 'open' | 'closed';

/** A founding in progress. Settings allows one at a time. */
export interface PendingFounding {
	kind: FoundingKind;
	/** `performance.now()` when it started. */
	startedAt: number;
}

/** How a founding settled, and how long it took. */
export type FoundingOutcome<T> =
	| { ok: true; value: T; elapsedMs: number }
	| { ok: false; error: unknown; elapsedMs: number };

/** The console methods {@link traceFounding} writes to. */
export interface FoundingLogger {
	info(message: string): void;
	warn(message: string, error: unknown): void;
}

/**
 * Run one founding action between log lines: `<label> pressed` when it starts, then
 * `<label> succeeded in <n> ms` (info) or `<label> failed after <n> ms:` with the
 * error (warn). These log in release builds too — they are the only evidence a
 * user's report can carry.
 *
 * Never rejects: a failure is logged here and returned as the outcome, so the caller
 * can report it together with its elapsed time.
 */
export async function traceFounding<T>(
	label: string,
	op: () => Promise<T>,
	logger: FoundingLogger = console,
	now: () => number = () => performance.now(),
): Promise<FoundingOutcome<T>> {
	logger.info(`${label} pressed`);
	const startedAt = now();
	try {
		const value = await op();
		const elapsedMs = Math.round(now() - startedAt);
		logger.info(`${label} succeeded in ${elapsedMs} ms`);
		return { ok: true, value, elapsedMs };
	} catch (error) {
		const elapsedMs = Math.round(now() - startedAt);
		logger.warn(`${label} failed after ${elapsedMs} ms:`, error);
		return { ok: false, error, elapsedMs };
	}
}

/** The pressed button's label while founding runs: `Creating… 12 s`. */
export function pendingLabel(elapsedMs: number): string {
	return `Creating… ${Math.floor(elapsedMs / 1000)} s`;
}

/** True once founding has run long enough for Settings to say it is slow. */
export function isSlowFounding(elapsedMs: number): boolean {
	return elapsedMs >= FOUNDING_SLOW_HINT_MS;
}

/** The result modal's elapsed-time line: `Created in 1.4 s` or `Failed after 3.2 s`. */
export function foundingDetail(outcome: FoundingOutcome<unknown>): string {
	const seconds = `${(outcome.elapsedMs / 1000).toFixed(1)} s`;
	return outcome.ok ? `Created in ${seconds}` : `Failed after ${seconds}`;
}
