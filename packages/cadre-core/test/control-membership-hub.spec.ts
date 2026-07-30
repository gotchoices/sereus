import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { signPeerRecord } from '../src/peer-record.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { SeedBootstrapService } from '../src/seed-bootstrap.js';

/**
 * The `CadrePeer` membership-change hub on {@link ControlDatabase}: every committed
 * member-row write notifies one listener, so the in-memory authorized-peer snapshot
 * that gates inbound control-DB streams is refreshed BY the write instead of by
 * whichever caller remembered to ask.
 *
 * These assertions belong here rather than beside the writers because what matters is
 * the *contract* the writers share — fires once, fires only after the row is durable,
 * never fires on a failed write, never turns a listener fault into a write fault.
 * `CadreNode` is not the subject: it is only the cheapest way to obtain an initialized
 * `ControlDatabase` (the hub calls `ensureInitialized`, and initialization needs a live
 * libp2p node plus a coordinated repo).
 *
 * Post-commit ordering is asserted the only way that cannot pass vacuously: the
 * listener itself reads `CadrePeer` back and records what it saw. An insert's listener
 * must see the row; a removal's must see it gone.
 */

/** One captured notification: the reason label, and what `CadrePeer` looked like from inside. */
interface Notification {
	reason: string;
	rowPresent: boolean;
}

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

describe('ControlDatabase — CadrePeer membership-change hub', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	let service: SeedBootstrapService;
	let captured: Notification[];

	/**
	 * Record every notification, reading `CadrePeer` from inside the callback so the
	 * captured `rowPresent` proves whether the write was already committed when the
	 * listener ran.
	 */
	function captureFor(peerId: string): void {
		db.setMembershipChangeListener(async (reason) => {
			captured.push({ reason, rowPresent: (await db.queryPeerRecord(peerId)) !== null });
		});
	}

	beforeAll(async () => {
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

		node = new CadreNode({
			controlNetwork: { partyId: 'membership-hub-' + Math.random().toString(36).slice(2), bootstrapNodes: [] },
			profile: 'transaction'
		});
		await node.start();

		// The node self-registers ~1s after start, which is itself a CadrePeer insert and
		// would land stray notifications mid-test. Disarm it: the recurring refresh
		// interval is only armed once this timer fires, so killing it kills both.
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

	beforeEach(() => {
		captured = [];
		db.setMembershipChangeListener(null);
	});

	it('notifies once per owner-vouched insert, with the row already committed', async () => {
		const peer = await freshPeer();
		captureFor(peer.peerId);

		await service.authorizePeer({ peerId: peer.peerId, multiaddrs: ['/ip4/10.0.0.1/tcp/4001'] });

		expect(captured).toEqual([{ reason: 'peer-insert', rowPresent: true }]);
	});

	it('notifies after a removal commits, with the row already gone', async () => {
		const peer = await freshPeer();
		await service.authorizePeer({ peerId: peer.peerId });
		captureFor(peer.peerId);

		await service.removePeer(peer.peerId);

		expect(captured).toEqual([{ reason: 'peer-remove', rowPresent: false }]);
	});

	it('notifies on a re-authorization, which rewrites the voucher the member predicate judges', async () => {
		const peer = await freshPeer();
		await service.authorizePeer({ peerId: peer.peerId });
		captureFor(peer.peerId);

		await service.reauthorizePeer(peer.peerId, Date.now() + 1_000);

		expect(captured).toEqual([{ reason: 'peer-reauthorize', rowPresent: true }]);
	});

	it('does not notify when the removal target is already absent', async () => {
		const peer = await freshPeer();
		captureFor(peer.peerId);

		await service.removePeer(peer.peerId);
		await service.reauthorizePeer(peer.peerId, Date.now());

		expect(captured).toEqual([]);
	});

	it('does not notify on a self-signed address refresh, the one carved-out mutator', async () => {
		const peer = await freshPeer();
		await service.authorizePeer({ peerId: peer.peerId });
		captureFor(peer.peerId);

		// `updateSelfPeerRecord` is authorized by the row's OWN key, so drive it with the
		// key behind this peerId — the shape `CadreNode.publishSelfRecord` uses on refresh.
		await db.updateSelfPeerRecord(signPeerRecord(
			{ peerId: peer.peerId, publicKey: peer.publicKeyB64, addrs: ['/ip4/10.0.0.2/tcp/4001'], updatedAt: Date.now() + 1_000 },
			peer.privateKeyB64
		));

		expect(captured).toEqual([]);
	});

	it('does not notify when the mutation body throws', async () => {
		const peer = await freshPeer();
		captureFor(peer.peerId);

		await expect(db.mutateCadrePeer('probe-throw', async () => {
			throw new Error('body failed');
		})).rejects.toThrow('body failed');

		expect(captured).toEqual([]);
	});

	it('completes the write when the listener throws', async () => {
		const peer = await freshPeer();
		let listenerRan = false;
		db.setMembershipChangeListener(async () => {
			listenerRan = true;
			throw new Error('refresh exploded');
		});

		await service.authorizePeer({ peerId: peer.peerId });

		expect(listenerRan).toBe(true);
		expect(await db.queryPeerRecord(peer.peerId)).not.toBeNull();
	});

	it('holds one listener: a second replaces the first, and null clears it', async () => {
		const replaced: string[] = [];
		const winner: string[] = [];
		db.setMembershipChangeListener(async (reason) => { replaced.push(reason); });
		db.setMembershipChangeListener(async (reason) => { winner.push(reason); });

		await service.authorizePeer({ peerId: (await freshPeer()).peerId });
		expect(replaced).toEqual([]);
		expect(winner).toEqual(['peer-insert']);

		db.setMembershipChangeListener(null);
		await service.authorizePeer({ peerId: (await freshPeer()).peerId });
		expect(winner).toEqual(['peer-insert']);
	});

	it('refuses a mutation wrapped inside a caller-owned transaction', async () => {
		const inner = db.getDatabase();
		captureFor((await freshPeer()).peerId);

		await inner.beginTransaction();
		try {
			await expect(db.mutateCadrePeer('probe-enclosed', async () => undefined))
				.rejects.toThrow(/transaction is open on entry to/);
		} finally {
			await inner.rollback();
		}

		expect(captured).toEqual([]);
	});

	it('refuses a mutation body that leaves its transaction open', async () => {
		const inner = db.getDatabase();
		captureFor((await freshPeer()).peerId);

		await expect(db.mutateCadrePeer('probe-uncommitted', async () => {
			await inner.beginTransaction();
		})).rejects.toThrow(/transaction is open on return from/);
		await inner.rollback();

		expect(captured).toEqual([]);
	});
});
