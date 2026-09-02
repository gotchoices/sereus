import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import debug from 'debug';
import { format } from 'node:util';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import {
	CONTROL_READ_ATTEMPTS,
	CONTROL_READ_RETRY_DELAYS_MS,
	CONTROL_READ_RETRY_BUDGET_MS,
	isRetriableControlReadFailure,
	retryControlRead,
	type ControlReadRetryOptions
} from '../src/control-read-retry.js';
import { CONTROL_WRITE_ATTEMPTS } from '../src/control-write-retry.js';
import type { ControlWriteRetryOptions } from '../src/control-write-retry.js';
import { ADMISSION_DECISION_TIMEOUT_MS } from '../src/membership-connection-gater.js';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * The transient-control-read classifier and retry loop behind
 * `ControlDatabase.readRows`, in isolation — plus a `ControlDatabase`-level block that
 * drives the seam against a real node with the inner Quereus `eval` rigged to fail, the
 * inversion of the repro that proved reads had no second chance (a single injected
 * failure during iteration killed `queryRevokedStamps` after exactly one `eval` call
 * while the same injection against `exec` was absorbed; measured 2026-09-01).
 *
 * The classifier table asserts against message LITERALS, a known dependency on
 * engine/transactor/optimystic error text: `BlockUnavailableError` and its `reason` are
 * destroyed on the way out of optimystic (`OptimysticVirtualTable` rethrows
 * `new Error('Query failed: ' + message)` with no `cause`), so text is all a classifier
 * can ever see, and every matcher fails CLOSED — an upstream rewording stops the retry
 * engaging rather than making it unsafe. The `Block <id> is unavailable (<reason>)`
 * literals below are transcribed from `BlockUnavailableError` / `BlockPossiblyStaleError`
 * in `optimystic/packages/db-core/src/network/struct.ts`.
 */

/**
 * The real failure arrives as `QuereusError` → `Error` → `Error`, with the recognisable
 * message potentially at any depth — so classifier cases assert through a three-level
 * `cause` chain with decoy text on the outer layers, not only a flat message.
 */
function nested(message: string): Error {
	return new Error('Runtime error during read', {
		cause: new Error('control read failed', { cause: new Error(message) }),
	});
}

/** Pacing that never sleeps and never advances the budget clock. */
function immediatePacing(overrides: ControlReadRetryOptions = {}): ControlReadRetryOptions {
	return { sleep: () => Promise.resolve(), now: () => 0, ...overrides };
}

/**
 * The transactor's read/pend-phase aggregate — the class that killed
 * `CadreNode.registerSelf`'s own-row read in 23–28 ms (recorded in the fix ticket). Same
 * captured literal `control-write-retry.spec.ts` uses; a `get` batch formats the
 * single-block `[block:` token.
 */
const TRANSACTOR_AGGREGATE =
	'Some peers did not complete: 12D3KooWBkxetzv16fD2997rSFQfqDQJYX7NFhmcwhk3AEfqr1VU[block:PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk](in-flight) cause=The stream has been reset; root: The stream has been reset';
/**
 * The commit-phase shape (`[blocks:`). A READ can never produce it — no read commits —
 * so the read classifier simply never matches it (default: no retry) rather than
 * carrying the write side's veto.
 */
const TRANSACTOR_AGGREGATE_COMMIT_PHASE =
	'Some peers did not complete: 12D3KooWpeer[blocks:3](in-flight) cause=The stream has been reset; root: The stream has been reset';

/** Upstream's exact `BlockUnavailableError` template, per reason. */
function blockUnavailable(reason: string): string {
	return `Block PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk is unavailable (${reason}): the repo could not determine whether it exists`;
}

/** Upstream's exact `BlockPossiblyStaleError` template. */
const BLOCK_POSSIBLY_STALE =
	'Block PaWaynQLVfuwhcw4tGh0uX_BDGPyoXWs-VPZOs0OpGk may be stale: a cohort peer claimed rev 5 that no reachable coordinator could confirm or refute';

/**
 * How a scan-path failure actually reaches this repo: optimystic's cause-less
 * `Query failed:` rethrow, wrapped by Quereus' scan emitter into
 * `Error during query on table '<T>': …` (which embeds the inner text in its own
 * message AND preserves the rethrow on `cause`).
 */
function scanWrapped(inner: string): Error {
	return new Error(`Error during query on table 'CadrePeer': Query failed: ${inner}`, {
		cause: new Error(`Query failed: ${inner}`),
	});
}

describe('isRetriableControlReadFailure', () => {
	it('retries the transactor\'s read-phase aggregate ("the cohort did not answer")', () => {
		expect(isRetriableControlReadFailure(nested(TRANSACTOR_AGGREGATE))).toBe(true);
		expect(isRetriableControlReadFailure(scanWrapped(TRANSACTOR_AGGREGATE))).toBe(true);
	});

	/**
	 * `peers-unreachable` is upstream's own invitation to re-ask: part of the cohort
	 * answered, part could not be asked, and OTHER coordinators are reachable.
	 * `cohort-unreachable` is the marginal inclusion — upstream says the answer improves
	 * only with this node's connectivity, but during bring-up it does, within a second
	 * (the boot-time shape in `blocked/control-read-over-fresh-edge-stream-resets`), and
	 * the read budget bounds the cost of being wrong.
	 */
	it('retries the two block-unavailability reasons a repeat read can improve on', () => {
		for (const reason of ['peers-unreachable', 'cohort-unreachable']) {
			expect(isRetriableControlReadFailure(nested(blockUnavailable(reason)))).toBe(true);
			expect(isRetriableControlReadFailure(scanWrapped(blockUnavailable(reason)))).toBe(true);
		}
	});

	/**
	 * `claimed-elsewhere` was MEASURED not to clear: reissuing the same call every second
	 * for 60 s returned the identical error every time (2026-08-20). Retrying it spends the
	 * whole budget and fails anyway — and would disguise the upstream root cause tracked in
	 * `blocked/block-held-by-only-one-machine-is-unreadable`. `unmaterializable` is a local
	 * data problem a second read re-reads.
	 */
	it('never retries the block-unavailability reasons a repeat read cannot improve on', () => {
		for (const reason of ['claimed-elsewhere', 'unmaterializable']) {
			expect(isRetriableControlReadFailure(nested(blockUnavailable(reason)))).toBe(false);
			expect(isRetriableControlReadFailure(scanWrapped(blockUnavailable(reason)))).toBe(false);
		}
	});

	it('never retries a possibly-stale read — currency, not existence, and it will not resolve in a backoff', () => {
		expect(isRetriableControlReadFailure(nested(BLOCK_POSSIBLY_STALE))).toBe(false);
		expect(isRetriableControlReadFailure(scanWrapped(BLOCK_POSSIBLY_STALE))).toBe(false);
	});

	/**
	 * Everything unmatched defaults to no retry: the commit-phase aggregate a read cannot
	 * produce, the write side's bare super-majority shortfall (a read presents no
	 * transaction; if the sentence ever reaches a read it arrives inside the aggregate,
	 * which the first case already claims), durable faults, and constraint refusals.
	 */
	it('never retries anything unmatched — the default is no retry', () => {
		for (const message of [
			TRANSACTOR_AGGREGATE_COMMIT_PHASE,
			'Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)',
			'Missing block (jQlkVafUFlI6FzOGGAlViyK5GrgcSm_4SL7HfPKwhis)',
			'CHECK constraint failed: Authorized',
			'no such table: CadreControl.CadrePeer',
		]) {
			expect(isRetriableControlReadFailure(nested(message))).toBe(false);
		}
	});

	/** Same non-Error discipline as the write classifier — answer, never throw. */
	it('never retries a non-Error throw, and survives a non-Error cause link', () => {
		expect(isRetriableControlReadFailure(TRANSACTOR_AGGREGATE)).toBe(false);
		expect(isRetriableControlReadFailure(undefined)).toBe(false);
		expect(isRetriableControlReadFailure({ message: TRANSACTOR_AGGREGATE })).toBe(false);
		expect(isRetriableControlReadFailure(
			new Error('control read failed', { cause: 'connection closed' }))).toBe(false);
		expect(isRetriableControlReadFailure(
			new Error(TRANSACTOR_AGGREGATE, { cause: { reason: 'aborted' } }))).toBe(true);
	});
});

describe('retryControlRead', () => {
	it('returns the second attempt\'s rows after one transient failure', async () => {
		let runs = 0;
		const result = await retryControlRead(async () => {
			runs++;
			if (runs === 1) {
				throw nested(blockUnavailable('peers-unreachable'));
			}
			return ['row'];
		}, immediatePacing());

		expect(result).toEqual(['row']);
		expect(runs).toBe(2);
	});

	it('rethrows the LAST error unchanged after exhausting every attempt', async () => {
		const errors: Error[] = [];
		let runs = 0;
		let caught: unknown;
		try {
			await retryControlRead(async () => {
				runs++;
				const error = nested(TRANSACTOR_AGGREGATE);
				errors.push(error);
				throw error;
			}, immediatePacing());
		} catch (error) {
			caught = error;
		}

		expect(runs).toBe(CONTROL_READ_ATTEMPTS);
		expect(caught).toBe(errors[errors.length - 1]);
	});

	/**
	 * The budget's safety property: checked after a failed attempt BEFORE sleeping, so one
	 * slow attempt (a `cohort-unreachable` read that burned the transactor's own deadline)
	 * terminates the loop instead of compounding.
	 */
	it('stops after one attempt when that attempt alone consumed the budget', async () => {
		let clock = 0;
		let runs = 0;
		let slept = 0;
		const failure = nested(TRANSACTOR_AGGREGATE);
		await expect(retryControlRead(async () => {
			runs++;
			clock += CONTROL_READ_RETRY_BUDGET_MS;
			throw failure;
		}, { now: () => clock, sleep: () => { slept++; return Promise.resolve(); } }))
			.rejects.toBe(failure);

		expect(runs).toBe(1);
		expect(slept).toBe(0);
	});

	it('propagates a non-retriable failure from the first attempt, unretried', async () => {
		let runs = 0;
		const failure = nested(blockUnavailable('claimed-elsewhere'));
		await expect(retryControlRead(async () => {
			runs++;
			throw failure;
		}, immediatePacing())).rejects.toBe(failure);

		expect(runs).toBe(1);
	});

	/**
	 * Read pacing bounds: ±50% jitter on [100, 400] means the first backoff is 50–150 ms
	 * and the second is 200–400 ms (capped at the largest base) — worst case ~550 ms of
	 * sleep, well inside the read budget.
	 */
	it('jitters each backoff within its floor and the largest-base cap', async () => {
		const delays: number[] = [];
		let runs = 0;
		await expect(retryControlRead(async () => {
			runs++;
			throw nested(TRANSACTOR_AGGREGATE);
		}, { now: () => 0, sleep: (ms) => { delays.push(ms); return Promise.resolve(); } }))
			.rejects.toThrow();

		expect(runs).toBe(CONTROL_READ_ATTEMPTS);
		expect(delays).toHaveLength(CONTROL_READ_ATTEMPTS - 1);
		expect(delays[0]).toBeGreaterThanOrEqual(50);
		expect(delays[0]).toBeLessThanOrEqual(150);
		expect(delays[1]).toBeGreaterThanOrEqual(200);
		expect(delays[1]).toBeLessThanOrEqual(400);
	});

	/**
	 * The read loop's own log prefix, so a retried read is attributable among the several
	 * reads in flight concurrently in a real party — and never mistakable for a write line,
	 * which `control-write-degraded-cohort-member.integration.ts` asserts byte-identically.
	 */
	it('stamps "Control read" and the label into every line it logs', async () => {
		const lines = await captureRetryLog(async () => {
			let runs = 0;
			await retryControlRead(async () => {
				runs++;
				if (runs === 1) throw nested(TRANSACTOR_AGGREGATE);
				return [];
			}, immediatePacing({ label: 'revoked-stamps' }));
		});

		expect(lines.some((line) => line.includes('Control read [revoked-stamps] failed transiently'))).toBe(true);
		expect(lines.some((line) => line.includes('Control read [revoked-stamps] committed on attempt 2/3'))).toBe(true);
		expect(lines.every((line) => !line.includes('Control write'))).toBe(true);
	});
});

/**
 * The budget relationship argued in prose at `CONTROL_READ_RETRY_BUDGET_MS`, pinned so a
 * future edit to either constant reddens here instead of silently reintroducing the
 * fail-open admit: the inbound admission gate reads the control DB under a 2 s deadline
 * and ADMITS on both throw and timeout, so a read retry that outlives the deadline is
 * spent after the gate has already waved the connection through.
 */
describe('read retry budget vs admission deadline', () => {
	it('fits the whole read retry inside the gate\'s fail-open deadline', () => {
		expect(CONTROL_READ_RETRY_BUDGET_MS).toBeLessThan(ADMISSION_DECISION_TIMEOUT_MS);
	});

	it('fits the worst-case backoff sleep inside the read budget itself', () => {
		const cap = Math.max(...CONTROL_READ_RETRY_DELAYS_MS);
		const worstSleep = CONTROL_READ_RETRY_DELAYS_MS
			.map((base) => Math.min(base * 1.5, cap))
			.reduce((total, ms) => total + ms, 0);
		expect(worstSleep).toBeLessThan(CONTROL_READ_RETRY_BUDGET_MS);
	});
});

/**
 * Run `body` with `sereus:cadre:control-db` enabled and debug's sink captured, returning
 * the lines it emitted. Same helper as `control-write-retry.spec.ts`'s — namespace set and
 * sink are process-global in `debug`, so both are put back even when `body` throws.
 */
async function captureRetryLog(body: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debug.disable();
	const previousLog = debug.log;
	debug.enable('sereus:cadre:control-db');
	debug.log = function (this: unknown, ...args: unknown[]): void { lines.push(format(...args)); };
	try {
		await body();
	} finally {
		debug.log = previousLog;
		debug.disable();
		if (previousNamespaces) debug.enable(previousNamespaces);
	}
	return lines;
}

/** Test-only window onto the self-registration timer these tests must neutralize. */
function selfRegistrationTimerSlot(node: CadreNode): { selfRegistrationTimer: ReturnType<typeof setTimeout> | null } {
	return node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> | null };
}

/**
 * Test-only window onto both pacing seams, so no test waits out a real backoff. Same cast
 * pattern as `control-write-lock.spec.ts`'s `retryPacingSlot`.
 */
function pacingSlots(db: ControlDatabase): {
	controlWriteRetryPacing: ControlWriteRetryOptions;
	controlReadRetryPacing: ControlReadRetryOptions;
} {
	return db as unknown as {
		controlWriteRetryPacing: ControlWriteRetryOptions;
		controlReadRetryPacing: ControlReadRetryOptions;
	};
}

/** A read-phase transactor failure, as `control-write-lock.spec.ts` builds it. */
function transientClusterFailure(): Error {
	return new Error('Some peers did not complete: 12D3KooWpeer[block:blk-1](no-response) cause=The stream has been reset; root: The stream has been reset');
}

/** The inner Quereus `eval` surface the harness swaps out. */
type EvalFn = (sql: string, params?: unknown, opts?: unknown) => AsyncIterableIterator<Record<string, unknown>>;

/**
 * The seam driven end to end: a real `ControlDatabase` (via `CadreNode`, the cheapest way
 * to obtain an initialized one) with the inner Quereus `Database.eval` monkeypatched to
 * fail during ITERATION — the way a real transactor failure surfaces, since `readRows`'s
 * attempt is a drain, not a call. This is the inversion of the throwaway repro in the
 * ticket: the same injected failure that used to end `queryRevokedStamps` after exactly
 * one `eval` call is now absorbed on the second.
 */
describe('ControlDatabase — read retry', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	/** The owner identity for the locked-write case. */
	let owner: { publicKey: string; sign: (message: Uint8Array) => string };

	beforeAll(async () => {
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		owner = {
			publicKey: ownerPublicKey,
			sign: (message) => cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
		};

		node = new CadreNode({
			controlNetwork: { partyId: 'read-retry-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
			profile: 'transaction'
		});
		await node.start();

		// The node self-registers ~1s after start, which would land stray reads/writes
		// mid-test. Disarm it (same neutralization as control-write-lock.spec.ts).
		clearTimeout(selfRegistrationTimerSlot(node).selfRegistrationTimer ?? undefined);
		selfRegistrationTimerSlot(node).selfRegistrationTimer = null;

		const controlDatabase = node.getControlDatabase();
		expect(controlDatabase).not.toBeNull();
		db = controlDatabase!;
		await db.insertOwnerKey(ownerPublicKey);
	}, 60_000);

	afterAll(async () => {
		await node.stop();
	}, 30_000);

	/**
	 * Swap the inner `eval` for one that intercepts statements containing `sqlMarker`,
	 * returning a restore function. Non-matching statements pass through untouched, so
	 * only the read under test is rigged.
	 */
	function rigEval(
		sqlMarker: string,
		behaviour: (matchedCall: number, real: EvalFn, sql: string, params?: unknown, opts?: unknown) => AsyncIterableIterator<Record<string, unknown>>
	): { calls: () => number; restore: () => void } {
		const inner = db.getDatabase() as unknown as { eval: EvalFn };
		const realEval = inner.eval.bind(inner) as EvalFn;
		let matched = 0;
		inner.eval = (sql, params, opts) => {
			if (typeof sql === 'string' && sql.includes(sqlMarker)) {
				matched++;
				return behaviour(matched, realEval, sql, params, opts);
			}
			return realEval(sql, params, opts);
		};
		return { calls: () => matched, restore: () => { inner.eval = realEval; } };
	}

	/** An iterator that fails during iteration, the way a real transactor failure surfaces. */
	function failingIteration(error: Error): AsyncIterableIterator<Record<string, unknown>> {
		const iterator: AsyncIterableIterator<Record<string, unknown>> = {
			[Symbol.asyncIterator]() { return iterator; },
			next: () => Promise.reject(error),
		};
		return iterator;
	}

	it('absorbs one transient failure mid-iteration and answers on the second attempt', async () => {
		const slots = pacingSlots(db);
		const savedReadPacing = slots.controlReadRetryPacing;
		const rig = rigEval('from CadreControl.Revocation', (matchedCall, real, sql, params, opts) =>
			matchedCall === 1 ? failingIteration(transientClusterFailure()) : real(sql, params, opts));
		try {
			slots.controlReadRetryPacing = { sleep: () => Promise.resolve() };

			// Before this ticket the same injection rejected with the aggregate after
			// exactly ONE eval call; now the drain is re-presented and resolves.
			const revoked = await db.queryRevokedStamps('CadrePeer');

			expect(revoked).toBeInstanceOf(Set);
			expect(rig.calls()).toBe(2);
		} finally {
			rig.restore();
			slots.controlReadRetryPacing = savedReadPacing;
		}
	});

	it('surfaces a non-retriable read failure from the first attempt, unretried', async () => {
		const slots = pacingSlots(db);
		const savedReadPacing = slots.controlReadRetryPacing;
		const failure = new Error(
			'Query failed: Block blk-1 is unavailable (claimed-elsewhere): the repo could not determine whether it exists');
		const rig = rigEval('from CadreControl.Revocation', () => failingIteration(failure));
		try {
			slots.controlReadRetryPacing = { sleep: () => Promise.resolve() };

			await expect(db.queryRevokedStamps('CadrePeer')).rejects.toBe(failure);
			expect(rig.calls()).toBe(1);
		} finally {
			rig.restore();
			slots.controlReadRetryPacing = savedReadPacing;
		}
	});

	/**
	 * The no-lock-during-backoff contract: a read issued from INSIDE a locked write body
	 * (here, `insertCadrePeer`'s insert-if-absent stamp guard) must not retry on its own —
	 * its backoff would sleep holding the write lock, and the write funnel already re-runs
	 * the body's reads when it re-runs the body. With the guard's read rigged to always
	 * fail transiently, the eval count must equal the WRITE funnel's attempts exactly: one
	 * read per body run, none added by a read-side retry (which would multiply it), and the
	 * read pacing seam must never be consulted.
	 */
	it('does not retry a read inside a locked write body on its own', async () => {
		const slots = pacingSlots(db);
		const savedReadPacing = slots.controlReadRetryPacing;
		const savedWritePacing = slots.controlWriteRetryPacing;
		let readSleeps = 0;
		const rig = rigEval('select StampId from CadreControl.CadrePeer', () =>
			failingIteration(transientClusterFailure()));
		try {
			slots.controlWriteRetryPacing = { sleep: () => Promise.resolve(), now: () => 0 };
			slots.controlReadRetryPacing = { sleep: () => { readSleeps++; return Promise.resolve(); } };

			await expect(db.insertCadrePeer(
				{ peerId: 'read-retry-locked-peer', publicKey: null, multiaddr: '', updatedAt: Date.now(), sig: null },
				owner.publicKey,
				owner.sign
			)).rejects.toThrow(/Some peers did not complete/);

			expect(rig.calls()).toBe(CONTROL_WRITE_ATTEMPTS);
			expect(readSleeps).toBe(0);
		} finally {
			rig.restore();
			slots.controlReadRetryPacing = savedReadPacing;
			slots.controlWriteRetryPacing = savedWritePacing;
		}
	});

	/**
	 * The same no-lock-during-backoff contract, reached through a CALLBACK rather than a
	 * read written inside the locked body: `notifyMembershipChanged` runs the membership
	 * listener with the write lock HELD, and that listener re-materializes the gate
	 * snapshot through `queryCadrePeers`. With that scan rigged to fail transiently, the
	 * refresh must not sleep a backoff — the sleep would happen holding the lock.
	 *
	 * The write itself must still SUCCEED: the notify is best-effort and swallows its
	 * failures, keeping the previous snapshot. Asserted on the sleep counter rather than
	 * the eval count because the node's timed reconcile can also drive this read.
	 */
	it('does not retry the membership-gate refresh read the write lock is holding', async () => {
		const slots = pacingSlots(db);
		const savedReadPacing = slots.controlReadRetryPacing;
		let readSleeps = 0;
		// Narrow marker: the membership SCAN only, not insertCadrePeer's own stamp guard.
		const rig = rigEval('select PeerId, Multiaddr, StampId', () =>
			failingIteration(transientClusterFailure()));
		try {
			slots.controlReadRetryPacing = { sleep: () => { readSleeps++; return Promise.resolve(); } };

			await expect(db.insertCadrePeer(
				{ peerId: 'read-retry-notify-peer', publicKey: null, multiaddr: '', updatedAt: Date.now(), sig: null },
				owner.publicKey,
				owner.sign
			)).resolves.toBe(true);

			expect(rig.calls()).toBeGreaterThanOrEqual(1);
			expect(readSleeps).toBe(0);
		} finally {
			rig.restore();
			slots.controlReadRetryPacing = savedReadPacing;
		}
	});
});
