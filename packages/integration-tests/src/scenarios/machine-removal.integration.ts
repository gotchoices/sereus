/**
 * E2E: an owner removes another owner's machine from the cadre with one call,
 * `CadreNode.removeMachine` (`docs/architecture.md` → "Removing a machine"), and every other
 * machine follows by replication.
 *
 * Machines:
 * - **A**, the founding owner, listening on a loopback WebSocket port: the remover.
 * - **M**, an always-on member pinning A's key and nothing else, admitted the owner-online way
 *   (`addDrone` plus seed delivery). Nothing on M is driven by the scenario: it follows the
 *   removal from the rows and tombstones that replicate to it, at its next membership refresh.
 * - **B**, a phone-shaped device (no listen address) that joins by redeeming an owner-granting
 *   invitation at A, so it holds a control connection to A, wires its own key as an owner and
 *   vouches C. The machine removed.
 * - **C**, a device B vouches: a bare peer id with no node, because what is asserted is the
 *   membership predicate on A and M. The dependent A keeps by re-vouching it under its own key.
 *
 * The invitation has two uses, so after B's redemption it is still live and B could redeem it
 * again; the removal withdraws it in the same transaction, and M sees it withdrawn.
 *
 * Asserted on A, before `removeMachine` returns: the one call removed B's membership row and
 * owner key, withdrew the invitation, re-vouched C, and closed B's control connection (the
 * refresh the removal notified hung it up). Asserted on M, by replication alone: B stops being
 * authorized and C stays authorized under A's voucher, the invitation is withdrawn, and M's
 * anchor drops B's key at its next refresh.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Connection } from '@libp2p/interface';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, waitUntil, randomPeerId,
	startPinningMember, admitMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment and the first sync over loopback; each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row or tombstone crossing an already-open connection. */
const OP_MS = 30_000;
/** M's control-cohort reconcile interval, the timer that runs M's membership refresh (default 15 s). */
const M_RECONCILE_MS = 2_000;
/** A tombstone M already holds reaching M's anchor: one {@link M_RECONCILE_MS} interval plus that pass. */
const REFRESH_MS = 10_000;

describe('E2E an owner removes a machine from the cadre', () => {
	it('A removes B in one call: B\'s row, owner key and invitation go, C is kept under A\'s voucher, B\'s connection closes, and M follows', async () => {
		const partyId = `machine-removal-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');
		const bKey = await generateKeyPair('Ed25519');

		let A: CadreNode | undefined;
		let M: InviteMember | undefined;
		let B: CadreNode | undefined;
		try {
			// ── A founds the cadre; M is admitted the owner-online way ──────────────
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none' }));
			await A.start();
			const owner = A;
			const aOwnerKey = await makeOwnOwner(owner, aKey);
			const aPeerId = owner.peerId!.toString();
			M = await startPinningMember(partyId, aOwnerKey, { reconcileMs: M_RECONCILE_MS });
			const member = M.node;
			await admitMember(owner, M, STARTUP_MS);

			// ── B joins at A by an owner-granting invitation with a seat to spare ────
			const { invitation } = await owner.createCadreInvitation({ grantsOwner: true, uses: 2 });
			const inviteKey = invitation.invite.key;
			B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
			await B.start();
			const removed = B;
			const bPeerId = removed.peerId!.toString();
			const bOwnerKey = ed25519KeyPairFromLibp2p(bKey).publicKeyB64;
			const joined = await removed.redeemCadreInvitation(invitation);
			expect(joined).toMatchObject({ peerId: aPeerId, grantsOwner: true });
			// A wrote B's rows itself and is the invitation's issuer, so its anchor derived B's key
			// in the refresh the redemption notified.
			expect(owner.getTrustedOwnerStore()!.sources().get(bOwnerKey)).toBe('chain');
			// B signs as an owner once its own OwnerKey row has synced to it.
			await waitUntil(() => holdsOwnerRow(removed, bOwnerKey), {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'B holds its own OwnerKey row',
			});
			expect(await removed.wireOwnKeyIfOwner()).toBe(true);

			// ── B vouches C; A and M hold the row ──────────────────────────────────
			const cPeerId = await randomPeerId();
			await removed.authorizePeer(cPeerId);
			await waitUntil(() => listsAuthorized(owner, cPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'A lists C, vouched by B, as an authorized member',
			});
			await waitUntil(async () => (await member.listMembers()).some((row) => row.peerId === cPeerId) && await holdsOwnerRow(member, bOwnerKey), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'C\'s row and B\'s owner key reach M',
			});
			expect(connectedTo(owner, bPeerId)).toBe(true);

			// ── The plan A's app would confirm ─────────────────────────────────────
			const plan = await owner.planMachineRemoval(bPeerId);
			expect(plan).toMatchObject({ refusal: null, removesOwnerKey: true, invitations: [inviteKey], ownDependency: false });
			expect(plan.machine).toMatchObject({ peerId: bPeerId, publicKey: bOwnerKey, isSelf: false, isOwner: true, isMember: true, trusted: true, vouchedBy: aOwnerKey });
			expect(plan.dependents).toEqual({ owners: [], peers: [cPeerId] });

			// ── A removes B, keeping C ──────────────────────────────────────────────
			const closed: string[] = [];
			owner.getControlNode()!.addEventListener('connection:close', (event: CustomEvent<Connection>) => {
				closed.push(event.detail.remotePeer.toString());
			});
			const removedAt = Date.now();
			const result = await owner.removeMachine(bPeerId, { revouch: { peers: [cPeerId] } });
			expect(result).toEqual({
				removedPeer: true,
				removedOwnerKey: true,
				removedDeviceToken: false,
				withdrawnInvitations: [inviteKey],
				revouched: { owners: [], peers: [cPeerId] },
			});
			// The refresh the removal notified hung B up before the call returned.
			expect(closed).toContain(bPeerId);
			expect(await listsAuthorized(owner, bPeerId)).toBe(false);
			expect(await listsAuthorized(owner, cPeerId)).toBe(true);
			expect(owner.getTrustedOwnerStore()!.has(bOwnerKey)).toBe(false);
			expect((await owner.listMachines()).map((machine) => machine.peerId)).not.toContain(bPeerId);

			// ── M follows by replication alone ─────────────────────────────────────
			await waitUntil(async () => !(await listsAuthorized(member, bPeerId)) && await listsAuthorized(member, cPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'M stops authorizing B and keeps authorizing C',
			});
			const cOnM = (await member.getControlDatabase()!.queryCadrePeers()).find((row) => row.peerId === cPeerId);
			expect(cOnM?.vouchOwner).toBe(aOwnerKey);
			await waitUntil(async () => (await member.listCadreInvitations()).find((status) => status.invite.key === inviteKey)?.withdrawn === true, {
				timeoutMs: OP_MS, intervalMs: 250, description: 'M holds the invitation\'s withdrawal',
			});
			const reachedMMs = Date.now() - removedAt;
			await waitUntil(() => !member.getTrustedOwnerStore()!.has(bOwnerKey), {
				timeoutMs: REFRESH_MS, intervalMs: 250, description: 'M\'s anchor drops B\'s key',
			});
			console.log('[machine-removal] the removal reached M after %d ms; M\'s anchor followed after %d ms', reachedMMs, Date.now() - removedAt);
		} finally {
			await Promise.allSettled([B?.stop(), M?.node.stop(), A?.stop()]);
		}
	}, 8 * STARTUP_MS);
});

/** Does `node`'s copy of `OwnerKey` hold a live row for `ownerKey`? */
async function holdsOwnerRow(node: CadreNode, ownerKey: string): Promise<boolean> {
	return (await node.getControlDatabase()!.getOwnerKeys()).has(ownerKey);
}

async function listsAuthorized(node: CadreNode, peerId: string): Promise<boolean> {
	return (await node.listAuthorizedMembers()).some((row) => row.peerId === peerId);
}

/** Does `node`'s control node hold an open connection to `peerId`, in either direction? */
function connectedTo(node: CadreNode, peerId: string): boolean {
	return node.getControlNode()!.getConnections().some((connection) => connection.remotePeer.toString() === peerId && connection.status === 'open');
}
