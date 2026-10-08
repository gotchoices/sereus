/**
 * E2E: a cadre invitation is redeemed at a member that never received the invitation's row,
 * because the owner minted it while cut off from that member and then went offline
 * (`docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member").
 *
 * Machines, as in `cadre-invite-any-member`:
 * - **A**, the owner, on a loopback WebSocket listen address, so M's FRET evicts it once it
 *   stops. A test connection gater (`peerDialGate({ inbound: true })`) lets the scenario cut
 *   A off from M in both directions.
 * - **M**, a storage-profile member admitted by A (`addDrone` plus seed delivery), pinning A's
 *   owner key.
 * - **P**, a phone-shaped device with no pinned key.
 *
 * What it pins. M holds no `CadreInvite` row for the invitation, so the first write of the
 * exchange is M seating the row from the bundle. P joins M's control cohort when it connects,
 * so that seat is offered to {M, P}, and P can hold it only once M has pushed it the control
 * store. M therefore pushes before the seat, judging the invitation live on the bundle's copy
 * (`CadreInviteHandler.catchUpDeviceIfLive`). The scenario expects the redemption to succeed on
 * the first attempt. With the seat ahead of the push, the first attempt was refused retryably
 * (`internal`, about 20 s in) and P joined on the second.
 *
 * An earlier invitation, minted while A and M are connected, gives M the `CadreInvite`
 * collection, which the cadre's first invitation creates. Without it the seat creates the
 * collection's blocks from nothing, a write P needs no prior blocks for, and the order the
 * scenario pins is not exercised: it passed on the first attempt with the seat ahead of the push.
 *
 * Minting while cut off. A's mint must commit with A alone, so the scenario waits until A's
 * control cohort no longer includes M (A's FRET evicts M after failed contacts) before minting.
 *
 * A does not come back: its local-only `CadreInvite` write and M's seat of the same row are two
 * histories of one collection, which is `forked-control-collection-sync-livelocks`'s defect,
 * not this scenario's subject.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, connectionsTo, waitUntil, readCohort, peerDialGate, captureRawStorage, awaitBlockCoverage,
	startPinningMember, admitMember, redeemWithRetry, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and reconnect waits over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One connection draining after a hang-up. */
const OP_MS = 30_000;
/** How long FRET may take to evict a stopped or unreachable addressable peer from a cohort (about 5 s measured). */
const COHORT_EVICTION_MS = 60_000;

describe('E2E cadre invitation redeemed at a member that never held the row', () => {
	it('A mints while cut off from M and stops; P joins at M on the first attempt, M seating the row from the bundle', async () => {
		const partyId = `cadre-invite-row-unreplicated-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const aPeerId = peerIdFromPrivateKey(aKey).toString();
		const gateA = peerDialGate({ inbound: true });
		const captureA = captureRawStorage();
		const captureM = captureRawStorage();

		let A: CadreNode | undefined;
		let M: InviteMember | undefined;
		let P: CadreNode | undefined;
		try {
			// ── A founds the cadre; M is admitted the owner-online way and converges ──
			A = new CadreNode(controlNodeConfig({
				partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none', connectionGater: gateA.gater,
				storageProvider: captureA.provider,
			}));
			await A.start();
			const aOwnerKey = await makeOwnOwner(A, aKey);
			M = await startPinningMember(partyId, aOwnerKey, { storageProvider: captureM.provider });
			const member = M;
			await admitMember(A, member, STARTUP_MS);
			// M names A's key in its OwnerKey table (the seat's issuer check reads it) and lists A
			// as a member; A holds M's signed address record, which the invitation names.
			await waitUntil(async () => (await member.node.getControlDatabase()!.getOwnerKeys()).has(aOwnerKey)
				&& (await member.node.listAuthorizedMembers()).some((row) => row.peerId === aPeerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M holds A\'s owner key and lists A as a member',
			});
			await waitUntil(async () => (await A!.resolvePeerAddrs(member.peerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches A',
			});
			// An earlier invitation, minted while connected, so M already holds the `CadreInvite`
			// collection; the seat below then writes to blocks M holds and P does not.
			const { invitation: earlier } = await A.createCadreInvitation({ grantsOwner: false });
			await waitUntil(async () => (await member.node.listCadreInvitations()).some((status) => status.invite.key === earlier.invite.key), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the earlier invitation\'s row',
			});
			await awaitBlockCoverage(captureA.control(), captureM.control(), {
				timeoutMs: STARTUP_MS, description: 'the peer-join catch-up lands every block A holds on M',
			});

			// ── Cut A off from M in both directions ─────────────────────────────────
			gateA.deny(member.peerId);
			await A.getControlNode()!.hangUp(peerIdFromString(member.peerId));
			await waitUntil(() => connectionsTo(A!, member.peerId).length === 0 && connectionsTo(member.node, aPeerId).length === 0, {
				timeoutMs: OP_MS, intervalMs: 250, description: 'neither A nor M holds a connection to the other',
			});
			await waitUntil(async () => !(await readCohort(A!.getControlNode()!, 'A')).includes(member.peerId), {
				timeoutMs: COHORT_EVICTION_MS, intervalMs: 1_000, description: 'M leaves A\'s control cohort',
			});

			// ── A mints; the row stays on A ─────────────────────────────────────────
			const { invitation } = await A.createCadreInvitation({ grantsOwner: true });
			const key = invitation.invite.key;
			expect(invitation.members[0]).toBe(A.getMultiaddrs()[0]);
			expect(invitation.members.some((addr) => addr.endsWith(`/p2p/${member.peerId}`))).toBe(true);

			// ── A stops and leaves M's cohort; M does not hold the row ──────────────
			// M is asked only once A has left its cohort, so the read is not waiting on the
			// unreachable A for the `CadreInvite` blocks A advanced while cut off.
			await A.stop();
			A = undefined;
			await waitUntil(async () => !(await readCohort(member.node.getControlNode()!, member.peerId)).includes(aPeerId), {
				timeoutMs: COHORT_EVICTION_MS, intervalMs: 1_000, description: 'the stopped owner leaves M\'s control cohort',
			});
			expect(await member.node.getControlDatabase()!.queryCadreInvite(key)).toBeNull();

			// ── P redeems at M, which seats the row from the bundle ─────────────────
			const pKey = await generateKeyPair('Ed25519');
			const pPeerId = peerIdFromPrivateKey(pKey).toString();
			P = new CadreNode(controlNodeConfig({ partyId, privateKey: pKey, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
			await P.start();
			const redeemStartedAt = Date.now();
			const { joined, attempts } = await redeemWithRetry(P, invitation, STARTUP_MS, 'row-unreplicated');
			console.log('[row-unreplicated] P was admitted on attempt %d, %d ms after it first asked', attempts, Date.now() - redeemStartedAt);
			expect(attempts).toBe(1);
			expect(joined.peerId).toBe(member.peerId);
			expect(joined.grantsOwner).toBe(true);
			expect(P.getTrustedOwnerStore()!.has(aOwnerKey)).toBe(true);

			// M seated the bundle's row and wrote P's rows on it.
			expect(await member.node.getControlDatabase()!.queryCadreInvite(key)).toEqual(invitation.invite);
			expect(await member.node.isAuthorizedMember(pPeerId)).toBe(true);
			expect((await member.node.getControlDatabase()!.getOwnerKeys()).has(ed25519KeyPairFromLibp2p(pKey).publicKeyB64)).toBe(true);
			// P holds M's control tables: the push before the seat landed, and the rows that make M
			// a member in P's eyes (A's vouch, judged against the key P pinned) read there.
			expect(await P.getControlDatabase()!.queryCadreInvite(key)).toEqual(invitation.invite);
			await waitUntil(async () => (await P!.listAuthorizedMembers()).some((row) => row.peerId === member.peerId), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'P lists M as authorized',
			});
		} finally {
			await Promise.allSettled([P?.stop(), A?.stop(), M?.node.stop()]);
		}
	}, 8 * STARTUP_MS);
});
