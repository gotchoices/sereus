/**
 * E2E: an owner grant and a cadre invitation are redeemed at a member while the owner that
 * minted them is OFFLINE (`docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any
 * Member", "Owner grants").
 *
 * Machines:
 * - **A**, the owner: phone-shaped (`listenAddrs: []`), founds the cadre. Its control storage
 *   and node-local dial-target store are kept across a stop/start, the two things a machine
 *   carries across a process restart besides its identity key; the restarted A reconnects by
 *   dialing M from that store.
 * - **M**, the only always-on member: `storage` profile, listening on WebSocket, admitted by A
 *   through `addDrone` plus seed delivery (the owner-online path), pinning A's owner key as an
 *   operator would (`--pin-owner-key`).
 * - **P**, the new device: phone-shaped (`listenAddrs: []`), started with NO pinned key — it
 *   anchors A's key from the bundle — and joins with an owner grant after A has stopped
 *   (`joinWithOwnerGrant`: the grant seats P's own owner key, then a self-invitation that key
 *   signs admits P's machine), so M writes two rows for P, each on a chain that ends at A's key.
 * - **Q**, a second device, refused with `invite-spent` once A has withdrawn a machine
 *   invitation it minted beside the grant and no one redeemed.
 *
 * Why this shape. A phone owner, one always-on member and a new device redeeming while the
 * phone is away is the household the feature exists for. M serves the redemption with a control
 * write offered to M's FRET cohort, and two facts about that cohort decide what the scenario
 * waits for:
 * - The stopped owner must have left it first; a member write made while it is still there
 *   waits on it for the whole commit budget. A's graceful stop sends M a FRET leave notice, which
 *   marks A dead at once (about 1 s measured, one poll); a phone that vanishes without one is marked
 *   dead after three probe ticks in which it could not be contacted, about 5 s. FRET ticket
 *   `fret-evicts-an-address-less-peer-that-disconnects`.
 * - M counts P in it once P's redemption verifies, so M's cohort for every control block is
 *   {M, P}, and a cohort of two commits only when both hold the write. M therefore pushes its
 *   control store to P after the request verifies and before the write (`admitDevice` on the
 *   redemption handler), and each of P's two admissions commits on the first attempt. The
 *   scenario pins that: a second attempt on either means the push did not reach P before the
 *   write.
 *
 * A listens nowhere, so the grant and the invitation name only M's addresses. The scenario
 * waits until M holds both rows before A stops.
 *
 * In the withdrawal arm M holds no live invitation, so its connection gate admits Q only
 * provisionally; the redemption exchange is answered, and refused by name, well inside the
 * provisional deadline.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode, CadreInviteRejectedError, MemoryBootstrapPeerStore } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, createTestOwnerKey, hasOutboundTo, waitUntil, captureRawStorage, readCohort,
	startPinningMember, admitMember, buildPartyDevice, waitingForMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and reconnect waits over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One request and its reply, or one row crossing an already-open connection. */
const OP_MS = 30_000;
/** How long FRET may take to evict a stopped, address-less peer from a member's cohort: its leave notice evicts it in about 1 s, the dead verdict without one in about 5 s; the margin is for a loaded machine. */
const COHORT_EVICTION_MS = 60_000;

describe('E2E owner grant and cadre invitation redeemed at a member while the owner is offline', () => {
	it('A mints a grant and an invitation, stops; P joins at the only member as a machine and an owner; A returns and sees P; the withdrawn invitation refuses Q', async () => {
		const partyId = `cadre-invite-any-member-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const aPeerId = peerIdFromPrivateKey(aKey).toString();
		const captureA = captureRawStorage();
		const aPeerStore = new MemoryBootstrapPeerStore(partyId);

		/** A's shape, the same for both incarnations: the restart reopens the same stores. */
		function buildA(): CadreNode {
			return new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none',
				listenAddrs: [], storageProvider: captureA.provider, bootstrapPeerStore: aPeerStore,
			}));
		}

		let A: CadreNode | undefined;
		let M: InviteMember | undefined;
		let P: CadreNode | undefined;
		let Q: CadreNode | undefined;
		try {
			// ── A founds the cadre; M is admitted the owner-online way ──────────────
			A = buildA();
			await A.start();
			const { publicKey: aOwnerKey, signer: aOwnerSigner } = await makeOwnOwner(A);

			M = await startPinningMember(partyId, aOwnerKey);
			const member = M;
			await admitMember(A, member, STARTUP_MS);
			// M's signed address record has to reach A before it can be named in the invitation.
			await waitUntil(async () => (await A!.resolvePeerAddrs(member.peerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches A',
			});

			// ── A mints an owner grant and an untargeted invitation, M receives both rows, A stops ──
			const { grant } = await A.createOwnerGrant();
			expect(grant.members.length).toBeGreaterThan(0);
			expect(grant.members.every((addr) => addr.endsWith(`/p2p/${member.peerId}`))).toBe(true);
			expect(grant.ownerKeys).toEqual([aOwnerKey]);
			const { invitation } = await A.createCadreInvitation();
			expect(invitation.invite.peerId).toBeNull();
			const key = invitation.invite.key;
			await waitUntil(async () => (await member.node.listOwnerGrants()).some((status) => status.grant.key === grant.grant.key && status.live)
				&& (await member.node.listCadreInvitations()).some((status) => status.invite.key === key && status.live), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the live grant and invitation rows',
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

			// ── P joins with the grant at M with the owner offline ──────────────────
			const pKey = await generateKeyPair('Ed25519');
			const pPeerId = peerIdFromPrivateKey(pKey).toString();
			const pOwner = createTestOwnerKey();
			const pOwnerKey = pOwner.publicKey;
			P = await buildPartyDevice(partyId, pKey);
			await P.start();
			const device = P;
			expect(device.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(false);
			const joinStartedAt = Date.now();
			const { result: joined, passes } = await waitingForMember(STARTUP_MS, 'any-member',
				(options) => device.joinWithOwnerGrant(grant, pOwner.signer, options));
			console.log('[any-member] P joined as a machine and an owner (at most %d pass(es) per redemption), %d ms after it first asked',
				passes, Date.now() - joinStartedAt);
			expect(passes).toBe(1);
			expect(joined).toMatchObject({ peerId: member.peerId, ownerKey: pOwnerKey, alreadyOwner: false, ownerWired: true });
			expect(device.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(true);

			// M wrote P's rows on the chain its own database holds: P is an owner there, and an
			// authorized member vouched by its own new key.
			expect(await member.node.isAuthorizedMember(pPeerId)).toBe(true);
			expect((await member.node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(pPeerId);
			expect((await member.node.getControlDatabase()!.getOwnerKeys()).has(pOwnerKey)).toBe(true);
			// M's anchor followed the row it wrote: P's key is derived there through the grant
			// chain (the membership refresh the write triggered runs the anchor sync first), under
			// `chain` provenance — M pins only A.
			await waitUntil(async () => member.node.getTrustedOwnerStore()!.sources().get(pOwnerKey) === 'chain', {
				timeoutMs: OP_MS, intervalMs: 250, description: 'M derives P\'s owner key into its anchor',
			});
			// P's control streams are admitted at M: the rows that make M a member in P's eyes
			// (A's vouch, judged against the key P just pinned) cross that connection.
			await waitUntil(async () => (await device.listAuthorizedMembers()).some((row) => row.peerId === member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'P lists M as authorized once the rows replicate',
			});
			expect(hasOutboundTo(device, member.peerId)).toBe(true);

			// ── A returns, syncs, and sees the device it never vouched for ──────────
			A = buildA();
			await A.start();
			await A.useOwnerSigner(aOwnerSigner);
			await A.reconcileControlCohort();
			await waitUntil(() => hasOutboundTo(A!, member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 250, description: 'the restarted A reconnects to M',
			});
			const ownerBackAt = Date.now();
			// A derives P's owner key from the `OwnerKey` row's stored proof, as M did: A is the
			// grant's issuer, so the chain resolves against A's own anchored key. P's machine row is
			// vouched by that key, so A lists P as a member only once the derivation has run. The
			// `OwnerKey` block reaches A by read repair, not by a push: A read it before reconnecting
			// (its first reconcile pass), so the storage layer serves the stale local revision until
			// its read-repair window (10 s) lapses, and no refresh runs on a replicated change by
			// itself. Drive a refresh per poll, as a replicated change's caller would; the timed
			// reconcile would do the same within its interval.
			const aAnchor = A.getTrustedOwnerStore()!;
			await waitUntil(async () => {
				await A!.refreshMembershipGate('replicated-owner-row');
				return aAnchor.sources().get(pOwnerKey) === 'chain' && (await A!.listAuthorizedMembers()).some((row) => row.peerId === pPeerId);
			}, { timeoutMs: STARTUP_MS, intervalMs: 1_000, description: 'A derives P\'s owner key into its anchor and lists P as an authorized member' });
			console.log('[any-member] the returning owner listed P %d ms after reconnecting to M', Date.now() - ownerBackAt);

			// ── A withdraws the invitation no one redeemed; once M holds the tombstone, Q is refused with invite-spent ──
			expect((await member.node.listCadreInvitations()).find((status) => status.invite.key === key)?.live).toBe(true);
			expect(await A.withdrawCadreInvitation(key)).toBe(true);
			await waitUntil(async () => (await member.node.listCadreInvitations()).find((status) => status.invite.key === key)?.withdrawn === true, {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the withdrawal tombstone',
			});
			Q = await buildPartyDevice(partyId);
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
