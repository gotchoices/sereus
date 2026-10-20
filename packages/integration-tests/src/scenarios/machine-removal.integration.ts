/**
 * E2E: an owner removes another owner's machine from the cadre with one call,
 * `CadreNode.removeMachine`, then that owner's key with another, `CadreNode.removeOwner`, keeping
 * the device the key vouched (`docs/architecture.md` → "Removing a machine", "Removing an owner
 * key"), and every other machine follows by replication.
 *
 * Machines:
 * - **A**, the founding owner, listening on a loopback WebSocket port: the remover.
 * - **M**, an always-on member pinning A's key and nothing else, admitted the owner-online way
 *   (`addDrone` plus seed delivery). Nothing on M is driven by the scenario: it follows the
 *   removal from the rows and tombstones that replicate to it, at its next membership refresh.
 * - **B**, a phone-shaped device (no listen address) that joins by redeeming a machine
 *   invitation at A, so it holds a control connection to A, then becomes an owner by redeeming an
 *   owner grant A minted — locally, as a live member: B writes its own `OwnerKey` row and A and M
 *   follow by replication — wires that key and vouches C. The machine removed, and the owner key
 *   removed after it.
 * - **C**, a device B's key vouches: a bare peer id with no node, because what is asserted is the
 *   membership predicate on A and M. The dependent A keeps by re-vouching it under its own key.
 *
 * The invitation has two uses, so after B's redemption it is still live and B could redeem it
 * again; the removal withdraws it in the same transaction, and M sees it withdrawn.
 *
 * Asserted on A, before `removeMachine` returns: the one call removed B's membership row,
 * withdrew the invitation and closed B's control connection (the refresh the removal notified
 * hung it up), and left B's owner key trusted, so C stays authorized. Then, before `removeOwner`
 * returns: B's key is gone from A's anchor and C is re-vouched under A's key. Asserted on M, by
 * replication alone: B stops being authorized and C stays authorized under A's voucher, the
 * invitation is withdrawn, and M's anchor drops B's key at its next refresh.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Connection } from '@libp2p/interface';
import { CadreNode } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, createTestOwnerKey, waitUntil, randomPeerId,
	startPinningMember, admitMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment and the first sync over loopback; each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row or tombstone crossing an already-open connection. */
const OP_MS = 30_000;
/**
 * M's control-cohort reconcile backstop (default 2 minutes). M's membership gate refreshes
 * within 50 ms of a replicated row or tombstone reaching its storage; this bounds the case
 * where no storage event does.
 */
const M_RECONCILE_MS = 2_000;
/** A tombstone M already holds reaching M's anchor: the gate refresh its arrival starts, or at most one {@link M_RECONCILE_MS} backstop plus that pass. */
const REFRESH_MS = 10_000;

describe('E2E an owner removes a machine from the cadre', () => {
	it('A removes machine B, then B\'s owner key keeping C: B\'s row and invitation go, its connection closes, C is kept under A\'s voucher, and M follows', async () => {
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
			const { publicKey: aOwnerKey } = await makeOwnOwner(owner);
			const aPeerId = owner.peerId!.toString();
			M = await startPinningMember(partyId, aOwnerKey, { reconcileMs: M_RECONCILE_MS });
			const member = M.node;
			await admitMember(owner, M, STARTUP_MS);

			// ── B joins at A by an invitation with a seat to spare, then redeems a grant ──
			const { invitation } = await owner.createCadreInvitation({ uses: 2 });
			const inviteKey = invitation.invite.key;
			const { grant } = await owner.createOwnerGrant();
			B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction', listenAddrs: [], strandFilter: 'none' }));
			await B.start();
			const removed = B;
			const bPeerId = removed.peerId!.toString();
			const bOwner = createTestOwnerKey();
			const bOwnerKey = bOwner.publicKey;
			const joined = await removed.redeemCadreInvitation(invitation);
			expect(joined.peerId).toBe(aPeerId);
			expect(await removed.isOwner()).toBe(false);
			// B's own row is waited for, not assumed: B starts its address publish at once, and a
			// control read made while a write runs can predate the row (`cadre-invite-row-unreplicated`).
			// The grant's local path needs it, since it is what makes B a live member in its own eyes.
			await waitUntil(async () => (await removed.getControlDatabase()!.queryCadrePeers()).some((row) => row.peerId === bPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'B reads its own CadrePeer row',
			});
			expect(await removed.redeemOwnerGrant(grant, bOwner.signer)).toEqual({ ownerKey: bOwnerKey, alreadyOwner: false, memberPeerId: null });
			expect(await removed.wireOwnKeyIfOwner(bOwner.signer)).toBe(true);
			// A is the grant's issuer, so it derives B's key from the replicated row's stored proof at
			// its next membership refresh; a replicated row raises none, so drive one per poll, as
			// `cadre-invite-any-member` does for a returning owner.
			await waitUntil(async () => {
				await owner.refreshMembershipGate('replicated-owner-row');
				return owner.getTrustedOwnerStore()!.sources().get(bOwnerKey) === 'chain';
			}, { timeoutMs: OP_MS, intervalMs: 500, description: 'A derives B\'s owner key into its anchor' });

			// ── B vouches C; A and M hold the row ──────────────────────────────────
			const cPeerId = await randomPeerId();
			await removed.authorizePeer(cPeerId);
			await waitUntil(() => listsAuthorized(owner, cPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'A lists C, vouched by B, as an authorized member',
			});
			await waitUntil(async () => (await member.listMembers()).some((row) => row.peerId === cPeerId) && await holdsOwnerRow(member, bOwnerKey), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'C\'s row and B\'s owner key reach M',
			});
			// M's anchor derives B's key at its timed refresh, so its drop below is a change, not a vacuity.
			await waitUntil(() => member.getTrustedOwnerStore()!.sources().get(bOwnerKey) === 'chain', {
				timeoutMs: REFRESH_MS, intervalMs: 250, description: 'M derives B\'s owner key into its anchor',
			});
			expect(connectedTo(owner, bPeerId)).toBe(true);

			// ── A removes machine B; B's owner key, and so C, stay ──────────────────
			// B's first publish of its own address record rewrites its row. A removal that races it
			// fails as a concurrent modification, which the control-write retry does not re-run
			// (`tickets/backlog/bug-owner-write-racing-a-machines-own-publish-fails`), so let it land
			// first. `registerSelf` joins that publish when it is in flight, or makes it.
			await waitUntil(async () => (await removed.registerSelf()) !== 'skipped', {
				timeoutMs: OP_MS, intervalMs: 250, description: 'B publishes its own address record',
			});
			const machinePlan = await owner.planMachineRemoval(bPeerId);
			expect(machinePlan).toMatchObject({ refusal: null, invitations: [inviteKey] });
			expect(machinePlan.machine).toMatchObject({ peerId: bPeerId, isSelf: false, trusted: true, vouchedBy: aOwnerKey });
			const closed: string[] = [];
			owner.getControlNode()!.addEventListener('connection:close', (event: CustomEvent<Connection>) => {
				closed.push(event.detail.remotePeer.toString());
			});
			const removedAt = Date.now();
			expect(await owner.removeMachine(bPeerId)).toEqual({ removedPeer: true, removedDeviceToken: false, withdrawnInvitations: [inviteKey] });
			// The refresh the removal notified hung B up before the call returned.
			expect(closed).toContain(bPeerId);
			expect(await listsAuthorized(owner, bPeerId)).toBe(false);
			expect(owner.getTrustedOwnerStore()!.has(bOwnerKey)).toBe(true);
			expect(await listsAuthorized(owner, cPeerId)).toBe(true);
			expect((await owner.listMachines()).map((machine) => machine.peerId)).not.toContain(bPeerId);

			// ── A removes B's owner key, keeping C ─────────────────────────────────
			const keyPlan = await owner.planOwnerKeyRemoval(bOwnerKey);
			expect(keyPlan).toMatchObject({ refusal: null, dependents: { owners: [], peers: [cPeerId] }, ownDependency: false });
			expect(keyPlan.ownerKey).toMatchObject({ key: bOwnerKey, vouchedBy: aOwnerKey, heldHere: false, trusted: true });
			expect(await owner.removeOwner(bOwnerKey, { revouch: { peers: [cPeerId] } })).toEqual({ removed: true, revouched: { owners: [], peers: [cPeerId] } });
			expect(owner.getTrustedOwnerStore()!.has(bOwnerKey)).toBe(false);
			expect(await listsAuthorized(owner, cPeerId)).toBe(true);

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
			console.log('[machine-removal] both removals reached M after %d ms; M\'s anchor followed after %d ms', reachedMMs, Date.now() - removedAt);
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
