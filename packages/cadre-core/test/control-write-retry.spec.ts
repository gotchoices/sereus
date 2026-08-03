import { describe, it, expect } from 'vitest';
import {
	CONTROL_WRITE_ATTEMPTS,
	CONTROL_WRITE_RETRY_BUDGET_MS,
	isRetriableControlWriteFailure,
	retryControlWrite,
	type ControlWriteRetryOptions
} from '../src/control-write-retry.js';
import { ControlDatabase, isLostUseNumberRace } from '../src/control-database.js';
import type { ControlDatabaseConfig } from '../src/control-database.js';

/**
 * The transient-control-write classifier and retry loop behind
 * `ControlDatabase.lockedWithRetry`, in isolation — no database, no network.
 *
 * The classifier table below asserts against message LITERALS, a known dependency on
 * engine/transactor error text. It is only half the coverage, deliberately:
 *
 *  - the NON-retriable side (constraint/authorization failures, and disjointness with
 *    `isLostUseNumberRace`) is additionally driven from the REAL engine in
 *    `control-formation-use-number-retry.spec.ts`, which boots a `CadreNode` — so a
 *    reworded constraint message reddens a spec there;
 *  - the RETRIABLE side cannot be produced here at all. Both messages come off a real
 *    multi-node cluster (the network transactor's aggregate, the cluster coordinator's
 *    super-majority shortfall), which needs an integration scenario, not a unit spec.
 *    `control-write-retry-scenario-coverage` produces them for real; until it lands, a
 *    rewording upstream would silently disable the retry and only these literals would
 *    notice. The literals below are transcribed from the transactor's own format strings
 *    (`db-core/src/transactor/network-transactor.ts`) — they are not claimed to be
 *    captured output.
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

/**
 * One `create table` of the control DDL failing, as Quereus' migration loop reports it:
 * `Failed to execute DDL: <ddl>\nError: <cause message>`, with the cause preserved on the
 * chain (`runBatchedMigrationLoop` in
 * `quereus/src/runtime/emit/schema-declarative.ts`). The classifier walks the chain, so it
 * sees the inner message either way — the outer text is here so the schema-init cases below
 * fail against the surface a real startup actually produces.
 */
function ddlFailure(causeMessage: string): string {
	return `Failed to execute DDL: create table CadreControl.FormationUsage (Token text not null, UseNumber integer not null)\nError: ${causeMessage}`;
}

/**
 * The transactor aggregate as the block-read (`get`) and phase-1 (`pend`) sites format it:
 * per-batch details name a SINGLE block, `<peerId>[block:<id>](<status>)`. Nothing has
 * committed when either site raises, so the write is known not to have landed.
 *
 * This one is a real captured message (recorded in
 * `tickets/fix/control-read-over-fresh-edge-stream-resets.md`), not a reconstruction.
 */
const TRANSACTOR_AGGREGATE =
	'Some peers did not complete: 12D3KooWBkxetzv16fD2997rSFQfqDQJYX7NFhmcwhk3AEfqr1VU[block:PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk](in-flight) cause=The stream has been reset; root: The stream has been reset';
/**
 * The SAME aggregate message from the phase-2 (`commitBlocks`) site, which formats a batch's
 * block COUNT instead — `<peerId>[blocks:<count>](<status>)`. A no-response there is
 * indeterminate (the coordinator may have committed and only the reply was lost), so this one
 * must never be re-presented.
 */
const TRANSACTOR_AGGREGATE_COMMIT_PHASE =
	'Some peers did not complete: 12D3KooWpeer[blocks:3](no-response) cause=The stream has been reset; root: The stream has been reset';
/** The aggregate with no per-batch details at all — `formatBatchStatuses` had nothing to format. */
const TRANSACTOR_AGGREGATE_NO_DETAILS =
	'Some peers did not complete: ; root: The stream has been reset';
const SUPER_MAJORITY_NONE_ANSWERED =
	'Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_PARTIAL =
	'Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)';
const SUPER_MAJORITY_REJECTED =
	'Failed to get super-majority: 2/3 approvals (needed 3, 1 rejections)';
const LOST_USE_NUMBER =
	'UNIQUE constraint failed: FormationUsage.Token, FormationUsage.UseNumber';
const LOST_USE_NUMBER_DEFERRED = 'CHECK constraint failed: Monotonic';
/**
 * The shortfall exactly as a THREE-node party raises it — the shape that makes a third
 * node's join fragile. A control transaction there needs 2 of 2 remaining peers to answer,
 * so ONE flaky peer response is fatal where a two-node party would have tolerated it.
 * Transcribed from the failing `provider-seed-accepted` run recorded in
 * `tickets/implement/29.3-third-node-join-ddl-init.md`.
 */
const SUPER_MAJORITY_THIRD_NODE_JOIN =
	'Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)';
/**
 * A durable convergence fault, not a transient one: a collection reports a committed
 * revision whose header block reads as affirmatively ABSENT. Tracked separately in
 * `tickets/blocked/control-db-cross-node-convergence-halted.md`; a retry cannot heal it, so
 * the classifier must keep letting it through unmatched.
 */
const MISSING_BLOCK = 'Missing block (jQlkVafUFlI6FzOGGAlViyK5GrgcSm_4SL7HfPKwhis)';

describe('isRetriableControlWriteFailure', () => {
	it('retries the read/pend-phase transactor aggregate ("the cohort did not answer")', () => {
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE))).toBe(true);
	});

	/**
	 * The distinction the `[block:` / `[blocks:` token draws. A commit-phase no-response is
	 * INDETERMINATE — the coordinator runs consensus internally and may have committed with only
	 * the reply lost — so re-running the write body would risk turning a success into a
	 * constraint failure. Same message prefix, same `cause`; only the per-batch detail differs.
	 */
	it('never retries the commit-phase aggregate — the write may have landed', () => {
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE_COMMIT_PHASE))).toBe(false);
	});

	it('never retries an aggregate whose phase cannot be told from its details', () => {
		// No details, so no token: an unattributable failure is not a proven non-commit.
		expect(isRetriableControlWriteFailure(nested(TRANSACTOR_AGGREGATE_NO_DETAILS))).toBe(false);
		// A single-block batch alongside a commit batch: the conservative arm wins.
		expect(isRetriableControlWriteFailure(nested(
			'Some peers did not complete: 12D3KooWa[block:blk-7](no-response), 12D3KooWb[blocks:3](no-response)',
		))).toBe(false);
	});

	/**
	 * The veto spans the `cause` chain, not one message. A read-phase aggregate at one level
	 * must not license a retry when ANOTHER level reports a commit-phase batch — whichever
	 * order the two land in. Asserted for the retriable transactor arm and the super-majority
	 * arm alike, since an indeterminate commit disqualifies a re-run no matter what else in
	 * the chain looks transient.
	 */
	it('never retries a chain that reports a commit-phase batch at ANY level', () => {
		const chained = (outer: string, inner: string): Error =>
			new Error(outer, { cause: new Error(inner) });

		for (const retriable of [TRANSACTOR_AGGREGATE, SUPER_MAJORITY_NONE_ANSWERED]) {
			// The control: on its own, each of these IS retried.
			expect(isRetriableControlWriteFailure(new Error(retriable))).toBe(true);
			expect(isRetriableControlWriteFailure(
				chained(retriable, TRANSACTOR_AGGREGATE_COMMIT_PHASE))).toBe(false);
			expect(isRetriableControlWriteFailure(
				chained(TRANSACTOR_AGGREGATE_COMMIT_PHASE, retriable))).toBe(false);
		}
	});

	it('retries a super-majority shortfall with ZERO rejections, at any approval count', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_NONE_ANSWERED))).toBe(true);
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_PARTIAL))).toBe(true);
	});

	it('never retries a super-majority shortfall carrying a rejection — somebody voted no', () => {
		expect(isRetriableControlWriteFailure(nested(SUPER_MAJORITY_REJECTED))).toBe(false);
	});

	/**
	 * `Missing block` is a DURABLE fault (a committed revision whose header block is
	 * affirmatively absent), so it matches nothing here and propagates unchanged. Asserted
	 * explicitly because the schema-init retry below shares this classifier: widening it to
	 * absorb this message would make a joining node spin over an unhealable condition and
	 * then report the same failure ~2 s later.
	 */
	it('never retries a missing-block convergence fault — a retry cannot heal it', () => {
		expect(isRetriableControlWriteFailure(nested(MISSING_BLOCK))).toBe(false);
		expect(isRetriableControlWriteFailure(nested(ddlFailure(MISSING_BLOCK)))).toBe(false);
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

/**
 * Test-only window onto `ControlDatabase.loadSchema` and the two private fields it needs:
 * the `Database` handle `initialize` would have built, and `lockedWithRetry`'s pacing seams.
 * Same cast pattern `control-write-lock.spec.ts` uses for the same seams.
 *
 * Driving `loadSchema` directly (rather than `initialize`) is deliberate: the subject is
 * whether the DDL `exec` is re-presented after a transient cohort failure, and everything
 * `initialize` does before it — plugin registration, libp2p injection, catalog hydration —
 * is irrelevant to that and would cost a real node bring-up to reproduce.
 */
interface SchemaInitHarness {
	db: { exec: (sql: string) => Promise<void> };
	controlWriteRetryPacing: ControlWriteRetryOptions;
	loadSchema: () => Promise<void>;
}

/**
 * A `ControlDatabase` with `initialize`'s output faked: `exec` is the supplied stub, pacing
 * never sleeps. The config is never read on this path (`schemaPath` is absent, so
 * `loadSchema` takes the embedded-schema branch), hence the cast rather than a real libp2p
 * node.
 */
function schemaInitHarness(exec: (sql: string) => Promise<void>): SchemaInitHarness {
	const database = new ControlDatabase({ partyId: 'schema-init-spec' } as ControlDatabaseConfig);
	const harness = database as unknown as SchemaInitHarness;
	harness.db = { exec };
	harness.controlWriteRetryPacing = immediatePacing();
	return harness;
}

/**
 * Schema init is a DISTRIBUTED write — every `CadreControl` table is optimystic-backed, so
 * each `create table` needs a super-majority of the party's peers to answer. It used to be
 * the one such write that bypassed the retry, which made a node joining a party that already
 * had two live members die on startup over a single unanswered peer.
 *
 * Re-running the whole `exec` is safe because `apply schema` is a diff, not a replay, and a
 * failed `create table` leaves the catalog clean — so attempt 2 re-emits exactly the failed
 * table and its successors. The reasoning lives at the call site; these cases pin the
 * behaviour.
 */
describe('ControlDatabase.loadSchema — transient-failure retry', () => {
	it('re-presents the whole DDL after a third-node-join super-majority shortfall', async () => {
		let runs = 0;
		const executed: string[] = [];
		const harness = schemaInitHarness(async (sql) => {
			runs++;
			executed.push(sql);
			if (runs === 1) {
				throw nested(ddlFailure(SUPER_MAJORITY_THIRD_NODE_JOIN));
			}
		});

		await harness.loadSchema();

		expect(runs).toBe(2);
		// The retry re-presents the SAME schema text: Quereus diffs it against the live
		// catalog, so the tables that landed on attempt 1 emit no DDL the second time.
		expect(executed[1]).toBe(executed[0]);
		expect(executed[0]).toContain('CadreControl');
	});

	/**
	 * The two failure faces observed from the same joining node, only one of which this
	 * retry is for. A commit-phase batch is INDETERMINATE (the write may have landed), and
	 * `Missing block` is durable. Both must reach the caller from the first attempt — a
	 * silent extra ~2 s of retry before the identical error would be pure cost.
	 */
	it('never re-presents an indeterminate commit or a durable convergence fault', async () => {
		for (const causeMessage of [TRANSACTOR_AGGREGATE_COMMIT_PHASE, MISSING_BLOCK]) {
			let runs = 0;
			const failure = nested(ddlFailure(causeMessage));
			const harness = schemaInitHarness(async () => {
				runs++;
				throw failure;
			});

			await expect(harness.loadSchema()).rejects.toBe(failure);
			expect(runs).toBe(1);
		}
	});

	it('surfaces the last error unchanged once the attempt budget is spent', async () => {
		const thrown: Error[] = [];
		const harness = schemaInitHarness(async () => {
			const failure = nested(ddlFailure(SUPER_MAJORITY_THIRD_NODE_JOIN));
			thrown.push(failure);
			throw failure;
		});

		let caught: unknown;
		try {
			await harness.loadSchema();
		} catch (error) {
			caught = error;
		}

		expect(thrown).toHaveLength(CONTROL_WRITE_ATTEMPTS);
		// Identity, not message equality: the LAST attempt's error object, never a wrapper
		// and never an earlier attempt's — startup diagnostics read this text verbatim.
		expect(caught).toBe(thrown[thrown.length - 1]);
	});
});
