import { describe, it, expect } from 'vitest';
import {
	CONTROL_WRITE_ATTEMPTS,
	CONTROL_WRITE_RETRY_BUDGET_MS,
	isRetriableControlWriteFailure,
	retryControlWrite,
	type ControlWriteRetryOptions
} from '../src/control-write-retry.js';
import { isLostUseNumberRace } from '../src/control-database.js';

/**
 * The transient-control-write classifier and retry loop behind
 * `ControlDatabase.lockedWithRetry`, in isolation — no database, no network.
 *
 * The classifier table below asserts against message LITERALS. That is a deliberate,
 * known dependency on engine/transactor error text (the same one `isLostUseNumberRace`
 * carries); producing these messages from the REAL engine so a rewording fails a spec
 * instead of silently disabling the retry is the follow-up ticket
 * `control-write-retry-real-error-coverage`.
 */

/**
 * The real failure arrives as `QuereusError` → `Error` → `Error`, with the recognisable
 * message potentially at any depth — so every classifier case here asserts through a
 * three-level `cause` chain with decoy text on the outer layers, not a flat message.
 */
function nested(message: string): Error {
	return new Error('Runtime error during write', {
		cause: new Error('control write failed', { cause: new Error(message) }),
	});
}

/** Pacing that never sleeps and never advances the budget clock. */
function immediatePacing(overrides: ControlWriteRetryOptions = {}): ControlWriteRetryOptions {
	return { sleep: () => Promise.resolve(), now: () => 0, ...overrides };
}

const TRANSACTOR_AGGREGATE =
	'Some peers did not complete: 12D3KooWpeer: The stream has been reset; root: abc123';
const SUPER_MAJORITY_NONE_ANSWERED =
	'Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_PARTIAL =
	'Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_REJECTED =
	'Failed to get super-majority: 2/3 approvals (needed 3, 1 rejections)';
const LOST_USE_NUMBER =
	'UNIQUE constraint failed: FormationUsage.Token, FormationUsage.UseNumber';
const LOST_USE_NUMBER_DEFERRED = 'CHECK constraint failed: Monotonic';

describe('isRetriableControlWriteFailure', () => {
	it('retries the transactor aggregate ("the cohort did not answer")', () => {
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE))).toBe(true);
	});

	it('retries a super-majority shortfall with ZERO rejections, at any approval count', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_NONE_ANSWERED))).toBe(true);
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_PARTIAL))).toBe(true);
	});

	it('never retries a super-majority shortfall carrying a rejection — somebody voted no', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_REJECTED))).toBe(false);
	});

	it('never retries constraint/authorization failures — a retry would re-present a spent signature', () => {
		expect(isRetriableControlWriteFailure(nested('CHECK constraint failed: Authorized'))).toBe(false);
		expect(isRetriableControlWriteFailure(nested('UNIQUE constraint failed: FormationUsage.UsageStampId'))).toBe(false);
	});

	it('never retries a non-Error throw, even one whose text would match', () => {
		expect(isRetriableControlWriteFailure(TRANSACTOR_AGGREGATE)).toBe(false);
		expect(isRetriableControlWriteFailure(undefined)).toBe(false);
		expect(isRetriableControlWriteFailure({ message: TRANSACTOR_AGGREGATE })).toBe(false);
	});

	/**
	 * The property that keeps this loop and `withUseNumberRetry` from multiplying: no error
	 * is claimed by both classifiers, so any given failure is retried by exactly one loop
	 * (or neither). Asserted from both directions.
	 */
	it('is disjoint from isLostUseNumberRace', () => {
		for (const lostRace of [LOST_USE_NUMBER, LOST_USE_NUMBER_DEFERRED]) {
			expect(isLostUseNumberRace(nested(lostRace))).toBe(true);
			expect(isRetriableControlWriteFailure(nested(lostRace))).toBe(false);
		}
		for (const transient of [TRANSACTOR_AGGREGATE, SUPER_MAJORITY_NONE_ANSWERED]) {
			expect(isRetriableControlWriteFailure(nested(transient))).toBe(true);
			expect(isLostUseNumberRace(nested(transient))).toBe(false);
		}
	});
});

describe('retryControlWrite', () => {
	it('returns the second attempt\'s value after one transient failure', async () => {
		let runs = 0;
		const result = await retryControlWrite(async () => {
			runs++;
			if (runs === 1) {
				throw nested(TRANSACTOR_AGGREGATE);
			}
			return 'committed';
		}, immediatePacing());

		expect(result).toBe('committed');
		expect(runs).toBe(2);
	});

	it('rethrows the LAST error unchanged after exhausting every attempt', async () => {
		const errors: Error[] = [];
		let runs = 0;
		let caught: unknown;
		try {
			await retryControlWrite(async () => {
				runs++;
				const error = nested(SUPER_MAJORITY_NONE_ANSWERED);
				errors.push(error);
				throw error;
			}, immediatePacing());
		} catch (error) {
			caught = error;
		}

		expect(runs).toBe(CONTROL_WRITE_ATTEMPTS);
		expect(errors).toHaveLength(CONTROL_WRITE_ATTEMPTS);
		// Identity, not message equality: the loop must rethrow the last attempt's error
		// object unchanged, never a wrapper and never an earlier attempt's.
		expect(caught).toBe(errors[errors.length - 1]);
	});

	/**
	 * The degraded-member case: a genuinely silent cohort member fails at ~20 s, past the
	 * 10 s elapsed budget before attempt 1 even returns — so the loop must surface it
	 * immediately. Retry adds ZERO latency to the case where it cannot help.
	 */
	it('stops after one attempt when that attempt alone consumed the budget', async () => {
		let clock = 0;
		let runs = 0;
		let slept = 0;
		const failure = nested(TRANSACTOR_AGGREGATE);
		await expect(retryControlWrite(async () => {
			runs++;
			clock += CONTROL_WRITE_RETRY_BUDGET_MS;
			throw failure;
		}, { now: () => clock, sleep: () => { slept++; return Promise.resolve(); } }))
			.rejects.toBe(failure);

		expect(runs).toBe(1);
		expect(slept).toBe(0);
	});

	it('propagates a non-retriable failure from the first attempt, unretried', async () => {
		let runs = 0;
		const failure = nested('CHECK constraint failed: Authorized');
		await expect(retryControlWrite(async () => {
			runs++;
			throw failure;
		}, immediatePacing())).rejects.toBe(failure);

		expect(runs).toBe(1);
	});

	/**
	 * Default pacing bounds: ±50% jitter on [250, 1000] means the first backoff is
	 * 125–375 ms (the jitter can never floor a delay to zero) and the second is capped at
	 * the largest base, 1000 ms (so a `stop()` racing a backoff is never held long).
	 */
	it('jitters each backoff within its floor and the largest-base cap', async () => {
		const delays: number[] = [];
		let runs = 0;
		await expect(retryControlWrite(async () => {
			runs++;
			throw nested(TRANSACTOR_AGGREGATE);
		}, { now: () => 0, sleep: (ms) => { delays.push(ms); return Promise.resolve(); } }))
			.rejects.toThrow();

		expect(runs).toBe(CONTROL_WRITE_ATTEMPTS);
		expect(delays).toHaveLength(CONTROL_WRITE_ATTEMPTS - 1);
		expect(delays[0]).toBeGreaterThanOrEqual(125);
		expect(delays[0]).toBeLessThanOrEqual(375);
		expect(delays[1]).toBeGreaterThanOrEqual(500);
		expect(delays[1]).toBeLessThanOrEqual(1000);
	});

	/**
	 * The nesting `withUseNumberRetry` now has in production: its use-number loop wraps
	 * `lockedWithRetry`, which wraps this loop. Simulated here with the same
	 * classify-and-rethrow shape to pin the multiplication bound — because the classifiers
	 * are disjoint (asserted above), any failure mode runs the body at most 3 times total,
	 * never 3 × 3.
	 */
	it('composed under a use-number-style outer loop, total attempts stay bounded at 3', async () => {
		const OUTER_ATTEMPTS = 3;
		const simulatedUseNumberRetry = async (write: () => Promise<void>): Promise<void> => {
			let lastError: unknown;
			for (let attempt = 1; attempt <= OUTER_ATTEMPTS; attempt++) {
				try {
					return await retryControlWrite(write, immediatePacing());
				} catch (error) {
					if (!isLostUseNumberRace(error)) {
						throw error;
					}
					lastError = error;
				}
			}
			throw lastError;
		};

		// A lost use number: the inner loop refuses it, the outer loop retries it.
		let lostRaceRuns = 0;
		await expect(simulatedUseNumberRetry(async () => {
			lostRaceRuns++;
			throw nested(LOST_USE_NUMBER);
		})).rejects.toThrow();
		expect(lostRaceRuns).toBe(OUTER_ATTEMPTS);

		// A transient cluster failure: the inner loop retries it, the outer loop refuses it.
		let transientRuns = 0;
		await expect(simulatedUseNumberRetry(async () => {
			transientRuns++;
			throw nested(TRANSACTOR_AGGREGATE);
		})).rejects.toThrow();
		expect(transientRuns).toBe(CONTROL_WRITE_ATTEMPTS);
	});
});
