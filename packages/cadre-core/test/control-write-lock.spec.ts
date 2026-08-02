import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generatePrivateKey, getPublicKey, sign as cryptoSign } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { signPeerRecord } from '../src/peer-record.js';
import type { ControlDatabase, MembershipChangeListener } from '../src/control-database.js';
import type { SeedBootstrapService } from '../src/seed-bootstrap.js';
import type { ControlWriteRetryOptions } from '../src/control-write-retry.js';

/**
 * `ControlDatabase`'s local write lock: every public writer runs through
 * {@link ControlDatabase.withWriteLock}, so two callers that write the same database
 * instance concurrently are serialized rather than interleaved.
 *
 * This matters because the underlying Quereus database has ONE transaction, not one per
 * caller. Unserialized, a second writer's `begin` lands inside the first's open
 * transaction and the pair commits as one torn unit — or trips
 * `assertCommitBoundary`. That is a real failure this repo hit from the
 * `strand-addr-seed-convergence` integration scenario; these cases reduce it to units so
 * a regression fails in ~1s instead of ~10s of full mesh bring-up.
 *
 * Concurrency here means "started in the same tick without awaiting the first". Every
 * writer reaches its `withWriteLock` call synchronously, so call order IS queue order —
 * the races below are deterministic, not timing-dependent.
 *
 * `CadreNode` is not the subject: it is only the cheapest way to obtain an initialized
 * `ControlDatabase` plus a `SeedBootstrapService` bound to a real owner key.
 */

/** A fresh Ed25519 peer identity: the PeerId plus the base64url key pair behind it. */
async function freshPeer(): Promise<{ peerId: string; publicKeyB64: string; privateKeyB64: string }> {
	const key = await generateKeyPair('Ed25519');
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	return { peerId: peerIdFromPrivateKey(key).toString(), publicKeyB64, privateKeyB64 };
}

/** Test-only window onto the self-registration timer these tests must neutralize. */
function selfRegistrationTimerSlot(node: CadreNode): { selfRegistrationTimer: ReturnType<typeof setTimeout> | null } {
	return node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> | null };
}

/**
 * Test-only window onto `lockedWithRetry`'s pacing seams, so the retry tests never wait
 * out a real backoff. Same cast pattern as {@link selfRegistrationTimerSlot}.
 */
function retryPacingSlot(db: ControlDatabase): { controlWriteRetryPacing: ControlWriteRetryOptions } {
	return db as unknown as { controlWriteRetryPacing: ControlWriteRetryOptions };
}

/**
 * An error text `isRetriableControlWriteFailure` classifies as transient — the transactor's
 * "the cohort did not answer" aggregate, in its read/pend-phase shape (per-batch details name
 * a SINGLE block, `[block:<id>]`; the commit-phase `[blocks:<count>]` shape is deliberately
 * NOT retried). A literal here (rather than a real cluster failure) because these tests pin
 * LOCK interaction, not classification; the classifier table lives in
 * `control-write-retry.spec.ts`.
 */
function transientClusterFailure(): Error {
	return new Error('Some peers did not complete: 12D3KooWpeer[block:blk-1](no-response) cause=The stream has been reset; root: The stream has been reset');
}

describe('ControlDatabase — local write lock', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	let service: SeedBootstrapService;
	/** The owner identity behind `service`, for the tests that drive `db` directly. */
	let owner: { publicKey: string; sign: (message: Uint8Array) => string };

	beforeAll(async () => {
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		owner = {
			publicKey: ownerPublicKey,
			sign: (message) => cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string,
		};

		node = new CadreNode({
			controlNetwork: { partyId: 'write-lock-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
			profile: 'transaction'
		});
		await node.start();

		// The node self-registers ~1s after start, which is itself a CadrePeer insert and
		// would land stray rows mid-test. Disarm it: the recurring refresh interval is only
		// armed once this timer fires, so killing it kills both.
		clearTimeout(selfRegistrationTimerSlot(node).selfRegistrationTimer ?? undefined);
		selfRegistrationTimerSlot(node).selfRegistrationTimer = null;

		const controlDatabase = node.getControlDatabase();
		expect(controlDatabase).not.toBeNull();
		db = controlDatabase!;
		await db.insertOwnerKey(ownerPublicKey);
		node.initializeSeedBootstrap(ownerPrivateKey);
		const seedService = node.getSeedBootstrapService();
		expect(seedService).not.toBeNull();
		service = seedService!;
	}, 60_000);

	afterAll(async () => {
		await node.stop();
	}, 30_000);

	/**
	 * The lock's core contract, asserted directly on `withWriteLock` because no real writer
	 * can pin it: every control write is a fast in-memory statement, so a unit-scale race
	 * between two of them usually completes the first before the second starts and passes
	 * whether or not the lock exists. A body that spans a timer forces the overlap the
	 * production race hits by accident.
	 */
	it('runs locked bodies one at a time, in call order', async () => {
		const events: string[] = [];
		const slow = db.withWriteLock(async () => {
			events.push('slow-enter');
			await new Promise((resolve) => setTimeout(resolve, 20));
			events.push('slow-exit');
		});
		const quick = db.withWriteLock(async () => {
			events.push('quick-enter');
			events.push('quick-exit');
		});

		await Promise.all([slow, quick]);

		expect(events).toEqual(['slow-enter', 'slow-exit', 'quick-enter', 'quick-exit']);
	});

	it('lands both rows when two strand inserts race', async () => {
		const [a, b] = ['race-strand-a', 'race-strand-b'];

		await Promise.all([
			db.insertStrand(a, 'o', owner.publicKey, owner.sign),
			db.insertStrand(b, 'o', owner.publicKey, owner.sign),
		]);

		expect(await db.queryStrand(a)).not.toBeNull();
		expect(await db.queryStrand(b)).not.toBeNull();
	});

	/**
	 * The scenario failure reduced to a unit. `mutateCadrePeer` spans begin/exec/commit, so
	 * two of them in flight at once put the second's `begin` inside the first's open
	 * transaction — `assertCommitBoundary` throws `transaction is open on entry to` before
	 * the row is even attempted. A bare `execWrite` joins the race to cover the mixed
	 * shape, where the loose statement would otherwise commit as part of someone else's
	 * transaction.
	 */
	it('serializes transactional peer mutations against each other and against a bare write', async () => {
		const [first, second] = await Promise.all([freshPeer(), freshPeer()]);

		await Promise.all([
			service.authorizePeer({ peerId: first.peerId, multiaddrs: ['/ip4/10.0.0.1/tcp/4001'] }),
			db.insertStrand('race-strand-vs-peer', 'o', owner.publicKey, owner.sign),
			service.authorizePeer({ peerId: second.peerId, multiaddrs: ['/ip4/10.0.0.2/tcp/4001'] }),
		]);

		expect(await db.queryStrand('race-strand-vs-peer')).not.toBeNull();
		expect(await db.queryPeerRecord(first.peerId)).not.toBeNull();
		expect(await db.queryPeerRecord(second.peerId)).not.toBeNull();
	});

	/**
	 * Both first-row writers for the SAME peer, raced. The lock serializes them and the
	 * loser's in-lock existence check turns its insert into a no-op, so exactly one row
	 * lands and neither call throws a UNIQUE violation. Which one wins decides whether the
	 * row carries the peer's self-signature, and `insertSelfPeerRecord` reports which it was.
	 */
	it('keeps one row when self-publish wins the race against authorize, retaining the self signature', async () => {
		const peer = await freshPeer();
		const record = signPeerRecord(
			{ peerId: peer.peerId, publicKey: peer.publicKeyB64, addrs: ['/ip4/10.0.0.3/tcp/4001'], updatedAt: Date.now() },
			peer.privateKeyB64
		);
		const before = await db.countRows('CadrePeer');

		const [inserted] = await Promise.all([
			service.insertSelfPeerRecord(record),
			service.authorizePeer({ peerId: peer.peerId }),
		]);

		expect(inserted).toBe(true);
		expect(await db.countRows('CadrePeer')).toBe(before + 1);
		expect((await db.queryPeerRecord(peer.peerId))?.sig).toBe(record.sig);
	});

	/**
	 * The mirror ordering. `authorizePeer` cannot produce the peer's self-signature, so when
	 * it wins the seat the row is `Sig`-null and the self-publish's insert no-ops rather than
	 * filling it in — at THIS layer the record simply does not land, which is why
	 * `insertSelfPeerRecord` returns `false` instead of `void`.
	 *
	 * NOTE: this spec pins the lock/uniqueness contract only. Recovery from the lost race —
	 * `CadreNode.publishSelfRecord` seeing that `false` and falling through to a self-UPDATE
	 * so the row resolves without waiting for the next heartbeat — is covered in
	 * `peer-record-resolution.spec.ts` ("carries a valid self-signature when an authorize
	 * lands mid-publish"). Do not read the empty `sig` below as the end-to-end behaviour.
	 */
	it('keeps one row when authorize wins the race against self-publish, leaving the signature unset', async () => {
		const peer = await freshPeer();
		const record = signPeerRecord(
			{ peerId: peer.peerId, publicKey: peer.publicKeyB64, addrs: ['/ip4/10.0.0.4/tcp/4001'], updatedAt: Date.now() },
			peer.privateKeyB64
		);
		const before = await db.countRows('CadrePeer');

		const [, inserted] = await Promise.all([
			service.authorizePeer({ peerId: peer.peerId }),
			service.insertSelfPeerRecord(record),
		]);

		expect(inserted).toBe(false);
		expect(await db.countRows('CadrePeer')).toBe(before + 1);
		expect((await db.queryPeerRecord(peer.peerId))?.sig).toBe('');
	});

	/**
	 * A failed write must not poison the queue: the lock chains behind its tail regardless
	 * of how that tail settled, so the next writer still runs and still gets its own
	 * result. Only the rejecting caller sees the rejection.
	 */
	it('keeps serving writes after a locked body rejects', async () => {
		const failing = db.withWriteLock(async () => {
			throw new Error('body failed');
		});
		const following = db.insertStrand('race-strand-after-failure', 'o', owner.publicKey, owner.sign);

		await expect(failing).rejects.toThrow('body failed');
		await expect(following).resolves.toBeUndefined();
		expect(await db.queryStrand('race-strand-after-failure')).not.toBeNull();
	});

	/**
	 * The property the "retry wraps the lock" shape buys: `lockedWithRetry`'s backoff
	 * sleeps with NO lock held, so a writer queued behind a transiently-failed write runs
	 * DURING the backoff instead of stalling behind it. Deterministic, no real waiting:
	 * the injected sleep parks the first writer on a manually-released promise, and the
	 * second writer must complete while it is parked.
	 */
	it('lets a queued write run while an earlier write sleeps out its retry backoff', async () => {
		const slot = retryPacingSlot(db);
		const savedPacing = slot.controlWriteRetryPacing;
		try {
			let signalSleepEntered!: () => void;
			const sleepEntered = new Promise<void>((resolve) => { signalSleepEntered = resolve; });
			let releaseSleep!: () => void;
			const parked = new Promise<void>((resolve) => { releaseSleep = resolve; });
			slot.controlWriteRetryPacing = {
				sleep: () => { signalSleepEntered(); return parked; },
			};

			let bodyRuns = 0;
			const retried = db.mutateCadrePeer('retry-backoff-test', async () => {
				bodyRuns++;
				if (bodyRuns === 1) {
					throw transientClusterFailure();
				}
			});

			await sleepEntered;
			// First writer is parked in its backoff with the lock RELEASED — a write queued
			// now must commit without waiting for the retry to resume.
			await db.insertStrand('strand-during-backoff', 'o', owner.publicKey, owner.sign);
			expect(await db.queryStrand('strand-during-backoff')).not.toBeNull();
			expect(bodyRuns).toBe(1);

			releaseSleep();
			await retried;
			expect(bodyRuns).toBe(2);
		} finally {
			slot.controlWriteRetryPacing = savedPacing;
		}
	});

	/**
	 * `mutateCadrePeer`'s notify sits INSIDE the retried body, so the count must track
	 * committed mutations, not attempts: exactly one notification when a retried body
	 * eventually commits, zero when every attempt fails. The exhaustion arm also pins that
	 * the LAST error surfaces by identity, unwrapped, through the whole
	 * `mutateCadrePeer` → `lockedWithRetry` stack.
	 */
	it('notifies membership once for a retried mutation and never on exhaustion', async () => {
		const slot = retryPacingSlot(db);
		const savedPacing = slot.controlWriteRetryPacing;
		const listenerSlot = db as unknown as { membershipListener: MembershipChangeListener | null };
		const savedListener = listenerSlot.membershipListener;
		let notifications = 0;
		try {
			slot.controlWriteRetryPacing = { sleep: () => Promise.resolve() };
			db.setMembershipChangeListener(async () => { notifications++; });

			let bodyRuns = 0;
			await db.mutateCadrePeer('retry-notify-once', async () => {
				bodyRuns++;
				if (bodyRuns === 1) {
					throw transientClusterFailure();
				}
			});
			expect(bodyRuns).toBe(2);
			expect(notifications).toBe(1);

			const exhausted = transientClusterFailure();
			await expect(db.mutateCadrePeer('retry-notify-never', async () => {
				throw exhausted;
			})).rejects.toBe(exhausted);
			expect(notifications).toBe(1);
		} finally {
			db.setMembershipChangeListener(savedListener);
			slot.controlWriteRetryPacing = savedPacing;
		}
	});
});
