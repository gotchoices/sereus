import debug from 'debug';
import { unwrapError } from '@quereus/quereus';

const log = debug('sereus:cadre:control-db');

/**
 * The bounded retry loop shared by the control plane's transient-failure policies:
 * writes (`control-write-retry.ts`, behind `ControlDatabase.lockedWithRetry`) and reads
 * (`control-read-retry.ts`, behind `ControlDatabase.readRows`). One loop, two policy
 * modules — they differ in classifier, attempt count, backoff and elapsed budget, but the
 * loop mechanics (jittered capped backoff, budget checked after a failed attempt BEFORE
 * sleeping, last error rethrown unchanged) are deliberately identical so a fix to one
 * cannot silently miss the other.
 *
 * The log prefix is part of the policy because the write funnel's lines are asserted
 * byte-identically by `control-write-degraded-cohort-member.integration.ts` — extracting
 * this loop must not move a single character of them.
 */

/** A retry policy: what to retry, how often, and under which elapsed-time ceiling. */
export interface ControlRetryPolicy {
	/** Total attempts, first included (floored at 1 by the loop). */
	attempts: number;
	/**
	 * Backoff base before retry N (last entry repeats), jittered ±50% — so the jitter can
	 * never floor a delay to zero — and each single sleep additionally capped at the
	 * LARGEST delay in the list, so a `stop()` racing a backoff is never held up longer
	 * than that. There is no `AbortSignal` at this seam to cancel a sleep outright; the
	 * cap is the substitute, deliberately not plumbing one through every call path.
	 */
	delaysMs: readonly number[];
	/**
	 * Elapsed-time ceiling on the whole loop, measured from the START of the first attempt
	 * and checked after a failed attempt BEFORE sleeping — so one slow attempt terminates
	 * the loop rather than compounding, and retry adds ZERO latency to the case where it
	 * cannot help.
	 */
	budgetMs: number;
	/** Which failures are transient enough to re-present. */
	isRetriable: (error: unknown) => boolean;
	/**
	 * Subject of every log line the loop emits (`<prefix>[ [<label>]] …`). Defaults to
	 * `'Control write'`, which keeps the write funnel's lines byte-identical to what it
	 * logged before this loop was shared out of `control-write-retry.ts`.
	 */
	logPrefix?: string;
}

/**
 * Per-call overrides applied over a policy. Production callers pass at most `label`
 * (usually via the policy module's wrapper); specs inject a recorded `sleep`, a shorter
 * delay list, or a fake clock so no test ever waits out a real backoff.
 */
export interface ControlRetryOptions {
	/**
	 * Total attempts, first included. Default: the policy's, floored at 1 — below that
	 * the loop would run the body zero times and rethrow a `lastError` nobody set.
	 */
	attempts?: number;
	/** Backoff base before retry N (last entry repeats). Default: the policy's. */
	delaysMs?: readonly number[];
	/** Which failures are transient enough to re-present. Default: the policy's classifier. */
	isRetriable?: (error: unknown) => boolean;
	/**
	 * Operation label stamped into every log line this loop emits (rendered as
	 * `<prefix> [<label>] …`), and NOTHING else — no behavioural effect. The debug log is
	 * the only surface where the loop's decisions are observable (the rethrown error is
	 * unchanged and no attempt counter is exposed), and several operations retry
	 * CONCURRENTLY in a real party, so an unlabelled line cannot be attributed. The
	 * degraded-cohort scenario asserts on the write funnel's lines per-operation.
	 */
	label?: string;
	/** The sleep primitive. Default: `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock for the elapsed-budget check. Default: `Date.now`. */
	now?: () => number;
}

/**
 * Run `attempt` up to the policy's attempt count, retrying only failures its classifier
 * calls transient, and only while its elapsed budget has not run out.
 *
 * `attempt` must be safe to re-run — for writes that means atomic (a failed cluster write
 * rolls back, nothing half-applies; the contract on `ControlDatabase.withWriteLock`), for
 * reads it holds trivially. The backoff sleeps happen with NO lock held; a caller that
 * locks takes and releases its lock inside `attempt`.
 *
 * On exhaustion (attempts or budget) the LAST error is rethrown unchanged — never
 * wrapped, so the exact messages downstream code and the integration scenarios assert on
 * survive. A non-retriable failure propagates from the attempt that raised it.
 */
export async function retryControlOperation<T>(
	attempt: () => Promise<T>,
	policy: ControlRetryPolicy,
	options: ControlRetryOptions = {}
): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? policy.attempts);
	const delays = options.delaysMs ?? policy.delaysMs;
	const isRetriable = options.isRetriable ?? policy.isRetriable;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const prefix = policy.logPrefix ?? 'Control write';
	// Empty when unlabelled, so an unlabelled line is byte-identical to what the write
	// loop logged before labels existed.
	const tag = options.label ? ` [${options.label}]` : '';
	const start = now();
	let lastError: unknown;
	let attemptsMade = 0;
	for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber++) {
		attemptsMade = attemptNumber;
		try {
			const result = await attempt();
			if (attemptNumber > 1) {
				log('%s%s committed on attempt %d/%d', prefix, tag, attemptNumber, attempts);
			}
			return result;
		} catch (error) {
			if (!isRetriable(error)) {
				// The ONLY trace that this funnel saw a failure and declined it. Without it the
				// log is silent either way, so "the classifier vetoed this one" is
				// indistinguishable from "the retry is not wired into this path at all".
				log('%s%s failed non-transiently on attempt %d/%d, not retried here: %s',
					prefix, tag, attemptNumber, attempts, error);
				throw error;
			}
			lastError = error;
			if (attemptNumber === attempts) {
				break;
			}
			const elapsed = now() - start;
			if (elapsed >= policy.budgetMs) {
				break;
			}
			const delay = jitteredDelay(delays, attemptNumber);
			log('%s%s failed transiently (attempt %d/%d), retrying in %d ms: %s',
				prefix, tag, attemptNumber, attempts, delay, error);
			await sleep(delay);
		}
	}
	log('%s%s failed after %d/%d attempt(s): %s', prefix, tag, attemptsMade, attempts, lastError);
	throw lastError;
}

/**
 * Every message in the failure's `cause` chain — the shared substrate both classifiers
 * match against, since the failures they care about are not recognisable by type (the
 * typed errors are destroyed on the way out of optimystic; only text survives).
 *
 * `unwrapError` declares its `message` as `string`, but it follows `.cause` without checking
 * what that holds — a chain link that is not an `Error` (a stream rejected with a bare string
 * reason, an `AbortSignal.reason` that is a plain object) yields `undefined` there, and
 * calling `.includes` on it would throw a `TypeError` out of a classifier, INSIDE
 * {@link retryControlOperation}'s catch, replacing the real failure with a confusing one.
 * Non-strings are dropped: a link nobody can read is a link that matches nothing, which is
 * already the conservative answer.
 *
 * NOTE: a cause chain with a CYCLE would spin forever inside `unwrapError` itself. No error
 * in this repo builds one; if a hang ever localises to a control retry path, look there.
 */
export function chainMessages(error: Error): string[] {
	return unwrapError(error)
		.map(({ message }) => message)
		.filter(message => typeof message === 'string');
}

/**
 * Backoff for the retry that follows attempt `attemptNumber`: the matching base delay
 * (last entry repeats), jittered ±50%, then capped at the list's largest base so no single
 * sleep exceeds it (see {@link ControlRetryPolicy.delaysMs} for why). `Math.random` is
 * fine here — the jitter only de-synchronizes concurrent retriers, nothing is derived
 * from it.
 *
 * NOTE: the cap bites on the LAST delay, whose base IS the largest, so ~half of those sleeps
 * land exactly on the cap rather than spread — de-synchronization is only partial there.
 * Harmless while retriers are a handful of party nodes whose attempts already start seconds
 * apart; if a party ever retries in a tight synchronized herd, raise the cap above the
 * largest base instead of jittering about it.
 */
function jitteredDelay(delays: readonly number[], attemptNumber: number): number {
	if (delays.length === 0) {
		return 0;
	}
	const base = delays[Math.min(attemptNumber - 1, delays.length - 1)]!;
	const jittered = base * (0.5 + Math.random());
	return Math.min(jittered, Math.max(...delays));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
