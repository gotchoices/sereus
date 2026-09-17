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

/** Which of the loop's two give-up exits fired. */
export type ControlRetryAbandonReason =
	/** The classifier declined the failure as non-transient — no retry was attempted. */
	| 'declined'
	/** Every allowed attempt ran and failed transiently. */
	| 'attempts'
	/** The elapsed budget ran out before the next attempt could be started. */
	| 'budget';

/**
 * What the loop gave up on, handed to {@link ControlRetryPolicy.onAbandon} exactly once per
 * abandoned operation. Enough to attribute the loss without reading the debug log: which
 * operation, how far it got, why it stopped and what it failed with.
 */
export interface ControlRetryAbandonment {
	/** The operation label ({@link ControlRetryOptions.label}); absent when unlabelled. */
	label?: string;
	/** Attempts actually run, first included. */
	attemptsMade: number;
	/** Attempts the loop was allowed to run. */
	attemptsAllowed: number;
	/** Wall clock from the start of attempt 1 to the give-up, on the policy's clock. */
	elapsedMs: number;
	/** Which exit fired. */
	reason: ControlRetryAbandonReason;
	/** The error the loop is about to rethrow, unchanged. */
	error: unknown;
}

/** Notified once per abandoned operation. Must not throw — the loop catches and logs if it does. */
export type ControlRetryAbandonListener = (abandonment: ControlRetryAbandonment) => void;

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
	/**
	 * Notified when the loop GIVES UP on an operation — both exits, once each, before the
	 * error is rethrown. Optional, and on the POLICY rather than hard-coded in the loop, so
	 * each policy decides for itself: the write policy carries one (an abandoned write may
	 * have no caller awaiting it, so losing it is silent), the read policy deliberately
	 * does not (an abandoned read always throws to a caller that is awaiting it).
	 */
	onAbandon?: ControlRetryAbandonListener;
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
	/**
	 * Per-call abandonment observer, REPLACING the policy's
	 * ({@link ControlRetryPolicy.onAbandon}) rather than fanning out beside it — one
	 * observer per call, like every other field here. `ControlDatabase` merges its single
	 * settable listener in through this seam.
	 */
	onAbandon?: ControlRetryAbandonListener;
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
 *
 * Both give-up exits also notify the policy's {@link ControlRetryPolicy.onAbandon} (or the
 * call's, which replaces it) exactly once, before the rethrow. The debug line each exit
 * already wrote is off unless somebody set `DEBUG=`, and a background write has no caller
 * to surface the rethrown error — so without an observer the loss is silent everywhere.
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
	const onAbandon = options.onAbandon ?? policy.onAbandon;
	// Empty when unlabelled, so an unlabelled line is byte-identical to what the write
	// loop logged before labels existed.
	const tag = options.label ? ` [${options.label}]` : '';
	const start = now();
	let lastError: unknown;
	let attemptsMade = 0;
	// Which exit the loop leaves by. Only the budget check below moves it off the default,
	// so an unmodified `break` is the attempts exit.
	let exhaustedBy: ControlRetryAbandonReason = 'attempts';
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
				notifyAbandoned(onAbandon, prefix, tag, {
					...(options.label !== undefined ? { label: options.label } : {}),
					attemptsMade, attemptsAllowed: attempts, elapsedMs: now() - start,
					reason: 'declined', error
				});
				throw error;
			}
			lastError = error;
			if (attemptNumber === attempts) {
				break;
			}
			const elapsed = now() - start;
			if (elapsed >= policy.budgetMs) {
				exhaustedBy = 'budget';
				break;
			}
			const delay = jitteredDelay(delays, attemptNumber);
			log('%s%s failed transiently (attempt %d/%d), retrying in %d ms: %s',
				prefix, tag, attemptNumber, attempts, delay, error);
			await sleep(delay);
		}
	}
	log('%s%s failed after %d/%d attempt(s): %s', prefix, tag, attemptsMade, attempts, lastError);
	notifyAbandoned(onAbandon, prefix, tag, {
		...(options.label !== undefined ? { label: options.label } : {}),
		attemptsMade, attemptsAllowed: attempts, elapsedMs: now() - start,
		reason: exhaustedBy, error: lastError
	});
	throw lastError;
}

/**
 * Tell the observer the operation was abandoned, and never let that replace the failure.
 *
 * A throwing observer is a bug in the observer, not in the write: the loop is on its way to
 * rethrowing the real error, and letting the observer's `TypeError` out instead would erase
 * the very failure it was notified about. Logged and swallowed — the same treatment
 * `CadreNode.emit` gives a throwing event handler.
 */
function notifyAbandoned(
	listener: ControlRetryAbandonListener | undefined,
	prefix: string,
	tag: string,
	abandonment: ControlRetryAbandonment
): void {
	if (!listener) {
		return;
	}
	try {
		listener(abandonment);
	} catch (listenerError) {
		log('%s%s abandonment listener threw (the write\'s own failure is unaffected): %s',
			prefix, tag, listenerError);
	}
}

/**
 * Every message in the failure's `cause` chain — the shared substrate both retry classifiers
 * match against. They match text (why, in `control-read-retry.ts`'s module comment); every
 * wrap on the way out of optimystic and Quereus embeds the inner message, so the text of
 * the deepest failure is visible at every level.
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
