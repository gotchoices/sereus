import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { OptimysticNode } from '@optimystic/db-p2p';
import { buildAuthorizationMessage, ControlDatabase } from '../src/control-database.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { expectConstraintFailure, freshKeyPair, peerIdOf, signAs, type KeyPair } from './control-constraint-helpers.js';
import { createControlNode, freshPartyId } from './control-db-node-helpers.js';

/**
 * The two control tables a machine removal's key rotation rests on, against one real engine:
 * `StrandPeer`, which only the machine it names can sign, and `PendingStrandPartyKey`, guarded
 * as `StrandPartyKey` is.
 */
describe('StrandPeer and PendingStrandPartyKey', () => {
	const partyId = freshPartyId('strand-peer');
	const owner = freshKeyPair();
	const signAsOwner = (message: Uint8Array): string => signAs(owner, message);
	let machine: KeyPair;
	let node: OptimysticNode;
	let db: ControlDatabase;

	beforeAll(async () => {
		const identity = await generateKeyPair('Ed25519');
		const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(identity);
		machine = { privateKey: privateKeyB64, publicKey: publicKeyB64 };
		node = await createControlNode(partyId, new MemoryRawStorage(), identity);
		db = new ControlDatabase({ partyId, libp2pNode: node, coordinatedRepo: node.coordinatedRepo });
		await db.initialize();
		expect(await db.ensureOwnerKey(owner.publicKey)).toBe(true);
	}, 60_000);

	afterAll(async () => {
		try {
			await db?.close();
		} finally {
			await node?.stop();
		}
	});

	/** Seat a `CadrePeer` row for `peerId` holding `publicKey`, under the owner's voucher. */
	const seatMachine = (peerId: string, publicKey: string): Promise<boolean> =>
		db.insertCadrePeer({ peerId, publicKey, multiaddr: '', updatedAt: Date.now(), sig: null, profile: null }, owner.publicKey, signAsOwner);

	it('StrandPeer: a row needs the signature of the machine it names, against that machine\'s CadrePeer row', async () => {
		const row = { strandId: 'strand-signed', strandPeerId: peerIdOf(freshKeyPair()) };
		const signAsMachine = (message: Uint8Array): string => signAs(machine, message);

		// The machine's own row has not reached this node yet.
		await expectConstraintFailure(db.insertStrandPeer(row, signAsMachine), 'Authorized');

		expect(await seatMachine(node.peerId.toString(), machine.publicKey)).toBe(true);
		await expectConstraintFailure(db.insertStrandPeer(row, (message) => signAs(freshKeyPair(), message)), 'Authorized');

		expect(await db.insertStrandPeer(row, signAsMachine)).toBe(true);
		expect(await db.queryStrandPeers(row.strandId)).toMatchObject([{ ...row, peerId: node.peerId.toString() }]);

		// Insert-if-absent: a repeat finds the stored row and signs nothing.
		expect(await db.insertStrandPeer(row, () => { throw new Error('a repeat must not sign'); })).toBe(false);
	});

	it('StrandPeer: a row signed by a key other than the one behind its peer id does not read back', async () => {
		// The schema checks the stored CadrePeer.PublicKey, which an owner's row may set to anything.
		const claimed = freshKeyPair();
		const rogue = freshKeyPair();
		const peerId = peerIdOf(claimed);
		const strandId = 'strand-forged';
		const strandPeerId = peerIdOf(freshKeyPair());
		expect(await seatMachine(peerId, rogue.publicKey)).toBe(true);

		const message = buildAuthorizationMessage('CadreControl.StrandPeer', 'add', partyId, [strandId, peerId, strandPeerId]);
		await db.getDatabase().exec(
			'insert into CadreControl.StrandPeer (StrandId, PeerId, StrandPeerId, Sig) values (?, ?, ?, ?)',
			[strandId, peerId, strandPeerId, signAs(rogue, message)]
		);

		expect(await db.queryStrandPeers(strandId)).toEqual([]);
	});

	it('PendingStrandPartyKey: inserts under an owner, and a tombstoned delete retires its stamp', async () => {
		const strandId = 'strand-pending';
		const key = await generateStrandMemberKey();
		const replaced = [freshKeyPair().publicKey, freshKeyPair().publicKey];

		await expectConstraintFailure(
			db.insertPendingStrandPartyKey(strandId, key, [], owner.publicKey, (message) => signAs(freshKeyPair(), message)),
			'AuthorizedInsert'
		);
		await db.insertPendingStrandPartyKey(strandId, key, replaced, owner.publicKey, signAsOwner);
		const pending = await db.queryPendingStrandPartyKey(strandId);
		expect(pending).toMatchObject({ privateKey: key, superseded: replaced });
		expect(await db.queryPendingStrandPartyKeyStampId(strandId)).toBe(pending!.stampId);

		expect(await db.deletePendingStrandPartyKey(strandId, owner.publicKey, signAsOwner)).toBe(true);
		expect(await db.queryPendingStrandPartyKey(strandId)).toBeNull();

		// The first insert's approval, replayed verbatim.
		const superseded = replaced.join(',');
		const approval = signAsOwner(buildAuthorizationMessage('CadreControl.PendingStrandPartyKey', 'add', partyId, [strandId, key, superseded, pending!.stampId]));
		await expectConstraintFailure(
			db.getDatabase().exec(
				`insert into CadreControl.PendingStrandPartyKey (Id, PrivateKey, Superseded, StampId)
					with context OwnerKey = ?, Signature = ?
					values (?, ?, ?, ?)`,
				[owner.publicKey, approval, strandId, key, superseded, pending!.stampId]
			),
			'NotRevoked'
		);
	});
});
