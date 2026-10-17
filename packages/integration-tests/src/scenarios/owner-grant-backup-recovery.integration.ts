/**
 * E2E: a backup owner grant brings a fresh device back into the cadre as a machine and an owner
 * while the owner that minted it is offline, and the recovered owner removes the lost phone
 * (`docs/architecture.md` → "Owner grants": Backups, Self-admission).
 *
 * Machines:
 * - **O**, the owner: phone-shaped (`buildPhoneOwner`), its own genesis owner key. It mints a
 *   backup grant (no expiry) and stops: the lost phone.
 * - **M**, the only always-on member: `storage` profile, listening on WebSocket, admitted by O
 *   the owner-online way, pinning O's key and nothing else, with a 2 s control-cohort reconcile:
 *   on M that timer is what runs the membership refresh its anchor follows a replicated owner
 *   change at.
 * - **F**, the fresh device: started in the party on an empty store, joining with the backup
 *   grant and a fresh owner key (`joinWithOwnerGrant`).
 *
 * Why this shape. With O gone M is the only machine left, and M is alone with F. O has left M's
 * control cohort before F asks (waited for as in `cadre-invite-any-member`; a member write made
 * while O is still in it waits on O for its whole budget), so each of F's two redemptions, the
 * grant and then its self-invitation, commits at M only because M pushes F its control store
 * and counts F in its write cohort first. A second pass on either would mean the push did not
 * reach F before the write; the scenario pins one.
 *
 * The recovery is the lost-phone user's: F removes O's machine and O's owner key. O's key
 * vouched M's row (the owner-online admission), so F re-vouches M first; left on the removed
 * key, M would stop passing the membership predicate everywhere. F's own `OwnerKey` row names O
 * as its voucher (the grant's issuer) and cannot be re-vouched by F itself; it stays in M's
 * anchor, which derived it while O's key was live ("How the anchor follows the owner table").
 */

import { describe, it, expect } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import {
	buildPhoneOwner, makeOwnOwner, createTestOwnerKey, waitUntil, readCohort, machinePeerIds,
	startPinningMember, admitMember, buildPartyDevice, waitingForMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment, replication and the redemptions' passes over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row or tombstone crossing an already-open connection. */
const OP_MS = 30_000;
/** How long FRET may take to evict a stopped, address-less peer from a member's cohort (its leave notice: about 1 s; see `cadre-invite-any-member`). */
const COHORT_EVICTION_MS = 60_000;
/** M's control-cohort reconcile interval, the timer that runs M's membership refresh (default 15 s). */
const M_RECONCILE_MS = 2_000;
/** A row or tombstone M already holds reaching M's anchor: one {@link M_RECONCILE_MS} interval plus that pass. */
const REFRESH_MS = 10_000;

describe('E2E backup owner grant redeemed while the issuing owner is offline', () => {
	it('O mints a backup grant and is lost; F joins with it at M as a machine and an owner, then removes O\'s machine and O\'s owner key', async () => {
		const partyId = `owner-grant-backup-recovery-${Date.now()}`;

		let O: CadreNode | undefined;
		let M: InviteMember | undefined;
		let F: CadreNode | undefined;
		try {
			// ── O founds the cadre; M is admitted the owner-online way ──────────────
			O = await buildPhoneOwner(partyId);
			await O.start();
			const owner = O;
			const oPeerId = owner.peerId!.toString();
			const { publicKey: oOwnerKey } = await makeOwnOwner(owner, 'phone');
			M = await startPinningMember(partyId, oOwnerKey, { reconcileMs: M_RECONCILE_MS });
			const member = M;
			await admitMember(owner, member, STARTUP_MS);
			await waitUntil(async () => (await owner.resolvePeerAddrs(member.peerId)).length > 0, {
				timeoutMs: STARTUP_MS, intervalMs: 500, description: 'M\'s signed address record reaches O',
			});

			// ── O mints a backup grant, M holds its row, O is lost ──────────────────
			const { grant, reach } = await owner.createOwnerGrant({ label: 'paper backup', expiresInMs: null });
			expect(grant.grant.expiresAt).toBeNull();
			// It names a machine other than O, at a loopback address: redeemable once O is gone.
			expect(reach).toBe('local-network');
			const grantKey = grant.grant.key;
			await waitUntil(async () => (await member.node.listOwnerGrants()).some((status) => status.grant.key === grantKey && status.live), {
				timeoutMs: OP_MS, intervalMs: 500, description: 'M holds the live backup grant row',
			});
			await owner.stop();
			O = undefined;
			const ownerLeftAt = Date.now();
			await waitUntil(async () => !(await readCohort(member.node.getControlNode()!, member.peerId)).includes(oPeerId), {
				timeoutMs: COHORT_EVICTION_MS, intervalMs: 1_000, description: 'the stopped owner leaves M\'s control cohort',
			});
			console.log('[backup-recovery] the stopped owner left M\'s control cohort after %d ms', Date.now() - ownerLeftAt);

			// ── F joins with the backup grant and a fresh key ───────────────────────
			F = await buildPartyDevice(partyId);
			await F.start();
			const fresh = F;
			const fPeerId = fresh.peerId!.toString();
			const fOwner = createTestOwnerKey();
			const joinStartedAt = Date.now();
			const { result: joined, passes } = await waitingForMember(STARTUP_MS, 'backup-recovery',
				(options) => fresh.joinWithOwnerGrant(grant, fOwner.signer, options));
			console.log('[backup-recovery] F joined as a machine and an owner (at most %d pass(es) per redemption), %d ms after it first asked',
				passes, Date.now() - joinStartedAt);
			expect(passes).toBe(1);
			expect(joined).toMatchObject({ peerId: member.peerId, ownerKey: fOwner.publicKey, alreadyOwner: false, ownerWired: true });
			expect(await fresh.isOwner()).toBe(true);

			// M derives F's key through the grant chain from O, the only key M pins.
			await waitUntil(() => member.node.getTrustedOwnerStore()!.sources().get(fOwner.publicKey) === 'chain', {
				timeoutMs: OP_MS, intervalMs: 250, description: 'M derives F\'s owner key into its anchor',
			});
			// Behind the wait on M's anchor, which derives the key only from its live row.
			expect(await member.node.listOwnerKeys()).toContainEqual({
				key: fOwner.publicKey, label: 'paper backup', vouchedBy: oOwnerKey, heldHere: false, trusted: true,
			});
			// F's machine row is admitted by its self-invitation, whose issuer is F's own new key.
			expect((await member.node.listMachines()).find((machine) => machine.peerId === fPeerId))
				.toMatchObject({ trusted: true, vouchedBy: fOwner.publicKey });

			// ── F removes the lost phone's machine, then its owner key, keeping M ───
			// O's row reached F in the store M pushed it; the wait makes the removal's plan see it.
			await waitUntil(async () => (await machinePeerIds(fresh)).includes(oPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'F holds O\'s machine row',
			});
			expect(await fresh.removeMachine(oPeerId)).toMatchObject({ removedPeer: true });
			expect(await fresh.removeOwner(oOwnerKey, { revouch: { peers: [member.peerId] } }))
				.toEqual({ removed: true, revouched: { owners: [], peers: [member.peerId] } });
			const removedAt = Date.now();
			// F's own refresh ran before removeOwner returned: M is kept, vouched by F now.
			expect((await fresh.listMachines()).find((machine) => machine.peerId === member.peerId))
				.toMatchObject({ trusted: true, vouchedBy: fOwner.publicKey });

			// ── M follows: O's machine and O's key are gone, F stays trusted ────────
			await waitUntil(async () => !(await machinePeerIds(member.node)).includes(oPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'O\'s machine removal reaches M',
			});
			await waitUntil(async () => !(await member.node.getControlDatabase()!.getOwnerKeys()).has(oOwnerKey), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'O\'s owner key removal reaches M',
			});
			const mAnchor = member.node.getTrustedOwnerStore()!;
			await waitUntil(() => !mAnchor.has(oOwnerKey), {
				timeoutMs: REFRESH_MS, intervalMs: 250, description: 'M\'s anchor drops O\'s key',
			});
			console.log('[backup-recovery] M\'s anchor dropped O\'s key %d ms after F removed it', Date.now() - removedAt);
			expect(mAnchor.has(fOwner.publicKey)).toBe(true);
			expect((await member.node.listOwnerKeys()).map((row) => row.key)).toEqual([fOwner.publicKey]);
			expect(await member.node.isAuthorizedMember(fPeerId)).toBe(true);
		} finally {
			await Promise.allSettled([F?.stop(), O?.stop(), M?.node.stop()]);
		}
	}, 8 * STARTUP_MS);
});
