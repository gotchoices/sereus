import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { peerIdFromEd25519PublicKeyB64 } from '../src/ed25519-key.js';
import type { JoinedStrandSession } from '../src/joined-strand-store.js';
import { softwareOwnerSigner, type OwnerSigner, type OwnerSigningRequest } from '../src/owner-signer.js';
import type { FormStrandResult } from '../src/types.js';
import { freshKeyPair, signAs, type KeyPair } from './control-constraint-helpers.js';
import { newUnstartedNode } from './self-owner-node-helpers.js';
import { signedSApp } from './signed-sapp.js';

/**
 * A node wired with an owner key that is NOT its identity key signs every owner write with that
 * key: the seed bootstrap's writes and the node's own (strands, invitations, approver keys, join
 * requests, the party-wide joined-strand row) alike. Before the node took one owner signer, the
 * second group signed with the identity key, which the schema refuses for a party whose owner is
 * another key.
 *
 * The approval count pins the seam contract a prompting backend depends on: one owner action,
 * one `approve`, however many rows it signs.
 */
describe('CadreNode signs every owner write through the one signer it was given', () => {
	let node: CadreNode;
	let db: ControlDatabase;
	let owner: KeyPair;
	const approvals: OwnerSigningRequest[] = [];
	let signatures = 0;

	/** `inner`, recording each approval it is asked for and each signature made inside one. */
	function countingSigner(inner: OwnerSigner): OwnerSigner {
		return {
			publicKey: inner.publicKey,
			approve: (request, body) => {
				approvals.push(request);
				return inner.approve(request, (sign) => body(async (message) => {
					signatures += 1;
					return await sign(message);
				}));
			},
		};
	}

	function resetCounts(): void {
		approvals.length = 0;
		signatures = 0;
	}

	const rand = () => Math.random().toString(36).slice(2);

	/** The peer id behind an Ed25519 public key (never null for one). */
	function peerIdOf(key: KeyPair): string {
		const peerId = peerIdFromEd25519PublicKeyB64(key.publicKey);
		expect(peerId).not.toBeNull();
		return peerId!;
	}

	beforeAll(async () => {
		({ node } = await newUnstartedNode('owner-signer-'));
		await node.start();
		db = node.getControlDatabase()!;
		owner = freshKeyPair();
		expect(owner.publicKey).not.toBe(node.getIdentityOwnerKey().publicKeyB64);
		expect(await db.ensureOwnerKey(owner.publicKey)).toBe(true);
		await node.useOwnerSigner(countingSigner(softwareOwnerSigner(owner.privateKey)));
	}, 60_000);

	afterAll(async () => {
		await node?.stop();
	});

	it('founds strands, publishes invitations, enrolls approvers, records joins and mints seeds under the owner key', async () => {
		expect(await node.isOwner()).toBe(true);

		const founded = await node.foundStrand({ strandId: 'founded-' + rand(), type: 'o', sAppConfig: signedSApp() });
		expect(founded.founded).toBe(true);
		expect(founded.strandRow.FounderOwnerKey).toBe(owner.publicKey);

		const token = 'invite-' + rand();
		await node.publishFormationInvite(token, 'sapp-owner-signer');
		expect(await db.queryFormationInvite(token)).not.toBeNull();

		const approver = freshKeyPair();
		await node.enrollValidationKey(approver.publicKey);
		expect(await node.listValidationKeys()).toContain(approver.publicKey);

		// The formation dial is stubbed: the join request, its outcome and the joined-strand row
		// are the owner writes under test, not the wire.
		const joinedId = 'joined-' + rand();
		const formed: FormStrandResult = { memberKey: 'joiner-member-key', invitePrivateKey: '', strandId: joinedId, strandAddrs: [] };
		node.getStrandSolicitationService()!.formStrand = async () => formed;
		const status = await node.requestJoin({
			token: 'join-token-' + rand(),
			sAppId: 'sapp-joined',
			expiration: new Date(Date.now() + 3600_000),
			bootstrap: ['/ip4/127.0.0.1/tcp/1'],
		});
		expect(status.state).toBe('joined');
		expect((await db.queryPendingJoin(status.id))?.outcome?.kind).toBe('joined');
		// A solo node publishes its joins party-wide on its connected reconcile pass; run that step.
		await (node as unknown as { joinedStrands: JoinedStrandSession }).joinedStrands.syncWithParty();
		expect(await db.queryJoinedStrand(joinedId)).not.toBeNull();

		const peerId = peerIdOf(freshKeyPair());
		await node.authorizePeer(peerId);
		expect((await node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(peerId);
		const seed = await node.createSeed();
		expect(seed.signerKey).toBe(owner.publicKey);
		expect(node.getSeedBootstrapService()!.validateSeedSignature(seed)).toBe(true);

		expect(approvals.every((request) => request.partyId === node.partyId)).toBe(true);
	}, 120_000);

	it('asks once for an action that signs several rows', async () => {
		const strandId = 'closed-' + rand();
		await node.publishStrand(strandId, 'c', 'closed-read-secret');
		expect(await db.queryStrandPartyKey(strandId)).not.toBeNull();

		resetCounts();
		await node.unpublishStrand(strandId);
		expect(approvals).toHaveLength(1);
		// The strand and its party key, each deleted with its tombstone.
		expect(signatures).toBe(4);
		expect(await db.queryStrand(strandId)).toBeNull();

		// A second owner machine that vouched a device: removing the machine re-vouches the device
		// under this node's key, then removes the machine's row and owner key.
		const machine = freshKeyPair();
		const machinePeerId = peerIdOf(machine);
		await node.addOwner(machine.publicKey);
		await node.authorizePeer(machinePeerId);
		const device = freshKeyPair();
		const devicePeerId = peerIdOf(device);
		const deviceRow = { peerId: devicePeerId, publicKey: device.publicKey, multiaddr: '', updatedAt: Date.now(), sig: null, profile: null };
		expect(await db.insertCadrePeer(deviceRow, machine.publicKey, (message) => signAs(machine, message))).toBe(true);

		resetCounts();
		const result = await node.removeMachine(machinePeerId, { revouch: { peers: [devicePeerId] } });
		expect(result).toMatchObject({ removedPeer: true, removedOwnerKey: true, revouched: { owners: [], peers: [devicePeerId] } });
		expect(approvals).toHaveLength(1);
		expect(signatures).toBeGreaterThan(1);
	}, 120_000);
});
