/**
 * E2E: an owner grant makes a key an owner with no machine admitted (`docs/architecture.md` →
 * "Owner grants").
 *
 * Machines:
 * - **O**, the owner: phone-shaped (`buildPhoneOwner`: no listen address, a 2 s control-cohort
 *   reconcile), its own genesis owner key. Online throughout.
 * - **M**, the only always-on member: `storage` profile, listening on WebSocket, admitted by O
 *   the owner-online way, pinning O's key and nothing else. O listens nowhere, so M's addresses
 *   are the only ones the grant names.
 * - **H**, the holder: a node started in the party on an empty store, never admitted, standing
 *   for whatever holds a hardware key. It redeems the grant over `/sereus/owner-grant/1.0.0`
 *   with a fresh key unrelated to its peer id, and never redeems a machine invitation.
 * - **H2**, a second holder with another key, refused once the single use is spent.
 *
 * Why this shape. A grant seats the key its holder brings and nothing else, so what the
 * scenario checks is the `OwnerKey` row M wrote (its label, its voucher) and the absence of
 * any machine row for H. M pins only O, so M trusting the new key means M derived it from the
 * grant chain (`chain` provenance), and O, which did not write the row, derives it the same
 * way once the row replicates and its next membership refresh runs (the gate watch's, within
 * 50 ms of the row reaching O's storage, or a reconcile pass's; no refresh is driven here). H is a stranger to M, so M's connection gate admits it only
 * provisionally (a live grant does not open the stranger window an invitation does); the
 * exchange completes well inside the provisional deadline, which this scenario therefore does
 * not exercise. M pushes its control store to H and counts H in its write cohort before the
 * write, so the write commits on the first pass; the scenario pins that.
 */

import { describe, it, expect } from 'vitest';
import { OwnerGrantRejectedError, type CadreNode, type CadreOwnerKey } from '@serfab/cadre-core';
import {
	buildPhoneOwner, makeOwnOwner, createTestOwnerKey, waitUntil, machinePeerIds,
	startPinningMember, admitMember, buildPartyDevice, waitingForMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and the redemption's passes over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row crossing an already-open connection, then a 2 s timed refresh. */
const OP_MS = 30_000;

describe('E2E owner grant redeemed by a holder with no machine in the cadre', () => {
	it('O mints a single-use grant; H seats a fresh key through M, trusted on M and O, with no machine admitted; a second holder is refused grant-spent', async () => {
		const partyId = `owner-grant-without-machine-${Date.now()}`;

		let O: CadreNode | undefined;
		let M: InviteMember | undefined;
		let H: CadreNode | undefined;
		let H2: CadreNode | undefined;
		try {
			// ── O founds the cadre; M is admitted the owner-online way ──────────────
			O = await buildPhoneOwner(partyId);
			await O.start();
			const owner = O;
			const oPeerId = owner.peerId!.toString();
			const { publicKey: oOwnerKey } = await makeOwnOwner(owner);
			M = await startPinningMember(partyId, oOwnerKey);
			const member = M;
			await admitMember(owner, member, STARTUP_MS);
			// M's signed address record has to reach O before the grant can name it.
			await waitUntil(async () => (await owner.resolvePeerAddrs(member.peerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches O',
			});
			// O's own row is its first self-record; wait for it so the list compared at the end is settled.
			await waitUntil(async () => {
				const ids = await machinePeerIds(owner);
				return ids.includes(oPeerId) && ids.includes(member.peerId);
			}, { timeoutMs: STARTUP_MS, intervalMs: 500, description: 'O lists itself and M as machines' });
			const machinesBefore = await machinePeerIds(owner);

			// ── O mints a single-use grant labelled "hardware key" ──────────────────
			const { grant } = await owner.createOwnerGrant({ label: 'hardware key' });
			expect(grant.ownerKeys).toEqual([oOwnerKey]);
			expect(grant.members.length).toBeGreaterThan(0);
			expect(grant.members.every((addr) => addr.endsWith(`/p2p/${member.peerId}`))).toBe(true);

			// ── H redeems it over the protocol with a fresh key ─────────────────────
			H = await buildPartyDevice(partyId);
			await H.start();
			const holder = H;
			const hPeerId = holder.peerId!.toString();
			const hardwareKey = createTestOwnerKey();
			const redeemStartedAt = Date.now();
			const { result: redeemed, passes } = await waitingForMember(STARTUP_MS, 'grant-without-machine',
				(options) => holder.redeemOwnerGrant(grant, hardwareKey.signer, options));
			console.log('[grant-without-machine] H\'s key was seated on pass %d, %d ms after it first asked', passes, Date.now() - redeemStartedAt);
			expect(passes).toBe(1);
			expect(redeemed).toEqual({ ownerKey: hardwareKey.publicKey, alreadyOwner: false, memberPeerId: member.peerId });

			// ── M holds the row and derives the key; no machine was admitted ────────
			const seated: CadreOwnerKey = { key: hardwareKey.publicKey, label: 'hardware key', vouchedBy: oOwnerKey, heldHere: false, trusted: true };
			await waitUntil(() => member.node.getTrustedOwnerStore()!.sources().get(hardwareKey.publicKey) === 'chain', {
				timeoutMs: OP_MS, intervalMs: 250, description: 'M derives the seated key into its anchor',
			});
			// Behind the wait on M's anchor, which derives the key only from its live row.
			expect(await member.node.listOwnerKeys()).toContainEqual(seated);
			expect(await member.node.isAuthorizedMember(hPeerId)).toBe(false);

			// ── O, which did not write the row, holds it and derives the key ────────
			const redeemedAt = Date.now();
			await waitUntil(() => owner.getTrustedOwnerStore()!.sources().get(hardwareKey.publicKey) === 'chain', {
				timeoutMs: OP_MS, intervalMs: 250, description: 'O derives the seated key into its anchor',
			});
			console.log('[grant-without-machine] O derived the seated key %d ms after the redemption returned', Date.now() - redeemedAt);
			// Behind the wait on O's anchor, as on M; the same write carried any machine row it made.
			expect(await owner.listOwnerKeys()).toContainEqual(seated);
			expect(await machinePeerIds(owner)).toEqual(machinesBefore);

			// ── H2 with another key: the single use is spent ────────────────────────
			H2 = await buildPartyDevice(partyId);
			await H2.start();
			const secondKey = createTestOwnerKey();
			const refusal: unknown = await H2.redeemOwnerGrant(grant, secondKey.signer).catch((err: unknown) => err);
			expect(refusal).toBeInstanceOf(OwnerGrantRejectedError);
			expect(refusal).toMatchObject({ code: 'grant-spent', retryable: false });
			expect((await member.node.getControlDatabase()!.getOwnerKeys()).has(secondKey.publicKey)).toBe(false);
		} finally {
			await Promise.allSettled([H2?.stop(), H?.stop(), O?.stop(), M?.node.stop()]);
		}
	}, 6 * STARTUP_MS);
});
