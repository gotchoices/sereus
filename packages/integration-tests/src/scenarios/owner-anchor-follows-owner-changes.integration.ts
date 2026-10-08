/**
 * E2E: every machine's trusted-owner anchor follows an owner addition, a removal and a
 * re-addition made by another machine (`docs/architecture.md` → "How the anchor follows the
 * owner table", under "Seed Delivery Protocol").
 *
 * Machines:
 * - **A**, the founding owner, listening on a loopback WebSocket port.
 * - **M**, an always-on member pinning A's key and nothing else, admitted the owner-online way
 *   (`addDrone` plus seed delivery). M's anchor is the one under test: every other key M
 *   trusts it has to derive from the replicated `OwnerKey` table.
 * - **B**, a second machine with its own identity key, admitted like M and then made an owner
 *   by A (`addOwner`). It is wired to sign from the start (`ownerCapable`), because a node
 *   registers one seed handler and the owner-capable service has to be that one; this anchors
 *   B's own key on B alone.
 * - **C**, a device B vouches: a bare peer id with no node, because what is asserted is the
 *   membership predicate on M and A, not a connection.
 *
 * Why this shape. M never pins B, so M accepting B's vouch and B's seed proves that M derived B
 * from A's signed row after it replicated, and M refusing them after A removes B proves that
 * A's tombstone, replicated to M, took B out again. A, M and B stay connected throughout, so the
 * delete and the tombstone reach M together; a machine holding the removed owner's row beside
 * its tombstone authorizes nothing either, by the live-owner clause on every owner lookup in
 * `schemas/control.qsql` (pinned on one database by `control-revocation-replay.spec.ts`).
 *
 * M follows a replicated change at its next membership refresh, and on M nothing but the timed
 * control-cohort reconcile runs one (every 15 s by default): a row that arrives by replication
 * raises no local notification. The scenario never drives a refresh, so each step covers the
 * whole path, and each wait on M's anchor follows a wait on the replicated row or tombstone
 * itself, so a timeout names which of the two did not arrive.
 */

import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';
import {
	controlNodeConfig, makeOwnOwner, waitUntil, randomPeerId,
	startPinningMember, admitMember, type InviteMember,
} from '../harness/index.js';

/** Bring-up, enrollment and the first sync over loopback — each hides a CadreNode start or a reconcile pass. */
const STARTUP_MS = 60_000;
/** One row or tombstone crossing an already-open connection. */
const OP_MS = 30_000;
/**
 * A row M already holds reaching M's anchor: one control-cohort reconcile interval (15 s by
 * default) plus that pass. Measured 14.0–14.9 s per step over eight runs, four of them in
 * parallel, because each step's write lands just after the tick that ended the previous wait.
 *
 * NOTE: M keeps the default interval although that is ~45 s of the run. With M at 2 s, B's vouch
 * of C lands ~1.5 s after A's `addOwner` and failed 2 of 3 runs beside the other invite scenarios:
 * one validator rejects it as `unavailable (unmaterializable)`, the vote tracked by
 * `fresh-strand-replica-vetoes-writes-while-catching-up`. Once that lands, pass `reconcileMs` to
 * M (a `startPinningMember` option to add) and shorten this budget.
 */
const REFRESH_MS = 30_000;
/** The seed trust policy's refusal of a signer outside the receiver's anchor (`anchoredTrustPolicy`). */
const UNANCHORED_SIGNER = 'Signer key is not an anchored owner (anchored trust policy)';

describe('E2E the trusted-owner anchor follows owner additions and removals', () => {
	it('M derives the owner A adds and accepts its vouch and seed; A removes it and M refuses both; A re-adds it and M follows', async () => {
		const partyId = `owner-anchor-follows-${Date.now()}`;
		const aKey = await generateKeyPair('Ed25519');

		let A: CadreNode | undefined;
		let M: InviteMember | undefined;
		let B: InviteMember | undefined;
		try {
			// ── A founds the cadre; M and B are admitted the owner-online way ─────────
			A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'transaction', strandFilter: 'none' }));
			await A.start();
			const owner = A;
			const aOwnerKey = await makeOwnOwner(owner, aKey);
			const aPeerId = owner.peerId!.toString();

			M = await startPinningMember(partyId, aOwnerKey);
			const member = M.node;
			await admitMember(owner, M, STARTUP_MS);
			B = await startPinningMember(partyId, aOwnerKey, { ownerCapable: true });
			const second = B.node;
			await admitMember(owner, B, STARTUP_MS);
			const bOwnerKey = ed25519KeyPairFromLibp2p(B.key).publicKeyB64;
			for (const [label, node] of [['M', member], ['B', second]] as const) {
				await waitUntil(async () => (await node.getControlDatabase()!.getOwnerKeys()).has(aOwnerKey)
					&& (await node.listAuthorizedMembers()).some((row) => row.peerId === aPeerId), {
					timeoutMs: STARTUP_MS, intervalMs: 500, description: `${label} holds A's owner key and lists A as a member`,
				});
			}
			const mAnchor = member.getTrustedOwnerStore()!;
			expect(mAnchor.has(bOwnerKey)).toBe(false);

			// ── A adds B as an owner; M derives B from the replicated row ─────────────
			expect(await owner.addOwner(bOwnerKey)).toBe(true);
			const addedAt = Date.now();
			// The write notified A's membership hub, whose refresh ran A's anchor sync before addOwner returned.
			expect(owner.getTrustedOwnerStore()!.sources().get(bOwnerKey)).toBe('chain');
			await followedByM('A adds B', addedAt, () => holdsOwnerRow(member, bOwnerKey), () => mAnchor.sources().get(bOwnerKey) === 'chain');

			// ── B vouches C; M and A list C as authorized ────────────────────────────
			// B's CadrePeer insert is checked against B's own copy of OwnerKey, so B waits for its row.
			await waitUntil(() => holdsOwnerRow(second, bOwnerKey), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'B holds its own OwnerKey row',
			});
			const cPeerId = await randomPeerId();
			await second.authorizePeer(cPeerId);
			await waitUntil(async () => (await member.listMembers()).some((row) => row.peerId === cPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'C\'s CadrePeer row reaches M',
			});
			// Behind the wait on the row: M's anchor already holds B, so the row is judged now.
			expect(await listsAuthorized(member, cPeerId)).toBe(true);
			await waitUntil(() => listsAuthorized(owner, cPeerId), {
				timeoutMs: OP_MS, intervalMs: 250, description: 'A lists C as an authorized member',
			});

			// ── M accepts a seed B signs ──────────────────────────────────────────────
			expect(await member.applySeed(await second.createSeed())).toMatchObject({ success: true });

			// ── A removes B; the tombstone reaches M, and M stops honouring B ─────────
			expect(await owner.removeOwner(bOwnerKey)).toBe(true);
			const removedAt = Date.now();
			expect(owner.getTrustedOwnerStore()!.has(bOwnerKey)).toBe(false);
			expect(await listsAuthorized(owner, cPeerId)).toBe(false);
			await followedByM('A removes B', removedAt, async () => (await member.getControlDatabase()!.queryRevocations()).some((tombstone) =>
				tombstone.tableName === 'OwnerKey' && tombstone.rowKey === bOwnerKey && tombstone.signerKey === aOwnerKey), () => !mAnchor.has(bOwnerKey));
			expect(await listsAuthorized(member, cPeerId)).toBe(false);
			expect(await member.applySeed(await second.createSeed())).toMatchObject({ success: false, error: UNANCHORED_SIGNER });

			// ── A re-adds B under a fresh stamp; the older tombstone no longer applies ─
			expect(await owner.addOwner(bOwnerKey)).toBe(true);
			const readdedAt = Date.now();
			await followedByM('A re-adds B', readdedAt, () => holdsOwnerRow(member, bOwnerKey), () => mAnchor.sources().get(bOwnerKey) === 'chain');
			expect(await listsAuthorized(member, cPeerId)).toBe(true);
		} finally {
			await Promise.allSettled([B?.node.stop(), M?.node.stop(), A?.stop()]);
		}
	}, 10 * STARTUP_MS);
});

/**
 * Wait for a change A made to reach M: first the replicated row or tombstone (`arrived`), then
 * M's anchor (`followed`), each under its own budget so a timeout names the stage. Logs both
 * delays after `since`, so a slowdown shows in the run output rather than inside a green run.
 */
async function followedByM(step: string, since: number, arrived: () => Promise<boolean>, followed: () => boolean): Promise<void> {
	await waitUntil(arrived, { timeoutMs: OP_MS, intervalMs: 250, description: `${step}: the row or tombstone reaches M` });
	const arrivedMs = Date.now() - since;
	await waitUntil(followed, { timeoutMs: REFRESH_MS, intervalMs: 250, description: `${step}: M's anchor follows` });
	console.log('[owner-anchor] %s: reached M after %d ms; M\'s anchor followed after %d ms', step, arrivedMs, Date.now() - since);
}

/** Does `node`'s copy of `OwnerKey` hold a live row for `ownerKey`? */
async function holdsOwnerRow(node: CadreNode, ownerKey: string): Promise<boolean> {
	return (await node.getControlDatabase()!.getOwnerKeys()).has(ownerKey);
}

async function listsAuthorized(node: CadreNode, peerId: string): Promise<boolean> {
	return (await node.listAuthorizedMembers()).some((row) => row.peerId === peerId);
}
