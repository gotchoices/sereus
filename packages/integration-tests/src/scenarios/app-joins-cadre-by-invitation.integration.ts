/**
 * E2E: an app joins a cadre with the two credentials an owner mints, a machine invitation and
 * an owner grant, in the two ways one app hands a credential to another (`docs/architecture.md`
 * → "Handing an invitation from app to app", "Owner grants"), the first while no always-on
 * machine is up.
 *
 * Machines:
 * - **A**, the owner: phone-shaped (`listenAddrs: []`), founds the cadre.
 * - **M**, the one always-on member: `storage` profile on a loopback WebSocket address,
 *   admitted by A (`addDrone` plus seed delivery), pinning A's owner key. Its raw storage and
 *   identity are kept so it can stop and restart on the same address.
 * - **B**, phone-shaped, a fresh identity started for A's party with no owner genesis.
 * - **C**, a second phone-shaped device.
 *
 * Arms, in one test so they share A and M:
 * 1. **Targeted.** B copies a join request; A decodes it and mints a machine invitation for B's
 *    peer id (`reach` is `local-network`: M is named only on loopback) and an owner grant, and
 *    stops. M stops too. B redeems the invitation with `waitForMember`; once a pass has found no
 *    member answering, M restarts on the same address and a later pass is accepted. B is a
 *    member and not an owner. B then redeems the grant with a key of its own — locally, as a
 *    live member with a control connection to M — wires the key (`wireOwnKeyIfOwner`), and its
 *    owner-signed `JoinedStrand` row reaches M.
 * 2. **Open.** B, now an owner, mints an owner grant; C decodes and joins with it
 *    (`joinWithOwnerGrant`: a machine and an owner at once, the key wired by the call), and its
 *    owner-signed write reaches M.
 *
 * M is stopped rather than left out of the invitation so the waiting pass is a real one: the
 * dial of every address the invitation names is refused, which is what a phone sees while the
 * household's always-on machine is off. A stops before M, and neither comes back while B
 * waits, so M's restarted control cohort never includes the absent owner (the reason
 * `cadre-invite-any-member` waits for the owner to leave M's cohort).
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	CadreNode, decodeCadreInvitation, decodeOwnerGrant, decodeCadreJoinRequest, encodeCadreJoinRequest,
	type CadreJoinProgress,
} from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, createTestOwnerKey, waitUntil, captureRawStorage, sameListenAddr,
	startPinningMember, admitMember, buildPartyDevice, redeemWaitingForMember, waitingForMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and reconnect waits over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row crossing an already-open connection. */
const OP_MS = 30_000;
/**
 * B's whole wait in the targeted arm: the pass that finds M down, M's restart, and passes paced
 * 5 s, 10 s, 20 s apart. Several restarts' worth, so a slow machine fails on an assertion, not here.
 */
const WAIT_FOR_MEMBER_MS = 5 * STARTUP_MS;

/**
 * Write an owner-signed `JoinedStrand` row from `device` with the owner signer it wired, as the
 * party ledger signs it, and wait until `member` holds it: a write the device could make only as
 * an owner.
 */
async function ownerWriteReaches(device: CadreNode, member: InviteMember, strandId: string): Promise<void> {
	const signer = device.getOwnerSigner()!;
	await signer.approve({ partyId: device.partyId, action: `Record ${strandId} as joined` }, (sign) =>
		device.getControlDatabase()!.insertJoinedStrand({ Id: strandId, Type: 'o', MemberPrivateKey: null }, signer.publicKey, sign));
	await waitUntil(async () => (await member.node.getControlDatabase()!.queryJoinedStrand(strandId)) !== null, {
		timeoutMs: OP_MS, intervalMs: 500, description: `M holds ${strandId}`,
	});
}

describe('E2E an app joins a cadre by invitation and by owner grant', () => {
	it('targeted: B waits for M, joins as a member and is made an owner by a grant; open: C joins as a machine and an owner with B\'s grant', async () => {
		const runTag = Date.now();
		const partyId = `app-joins-cadre-by-invitation-${runTag}`;
		const aKey = await generateKeyPair('Ed25519');
		const captureM = captureRawStorage();

		let A: CadreNode | undefined;
		let M: InviteMember | undefined;
		let B: CadreNode | undefined;
		let C: CadreNode | undefined;
		try {
			// ── A founds the cadre; M is admitted the owner-online way ──────────────
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none', listenAddrs: [] }));
			await A.start();
			const { publicKey: aOwnerKey } = await makeOwnOwner(A);
			M = await startPinningMember(partyId, aOwnerKey, { storageProvider: captureM.provider });
			const mKey = M.key;
			const mPeerId = M.peerId;
			await admitMember(A, M, STARTUP_MS);
			// M's signed address record has to reach A before A can name it in an invitation.
			await waitUntil(async () => (await A!.resolvePeerAddrs(mPeerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches A',
			});

			// ── Targeted: B asks, A mints for B's peer id and a grant, goes away; M goes down ──
			const bKey = await generateKeyPair('Ed25519');
			const bPeerId = peerIdFromPrivateKey(bKey).toString();
			B = await buildPartyDevice(partyId, bKey);
			await B.start();
			const device = B;
			const asked = decodeCadreJoinRequest(encodeCadreJoinRequest({ v: 1, peerId: device.peerId!.toString(), appName: 'B' }));
			const targeted = await A.createCadreInvitation({ peerId: asked.peerId });
			expect(targeted.invitation.invite.peerId).toBe(bPeerId);
			expect(targeted.reach).toBe('local-network');
			const targetedKey = targeted.invitation.invite.key;
			const bGrant = await A.createOwnerGrant({ label: 'B' });
			const bGrantKey = bGrant.grant.grant.key;
			const member = M;
			await waitUntil(async () => (await member.node.listCadreInvitations()).some((status) => status.invite.key === targetedKey && status.live)
				&& (await member.node.listOwnerGrants()).some((status) => status.grant.key === bGrantKey && status.live), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the targeted invitation\'s row and the grant\'s',
			});
			await A.stop();
			A = undefined;
			const mListenAddr = sameListenAddr(member.node);
			await member.node.stop();
			M = undefined;

			// ── B waits; M comes back; a later pass is accepted ────────────────────
			const waits: Array<Extract<CadreJoinProgress, { state: 'waiting' }>> = [];
			const joining = redeemWaitingForMember(device, decodeCadreInvitation(targeted.encoded), WAIT_FOR_MEMBER_MS, 'targeted',
				(progress) => { if (progress.state === 'waiting') waits.push(progress); });
			await waitUntil(() => waits.some((wait) => wait.reason === 'no-member-answered'), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'B reports a pass on which no member answered',
			});
			const waitingSince = Date.now();
			M = await startPinningMember(partyId, aOwnerKey, { key: mKey, listenAddrs: [mListenAddr], storageProvider: captureM.provider });
			const restarted = M;
			const { joined, passes } = await joining;
			console.log('[targeted] B was admitted on pass %d, %d ms after M began restarting', passes, Date.now() - waitingSince);
			expect(passes).toBeGreaterThan(1);
			expect(joined.peerId).toBe(mPeerId);
			// The invitation admitted a machine and nothing else.
			expect(await device.isOwner()).toBe(false);

			// ── B, a live member, redeems the grant locally with a key of its own ──
			// B's own row is waited for, not assumed: B starts its address publish at once, and a
			// control read made while a write runs can predate the row (`cadre-invite-row-unreplicated`).
			// The grant's local path needs it, since it is what makes B a live member in its own eyes.
			await waitUntil(async () => (await device.getControlDatabase()!.queryCadrePeers()).some((row) => row.peerId === bPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'B reads its own CadrePeer row',
			});
			const bOwner = createTestOwnerKey();
			const seated = await device.redeemOwnerGrant(decodeOwnerGrant(bGrant.encoded), bOwner.signer, { waitForMember: true });
			expect(seated).toEqual({ ownerKey: bOwner.publicKey, alreadyOwner: false, memberPeerId: null });
			expect(await device.wireOwnKeyIfOwner(bOwner.signer)).toBe(true);
			await ownerWriteReaches(device, restarted, `joined-by-b-${runTag}`);

			// ── Open: B, now an owner, mints a grant and C joins with it ───────────
			await waitUntil(async () => (await device.resolvePeerAddrs(mPeerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches B',
			});
			const open = await device.createOwnerGrant({ label: 'C' });
			expect(open.reach).toBe('local-network');
			// C checks M's reply against the grant's pins, so the grant's issuer (B's key) is among them.
			expect(open.grant.ownerKeys).toContain(bOwner.publicKey);
			C = await buildPartyDevice(partyId);
			await C.start();
			const second = C;
			const cOwner = createTestOwnerKey();
			const { result: cJoined } = await waitingForMember(STARTUP_MS, 'open',
				(options) => second.joinWithOwnerGrant(decodeOwnerGrant(open.encoded), cOwner.signer, options));
			expect(cJoined).toMatchObject({ peerId: mPeerId, ownerKey: cOwner.publicKey, alreadyOwner: false, ownerWired: true });
			expect(await second.isOwner()).toBe(true);
			await ownerWriteReaches(second, restarted, `joined-by-c-${runTag}`);
		} finally {
			await Promise.allSettled([C?.stop(), B?.stop(), A?.stop(), M?.node.stop()]);
		}
	}, 12 * STARTUP_MS);
});
