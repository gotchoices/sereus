/**
 * E2E: an app joins a cadre by invitation in the two ways one app hands an invitation to
 * another (`docs/architecture.md` → "Handing an invitation from app to app"), the first while
 * no always-on machine is up.
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
 * 1. **Targeted.** B copies a join request; A decodes it and mints an owner-granting
 *    invitation for B's peer id (`reach` is `local-network`: M is named only on loopback), and
 *    stops. M stops too. B redeems with `waitForMember`; once a pass has found no member
 *    answering, M restarts on the same address and a later pass is accepted. B wires its key
 *    (`wireOwnKeyIfOwner`) and its owner-signed `JoinedStrand` row reaches M.
 * 2. **Open.** B, now an owner, mints an untargeted owner-granting invitation; C decodes and
 *    redeems it, wires its key, and its owner-signed write reaches M.
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
import type { PrivateKey } from '@libp2p/interface';
import {
	CadreNode, decodeCadreInvitation, decodeCadreJoinRequest, encodeCadreJoinRequest,
	type CadreJoinProgress,
} from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, waitUntil, captureRawStorage, sameListenAddr,
	startPinningMember, admitMember, redeemWaitingForMember, type InviteMember,
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

/** A phone-shaped device for `partyId`: no listen address, no owner genesis. */
function buildDevice(partyId: string, key: PrivateKey): CadreNode {
	return new CadreNode(controlNodeConfig({ partyId, privateKey: key, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
}

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

describe('E2E an app joins a cadre by invitation', () => {
	it('targeted: B waits for M and joins as an owner; open: C joins as an owner from B\'s invitation', async () => {
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

			// ── Targeted: B asks, A mints for B's peer id and goes away, M goes down ──
			const bKey = await generateKeyPair('Ed25519');
			const bPeerId = peerIdFromPrivateKey(bKey).toString();
			B = buildDevice(partyId, bKey);
			await B.start();
			const asked = decodeCadreJoinRequest(encodeCadreJoinRequest({ v: 1, peerId: B.peerId!.toString(), appName: 'B' }));
			const targeted = await A.createCadreInvitation({ peerId: asked.peerId, grantsOwner: true });
			expect(targeted.invitation.invite.peerId).toBe(bPeerId);
			expect(targeted.reach).toBe('local-network');
			const targetedKey = targeted.invitation.invite.key;
			const member = M;
			await waitUntil(async () => (await member.node.listCadreInvitations()).some((status) => status.invite.key === targetedKey && status.live), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the targeted invitation\'s row',
			});
			await A.stop();
			A = undefined;
			const mListenAddr = sameListenAddr(member.node);
			await member.node.stop();
			M = undefined;

			// ── B waits; M comes back; a later pass is accepted ────────────────────
			const waits: Array<Extract<CadreJoinProgress, { state: 'waiting' }>> = [];
			const joining = redeemWaitingForMember(B, decodeCadreInvitation(targeted.encoded), WAIT_FOR_MEMBER_MS, 'targeted',
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
			expect(joined.grantsOwner).toBe(true);
			expect(await B.wireOwnKeyIfOwner()).toBe(true);
			await ownerWriteReaches(B, restarted, `joined-by-b-${runTag}`);

			// ── Open: B, now an owner, invites C ──────────────────────────────────
			await waitUntil(async () => (await B!.resolvePeerAddrs(mPeerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches B',
			});
			const open = await B.createCadreInvitation({ grantsOwner: true });
			expect(open.invitation.invite.peerId).toBeNull();
			expect(open.reach).toBe('local-network');
			const cKey = await generateKeyPair('Ed25519');
			C = buildDevice(partyId, cKey);
			await C.start();
			const { joined: cJoined } = await redeemWaitingForMember(C, decodeCadreInvitation(open.encoded), STARTUP_MS, 'open');
			expect(cJoined.peerId).toBe(mPeerId);
			expect(cJoined.grantsOwner).toBe(true);
			expect(await C.wireOwnKeyIfOwner()).toBe(true);
			await ownerWriteReaches(C, restarted, `joined-by-c-${runTag}`);
		} finally {
			await Promise.allSettled([C?.stop(), B?.stop(), A?.stop(), M?.node.stop()]);
		}
	}, 12 * STARTUP_MS);
});
