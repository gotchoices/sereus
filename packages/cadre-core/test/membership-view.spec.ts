import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import { MEMBERSHIP_VIEW_MAX_AGE_MS, MembershipView } from '../src/membership-view.js';
import type { MembershipViewLoad } from '../src/membership-view.js';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * The membership rows view: a control table's rows kept in memory until the table changes.
 * The first block drives `MembershipView` through a loader the test answers by hand; the
 * second checks the wiring on a real solo `ControlDatabase`, where the table-change
 * subscription is what drops the view.
 */

/** A loader whose every load waits until the test answers it. */
function handAnsweredLoader(): {
	loader: (retry: boolean) => Promise<MembershipViewLoad<string>>;
	loads: number;
	answer: (index: number, rows: string[], installable?: boolean) => void;
} {
	const pending: Array<(load: MembershipViewLoad<string>) => void> = [];
	return {
		loader: (_retry: boolean) => new Promise<MembershipViewLoad<string>>((resolve) => { pending.push(resolve); }),
		get loads() { return pending.length; },
		answer: (index: number, rows: string[], installable = true) => pending[index]!({ rows, installable }),
	};
}

describe('MembershipView', () => {
	it('serves the installed rows to a later read without loading again', async () => {
		const table = handAnsweredLoader();
		const view = new MembershipView(table.loader);

		const first = view.read(true);
		table.answer(0, ['a']);
		expect(await first).toEqual(['a']);

		expect(await view.read(true)).toEqual(['a']);
		expect(table.loads).toBe(1);
	});

	/**
	 * The race a write and a read run: the load began before the change and finishes after it.
	 * Its callers get what it read, as an uncached read would; it installs nothing, and a read
	 * arriving after the change starts its own load rather than joining the stale one.
	 */
	it('installs nothing from a load an invalidation overtook, and starts a fresh load after it', async () => {
		const table = handAnsweredLoader();
		const view = new MembershipView(table.loader);

		const raced = view.read(true);
		view.invalidate();
		const after = view.read(true);
		expect(table.loads).toBe(2);

		// The stale load finishes last, so keeping it would overwrite the fresh rows.
		table.answer(1, ['after']);
		expect(await after).toEqual(['after']);
		table.answer(0, ['before']);
		expect(await raced).toEqual(['before']);

		expect(await view.read(true)).toEqual(['after']);
		expect(table.loads).toBe(2);
	});

	it('loads again after a load reported its rows not installable', async () => {
		const table = handAnsweredLoader();
		const view = new MembershipView(table.loader);

		const first = view.read(true);
		table.answer(0, ['provisional'], false);
		expect(await first).toEqual(['provisional']);

		const second = view.read(true);
		expect(table.loads).toBe(2);
		table.answer(1, ['full']);
		expect(await second).toEqual(['full']);
	});

	/** The bound for a change that reaches this node with no storage event. */
	it('loads again once the installed rows reach the maximum age', async () => {
		const table = handAnsweredLoader();
		let now = 1_000;
		const view = new MembershipView(table.loader, { now: () => now });

		const first = view.read(true);
		table.answer(0, ['old']);
		await first;

		now += MEMBERSHIP_VIEW_MAX_AGE_MS - 1;
		expect(await view.read(true)).toEqual(['old']);
		expect(table.loads).toBe(1);

		now += 1;
		const aged = view.read(true);
		expect(table.loads).toBe(2);
		table.answer(1, ['new']);
		expect(await aged).toEqual(['new']);
	});
});

/** Test-only window onto the self-registration timer, which would land a `CadrePeer` write mid-case. */
function selfRegistrationTimerSlot(node: CadreNode): { selfRegistrationTimer: ReturnType<typeof setTimeout> | null } {
	return node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> | null };
}

type EvalFn = (sql: string, params?: unknown, opts?: unknown) => AsyncIterableIterator<Record<string, unknown>>;

/**
 * `CadreNode` is not the subject: it is the cheapest way to obtain an initialized
 * `ControlDatabase` with an owner key (same setup as `control-read-retry.spec.ts`).
 */
describe('ControlDatabase — membership views', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	let owner: { publicKey: string; sign: (message: Uint8Array) => string };

	beforeAll(async () => {
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		owner = {
			publicKey: ownerPublicKey,
			sign: (message) => cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
		};

		node = new CadreNode({
			controlNetwork: { partyId: 'membership-view-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
			profile: 'transaction'
		});
		await node.start();
		clearTimeout(selfRegistrationTimerSlot(node).selfRegistrationTimer ?? undefined);
		selfRegistrationTimerSlot(node).selfRegistrationTimer = null;

		const controlDatabase = node.getControlDatabase();
		expect(controlDatabase).not.toBeNull();
		db = controlDatabase!;
		expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
	}, 60_000);

	afterAll(async () => {
		await node.stop();
	}, 30_000);

	/** Count the inner `eval` calls whose SQL contains `sqlMarker`, passing each through. */
	function countEvals(sqlMarker: string): { count: () => number; restore: () => void } {
		const inner = db.getDatabase() as unknown as { eval: EvalFn };
		const realEval = inner.eval;
		let count = 0;
		inner.eval = (sql, params, opts) => {
			if (sql.includes(sqlMarker)) {
				count++;
			}
			return realEval.call(inner, sql, params, opts);
		};
		return { count: () => count, restore: () => { inner.eval = realEval; } };
	}

	it('reads no storage for a repeated membership read, and sees a membership write on the next read', async () => {
		const peerId = 'membership-view-peer';
		const scans = countEvals('select PeerId, Multiaddr, StampId');
		try {
			expect((await db.queryCadrePeers()).map((row) => row.peerId)).not.toContain(peerId);
			const warmed = scans.count();
			await db.queryCadrePeers();
			expect(scans.count(), 'a second read with no change between them ran the CadrePeer scan').toBe(warmed);

			expect(await db.insertCadrePeer(
				{ peerId, publicKey: null, multiaddr: '', updatedAt: Date.now(), sig: null, profile: null },
				owner.publicKey,
				owner.sign
			)).toBe(true);

			expect((await db.queryCadrePeers()).map((row) => row.peerId)).toContain(peerId);
		} finally {
			scans.restore();
		}
	});
});
