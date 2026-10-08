/**
 * E2E: a cadre invitation is redeemed at a member while the owner that minted it is OFFLINE
 * (`docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member").
 *
 * Machines:
 * - **A**, the owner: founds the cadre and listens on a loopback WebSocket port. Its control
 *   storage and node-local dial-target store are kept across a stop/start, the two things a
 *   machine carries across a process restart besides its identity key.
 * - **M**, the only always-on member: `storage` profile, listening on WebSocket, admitted by A
 *   through `addDrone` plus seed delivery (the owner-online path), pinning A's owner key as an
 *   operator would (`--pin-owner-key`).
 * - **P**, the new device: phone-shaped (`listenAddrs: []`), started with NO pinned key — it
 *   anchors A's key from the bundle — and redeems an untargeted, owner-granting invitation
 *   after A has stopped.
 * - **Q**, a second device, refused with `invite-spent` once A has withdrawn the invitation.
 *
 * Why this shape. The redemption at the only always-on member while the owner is away is the
 * one the feature exists for. M serves it with a control write offered to M's FRET cohort, and
 * two facts about that cohort decide what the scenario waits for:
 * - The stopped owner must have left it first. A member evicts a stopped peer only after
 *   repeated failed contacts, and a peer with no address cannot be contacted at all, so A is
 *   given a listen address (evicted in about 5 s); an address-less, phone-shaped owner stays in
 *   the cohort and every write waits on it. Ticket `phone-owner-never-leaves-members-cohort`.
 * - P joins it the moment P connects to redeem, so M's cohort for every control block is
 *   {M, P}, and a cohort of two commits only when both hold the write. M therefore pushes its
 *   control store to P after the request verifies and before the write (`catchUpDevice` on the
 *   redemption handler), and the admission commits on the first attempt. The scenario pins
 *   that: a second attempt means the push did not reach P before the write.
 *
 * The invitation names A's own address first and then M's; A is stopped when P redeems, so
 * P's first dial fails and it moves on. The scenario waits until M holds the invitation's row
 * before A stops.
 *
 * In the withdrawal arm M holds no live invitation, so its connection gate admits Q only
 * provisionally; the redemption exchange is answered, and refused by name, well inside the
 * provisional deadline.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
	CadreNode, CadreInviteRejectedError, CadreInviteUnreachableError, MemoryBootstrapPeerStore, ed25519KeyPairFromLibp2p,
	type CadreInvitation, type RedeemCadreInvitationResult,
} from '@serfab/cadre-core';
import type { PrivateKey } from '@libp2p/interface';
import {
	controlNodeConfig, makeOwnOwner, controlAddrs, hasOutboundTo, waitUntil, captureRawStorage, readCohort,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and reconnect waits over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One request and its reply, or one row crossing an already-open connection. */
const OP_MS = 30_000;
/** How long FRET may take to evict a stopped, addressable peer from a member's cohort (about 5 s measured). */
const COHORT_EVICTION_MS = 60_000;
/** Pause between a device's redemption attempts while the member answers retryably. */
const REDEEM_RETRY_PAUSE_MS = 2_000;

interface Member { node: CadreNode; peerId: string }

/**
 * What a device does with a retryable outcome: try again after a pause, until `budgetMs` is
 * spent. The scenario pins one attempt; retrying anyway turns a regression into a count of
 * the attempts the member needed rather than a failure at the first retryable refusal.
 */
async function redeemWithRetry(device: CadreNode, invitation: CadreInvitation, budgetMs: number): Promise<{ joined: RedeemCadreInvitationResult; attempts: number }> {
	const deadline = Date.now() + budgetMs;
	for (let attempts = 1; ; attempts++) {
		try {
			return { joined: await device.redeemCadreInvitation(invitation), attempts };
		} catch (err) {
			if (!(err instanceof CadreInviteUnreachableError) || Date.now() + REDEEM_RETRY_PAUSE_MS > deadline) throw err;
			console.log('[any-member] attempt %d answered retryably: %s', attempts, err.message);
			await new Promise<void>((resolve) => setTimeout(resolve, REDEEM_RETRY_PAUSE_MS));
		}
	}
}

describe('E2E cadre invitation redeemed at a member while the owner is offline', () => {
	it('A mints, stops; P joins at the only member as an owner; A returns and sees P; a withdrawn invitation refuses Q', async () => {
		const partyId = `cadre-invite-any-member-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const aPeerId = peerIdFromPrivateKey(aKey).toString();
		const captureA = captureRawStorage();
		const aPeerStore = new MemoryBootstrapPeerStore(partyId);

		/** A's shape, the same for both incarnations: the restart reopens the same stores. */
		function buildA(): CadreNode {
			return new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none',
				storageProvider: captureA.provider, bootstrapPeerStore: aPeerStore,
			}));
		}
		function buildDevice(key: PrivateKey): CadreNode {
			return new CadreNode(controlNodeConfig({ partyId, privateKey: key, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
		}
		/** An always-on member, pinning A's key, with the seed handler `cadre start --listen-for-seeds` registers. */
		async function startMember(aOwnerKey: string): Promise<Member> {
			const key = await generateKeyPair('Ed25519');
			const node = new CadreNode(controlNodeConfig({
				partyId, privateKey: key, profile: 'storage', strandFilter: 'none', pinnedOwnerKeys: [aOwnerKey],
			}));
			await node.start();
			await node.enableSeedListener();
			return { node, peerId: peerIdFromPrivateKey(key).toString() };
		}
		/** The owner-online path: A vouches the member, delivers the seed, and dials it from the retained address. */
		async function admitMember(owner: CadreNode, member: Member): Promise<void> {
			const addrs = controlAddrs(member.node);
			const { seed } = await owner.addDrone({ dronePeerId: member.peerId, droneMultiaddrs: addrs });
			expect((await owner.deliverSeed(addrs[0]!, seed)).accepted).toBe(true);
			await owner.reconcileControlCohort();
			await waitUntil(() => hasOutboundTo(owner, member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: `A holds an outbound control connection to ${member.peerId}`,
			});
		}

		let A: CadreNode | undefined;
		let M: Member | undefined;
		let P: CadreNode | undefined;
		let Q: CadreNode | undefined;
		try {
			// ── A founds the cadre; M is admitted the owner-online way ──────────────
			A = buildA();
			await A.start();
			const aOwnerKey = await makeOwnOwner(A, aKey);

			M = await startMember(aOwnerKey);
			const member = M;
			await admitMember(A, member);
			// M's signed address record has to reach A before it can be named in the invitation.
			await waitUntil(async () => (await A!.resolvePeerAddrs(member.peerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches A',
			});

			// ── A mints an untargeted owner-granting invitation, M receives its row, A stops ──
			const { invitation } = await A.createCadreInvitation({ grantsOwner: true });
			expect(invitation.invite.peerId).toBeNull();
			expect(invitation.members[0]).toBe(A.getMultiaddrs()[0]);
			expect(invitation.members.some((addr) => addr.endsWith(`/p2p/${member.peerId}`))).toBe(true);
			expect(invitation.ownerKeys).toEqual([aOwnerKey]);
			const key = invitation.invite.key;
			await waitUntil(async () => (await member.node.listCadreInvitations()).some((status) => status.invite.key === key && status.live), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the live invitation row',
			});
			await A.stop();
			A = undefined;
			// "Offline" from M's side means A has left M's CONTROL COHORT, not merely its
			// connection list (see the file header).
			const ownerLeftAt = Date.now();
			await waitUntil(async () => !(await readCohort(member.node.getControlNode()!, member.peerId)).includes(aPeerId), {
				timeoutMs: COHORT_EVICTION_MS, intervalMs: 1_000, description: 'the stopped owner leaves M\'s control cohort',
			});
			console.log('[any-member] the stopped owner left M\'s control cohort after %d ms', Date.now() - ownerLeftAt);

			// ── P redeems at M with the owner offline ──────────────────────────────
			const pKey = await generateKeyPair('Ed25519');
			const pPeerId = peerIdFromPrivateKey(pKey).toString();
			P = buildDevice(pKey);
			await P.start();
			expect(P.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(false);
			const redeemStartedAt = Date.now();
			const { joined, attempts } = await redeemWithRetry(P, invitation, STARTUP_MS);
			console.log('[any-member] P was admitted on attempt %d, %d ms after it first asked', attempts, Date.now() - redeemStartedAt);
			expect(attempts).toBe(1);
			expect(joined.peerId).toBe(member.peerId);
			expect(joined.grantsOwner).toBe(true);
			expect(P.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(true);

			// M wrote P's rows on the chain its own database holds: P is an authorized member and
			// an owner there.
			expect(await member.node.isAuthorizedMember(pPeerId)).toBe(true);
			expect((await member.node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(pPeerId);
			expect((await member.node.getControlDatabase()!.getOwnerKeys()).has(ed25519KeyPairFromLibp2p(pKey).publicKeyB64)).toBe(true);
			// P's control streams are admitted at M: the rows that make M a member in P's eyes
			// (A's vouch, judged against the key P just pinned) cross that connection.
			await waitUntil(async () => (await P!.listAuthorizedMembers()).some((row) => row.peerId === member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'P lists M as authorized once the rows replicate',
			});
			expect(hasOutboundTo(P, member.peerId)).toBe(true);

			// ── A returns, syncs, and sees the device it never vouched for ──────────
			A = buildA();
			await A.start();
			await A.initializeSeedBootstrap(ed25519KeyPairFromLibp2p(aKey).privateKeyB64);
			await A.reconcileControlCohort();
			await waitUntil(() => hasOutboundTo(A!, member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'the restarted A reconnects to M',
			});
			const ownerBackAt = Date.now();
			// A is the issuer, so the chain P's row carries resolves against A's own anchored key.
			await waitUntil(async () => (await A!.listAuthorizedMembers()).some((row) => row.peerId === pPeerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'A lists P as an authorized member after syncing',
			});
			console.log('[any-member] the returning owner listed P %d ms after reconnecting to M', Date.now() - ownerBackAt);

			// ── A withdraws; once M holds the tombstone, Q is refused with invite-spent ──
			expect(await A.withdrawCadreInvitation(key)).toBe(true);
			await waitUntil(async () => (await member.node.listCadreInvitations()).find((status) => status.invite.key === key)?.withdrawn === true, {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the withdrawal tombstone',
			});
			Q = buildDevice(await generateKeyPair('Ed25519'));
			await Q.start();
			const refusal: unknown = await Q.redeemCadreInvitation(invitation).catch((err: unknown) => err);
			expect(refusal).toBeInstanceOf(CadreInviteRejectedError);
			expect(refusal).toMatchObject({ code: 'invite-spent', retryable: false });
			expect(await member.node.isAuthorizedMember(Q.peerId!.toString())).toBe(false);
		} finally {
			await Promise.allSettled([Q?.stop(), P?.stop(), A?.stop(), M?.node.stop()]);
		}
	}, 8 * STARTUP_MS);
});
