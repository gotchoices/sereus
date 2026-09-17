import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * Which path a control read takes — the serialized one (waits for the database's exec
 * mutex, refreshes from the network) or the committed one (`readConcurrency:
 * 'committed'`, off the mutex, no refresh) — as decided by `ControlDatabase.readRowsOnce`.
 *
 * The defect these cases pin: a read routed on `getAutocommit()` alone could not see a
 * locked write that had started but was still WAITING for the exec mutex (its implicit
 * transaction opens only after it acquires the mutex), so the read queued behind the
 * write and answered only after the write's whole commit — tens of seconds against a
 * slow cohort member. Verified against the engine directly before the fix; the first
 * case below is that probe, driven through `ControlDatabase`.
 *
 * `CadreNode` is not the subject: it is only the cheapest way to obtain an initialized
 * `ControlDatabase` bound to a real owner key (same setup as `control-write-lock.spec.ts`).
 */

/** Test-only window onto the self-registration timer these tests must neutralize. */
function selfRegistrationTimerSlot(node: CadreNode): { selfRegistrationTimer: ReturnType<typeof setTimeout> | null } {
	return node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> | null };
}

/** The inner Quereus surface these cases patch or drive. */
type EvalFn = (sql: string, params?: unknown, opts?: unknown) => AsyncIterableIterator<Record<string, unknown>>;
type ExecFn = (sql: string, params?: unknown, opts?: unknown) => Promise<void>;
interface InnerDatabase {
	eval: EvalFn;
	exec: ExecFn;
	getAutocommit(): boolean;
}

/**
 * How long an unlocked read gets to answer while the mutex is held. An in-memory solo
 * read answers in milliseconds off the mutex; the queued read this replaces never
 * answers until the mutex is released, so any bound well above the former and short of
 * the test timeout separates the two.
 */
const UNBLOCKED_READ_MS = 2_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ControlDatabase — read routing', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	let inner: InnerDatabase;
	let owner: { publicKey: string; sign: (message: Uint8Array) => string };

	beforeAll(async () => {
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		owner = {
			publicKey: ownerPublicKey,
			sign: (message) => cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
		};

		node = new CadreNode({
			controlNetwork: { partyId: 'read-routing-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
			profile: 'transaction'
		});
		await node.start();

		// The node self-registers ~1s after start, and the recurring refresh interval is
		// armed off that timer; either would land a write mid-case and move the routing
		// under test. Disarm both (same neutralization as control-write-lock.spec.ts).
		clearTimeout(selfRegistrationTimerSlot(node).selfRegistrationTimer ?? undefined);
		selfRegistrationTimerSlot(node).selfRegistrationTimer = null;

		const controlDatabase = node.getControlDatabase();
		expect(controlDatabase).not.toBeNull();
		db = controlDatabase!;
		inner = db.getDatabase() as unknown as InnerDatabase;
		await db.insertOwnerKey(ownerPublicKey);
	}, 60_000);

	afterAll(async () => {
		await node.stop();
	}, 30_000);

	/**
	 * Record the options every inner `eval` whose SQL contains `sqlMarker` was called with,
	 * passing each call through untouched. Returns the recording and a restore function.
	 */
	function recordEvalOptions(sqlMarker: string): { options: unknown[]; restore: () => void } {
		const realEval = inner.eval;
		const options: unknown[] = [];
		inner.eval = (sql, params, opts) => {
			if (sql.includes(sqlMarker)) {
				options.push(opts);
			}
			return realEval.call(inner, sql, params, opts);
		};
		return { options, restore: () => { inner.eval = realEval; } };
	}

	/** The routing a recorded `eval` call asked for. */
	function routing(opts: unknown): 'committed' | 'serialized' {
		return (opts as { readConcurrency?: string } | undefined)?.readConcurrency === 'committed' ? 'committed' : 'serialized';
	}

	/**
	 * The defect, end to end: a serialized read holds the exec mutex, a locked control write
	 * queues on it (still reporting autocommit), and an unlocked read then arrives. It must
	 * answer while the mutex is still held rather than queue behind the write.
	 */
	it('answers an unlocked read while a locked write is still waiting for the exec mutex', async () => {
		const realExec = inner.exec;
		let reachedExec!: () => void;
		const writeReachedExec = new Promise<void>((resolve) => { reachedExec = resolve; });
		inner.exec = (sql, params, opts) => {
			if (sql.includes('insert into CadreControl.Strand')) {
				reachedExec();
			}
			return realExec.call(inner, sql, params, opts);
		};

		// Hold the mutex: a serialized read suspended after its first row keeps it.
		const holder = inner.eval('select Key from CadreControl.OwnerKey');
		let released = false;
		const release = async (): Promise<void> => {
			if (!released) {
				released = true;
				await holder.return?.();
			}
		};
		try {
			expect((await holder.next()).done).toBe(false);

			const write = db.insertStrand('read-routing-queued-write', 'o', owner.publicKey, owner.sign);
			try {
				await writeReachedExec;
				// Give exec the ticks it needs to enqueue on the mutex.
				await sleep(20);
				// The engine precondition the fix exists for: a write queued on the mutex is
				// invisible to getAutocommit(). If this flips, the counter may be redundant.
				expect(inner.getAutocommit()).toBe(true);

				const read = db.getOwnerKeys();
				const outcome = await Promise.race([
					read.then(() => 'answered' as const),
					sleep(UNBLOCKED_READ_MS).then(() => 'queued-behind-write' as const),
				]);
				expect(outcome).toBe('answered');
				expect(await read).toContain(owner.publicKey);
			} finally {
				await release();
				await write;
			}
		} finally {
			await release();
			inner.exec = realExec;
		}

		expect(await db.queryStrand('read-routing-queued-write')).not.toBeNull();
	}, 30_000);

	it('asks for a committed read while a locked body runs, before its transaction opens', async () => {
		let finishBody!: () => void;
		const bodyGate = new Promise<void>((resolve) => { finishBody = resolve; });
		let bodyStarted!: () => void;
		const bodyRunning = new Promise<void>((resolve) => { bodyStarted = resolve; });
		const write = db.withWriteLock(async () => {
			bodyStarted();
			await bodyGate;
		});
		const recorded = recordEvalOptions('select Key from CadreControl.OwnerKey');
		try {
			await bodyRunning;
			expect(inner.getAutocommit()).toBe(true);
			await db.getOwnerKeys();
		} finally {
			recorded.restore();
			finishBody();
			await write;
		}

		expect(recorded.options.map(routing)).toEqual(['committed']);
	});

	it('keeps an unlocked read on the refreshing path once the body has settled, even by throwing', async () => {
		await expect(db.withWriteLock(() => Promise.reject(new Error('body failed')))).rejects.toThrow('body failed');

		const recorded = recordEvalOptions('select Key from CadreControl.OwnerKey');
		try {
			await db.getOwnerKeys();
		} finally {
			recorded.restore();
		}

		expect(recorded.options.map(routing)).toEqual(['serialized']);
	});

	/**
	 * A read issued INSIDE a locked body is the body being counted, and its guard reads need
	 * the refreshing path: `insertCadrePeer`'s stamp guard must stay serialized even though a
	 * locked body is running when it is issued.
	 */
	it('keeps a read inside a locked write body on the refreshing path', async () => {
		const recorded = recordEvalOptions('select StampId from CadreControl.CadrePeer');
		try {
			await expect(db.insertCadrePeer(
				{ peerId: 'read-routing-locked-peer', publicKey: null, multiaddr: '', updatedAt: Date.now(), sig: null },
				owner.publicKey,
				owner.sign
			)).resolves.toBe(true);
		} finally {
			recorded.restore();
		}

		expect(recorded.options.length).toBeGreaterThanOrEqual(1);
		expect(recorded.options.map(routing).every((path) => path === 'serialized')).toBe(true);
	});
});
