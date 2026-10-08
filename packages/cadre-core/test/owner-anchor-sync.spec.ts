import { describe, it, expect } from 'vitest';
import { deriveOwnerAnchor } from '../src/owner-anchor-sync.js';
import {
	cadreInviteAddDigest,
	cadreInviteConsentDigest,
	cadreInviteRedeemDigest,
	ownerKeyAddDigest,
	revocationDigest,
} from '../src/peer-authorization.js';
import type { TrustSource } from '../src/trusted-owner-store.js';
import type { InvitationChain, OwnerKeyRow, RevocationRow } from '../src/types.js';
import { freshKeyPair, freshStamp, signB64 } from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner } from './formation-consent-helper.js';

/** The party every proof here is signed for; the digests bind it, so one id serves the whole file. */
const PARTY_ID = 'owner-anchor-sync-spec';

/**
 * The rule by which every node recomputes its trusted-owner anchor from the replicated
 * `OwnerKey` table (`owner-anchor-sync.ts`), driven with real signatures and no database:
 * rows, tombstones and invitation chains are built the way the writers store them, in the
 * base64url digest forms the verifiers check.
 */

/** An owner-signed `OwnerKey` row for `owner`, vouched by `voucher`, as `insertOwnerKeyVouched` stores it. */
function signedRow(owner: KeyPair, voucher: KeyPair, stampId = freshStamp()): OwnerKeyRow {
	return {
		key: owner.publicKey,
		stampId,
		vouchOwner: voucher.publicKey,
		vouchSig: signB64(voucher, ownerKeyAddDigest(PARTY_ID, owner.publicKey, stampId)),
		vouchUsage: null,
	};
}

/** The founding row: no proof at all. */
function foundingRow(owner: KeyPair): OwnerKeyRow {
	return { key: owner.publicKey, stampId: freshStamp(), vouchOwner: null, vouchSig: null, vouchUsage: null };
}

/** An `OwnerKey` tombstone naming `row`, signed by `signer`, as `deleteOwnerKey` stores it. */
function tombstoneFor(row: OwnerKeyRow, signer: KeyPair): RevocationRow {
	return {
		tableName: 'OwnerKey',
		rowKey: row.key,
		stampId: row.stampId,
		reissuedAt: 0,
		signerKey: signer.publicKey,
		signerSig: signB64(signer, revocationDigest(PARTY_ID, 'OwnerKey', row.key, row.stampId)),
	};
}

/**
 * An owner-granting invitation issued by `issuer` and redeemed by a fresh device: the
 * device's `OwnerKey` row plus the usage and invitation rows it is verified through, every
 * signature valid, built as `redeemCadreInvite` stores them.
 */
async function invitationAdmittedOwner(issuer: KeyPair): Promise<{ row: OwnerKeyRow; device: KeyPair; chain: InvitationChain }> {
	const device = await mintContactJoiner();
	const inviteKeys = freshKeyPair();
	const signed = { key: inviteKeys.publicKey, peerId: null, grantsOwner: true, expiresAt: null, totalUses: 1, stampId: freshStamp() };
	const invite = { ...signed, issuerKey: issuer.publicKey, issuerSig: signB64(issuer, cadreInviteAddDigest(PARTY_ID, signed)) };
	const usageStampId = freshStamp();
	const ownerStampId = freshStamp();
	const usage = {
		usageStampId,
		inviteKey: invite.key,
		peerId: device.partyId,
		peerKey: device.peerKey,
		peerStampId: freshStamp(),
		ownerStampId,
		inviteSig: signB64(inviteKeys, cadreInviteRedeemDigest(PARTY_ID, invite.key, usageStampId, device.peerKey)),
		peerSig: signB64({ privateKey: device.privateKey, publicKey: device.peerKey }, cadreInviteConsentDigest(PARTY_ID, invite.key, usageStampId, device.peerKey)),
	};
	const row: OwnerKeyRow = { key: device.peerKey, stampId: ownerStampId, vouchOwner: issuer.publicKey, vouchSig: null, vouchUsage: usageStampId };
	return {
		row,
		device: { privateKey: device.privateKey, publicKey: device.peerKey },
		chain: { usages: new Map([[usageStampId, usage]]), invites: new Map([[invite.key, invite]]) },
	};
}

const keysOf = (...owners: KeyPair[]): Set<string> => new Set(owners.map(owner => owner.publicKey));
/** An anchor as `TrustedOwnerStore.sources()` reports it: `base` pinned out of band, `derived` under `chain`. */
const anchorOf = (base: KeyPair[], derived: KeyPair[] = []): Map<string, TrustSource> => new Map([
	...base.map((owner): [string, TrustSource] => [owner.publicKey, 'operator']),
	...derived.map((owner): [string, TrustSource] => [owner.publicKey, 'chain']),
]);

describe('deriveOwnerAnchor', () => {
	it('derives a chain of two in one pass, owner-signed then invitation-admitted, and never the founding row', async () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const bRow = signedRow(b, a);
		const admitted = await invitationAdmittedOwner(b);
		// Rows listed with the far end first, so a single sweep in row order could not find B before C needs it.
		const rows = [admitted.row, bRow, foundingRow(a)];

		const { target, refusedRemovals } = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows, tombstones: [], chain: admitted.chain });
		expect(target).toEqual(keysOf(a, b, admitted.device));
		expect(refusedRemovals).toEqual([]);

		// With no anchored voucher at the root, nothing is derived — the table alone seats nobody.
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: new Map(), rows, tombstones: [], chain: admitted.chain }).target.size).toBe(0);
	});

	it('keeps an owner a removed owner had added where it was derived, and cannot derive it elsewhere until re-added', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const bRow = signedRow(b, a);
		const cByB = signedRow(c, b);
		const bRemoved = tombstoneFor(bRow, a);

		// A machine that had derived B and C: B's row is retired, so B goes; C's row is live, so C stays.
		const kept = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a], [b, c]), rows: [bRow, cByB], tombstones: [bRemoved], chain: null });
		expect(kept.target).toEqual(keysOf(a, c));

		// A machine that never held C: its chain from A runs through B's retired row.
		const unreached = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [bRow, cByB], tombstones: [bRemoved], chain: null });
		expect(unreached.target).toEqual(keysOf(a));

		const cByA = signedRow(c, a);
		const healed = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [cByA], tombstones: [bRemoved], chain: null });
		expect(healed.target).toEqual(keysOf(a, c));
	});

	it('an owner rotation survives the pass after the old key is removed, and the new key then vouches and is removable', () => {
		// Rotation is add-then-remove: A adds A2, A2 removes A. The pass that sees both derives A2
		// from A (base, whatever its own row) and removes A; the NEXT pass holds only A2 as `chain`
		// with no base left to re-derive it from, and must keep it on the strength of its live row.
		const a = freshKeyPair();
		const a2 = freshKeyPair();
		const b = freshKeyPair();
		const aRow = foundingRow(a);
		const a2Row = signedRow(a2, a);
		const rotation = { rows: [aRow, a2Row], tombstones: [tombstoneFor(aRow, a2)], chain: null };

		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), ...rotation }).target).toEqual(keysOf(a2));
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([], [a2]), ...rotation }).target).toEqual(keysOf(a2));

		// A2 is a full owner afterwards: B derives through its vouch, and B's removal of A2 applies.
		const bRow = signedRow(b, a2);
		const rows = [...rotation.rows, bRow];
		expect(deriveOwnerAnchor({ ...rotation, partyId: PARTY_ID, anchor: anchorOf([], [a2]), rows }).target).toEqual(keysOf(a2, b));
		const tombstones = [...rotation.tombstones, tombstoneFor(a2Row, b)];
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([], [a2, b]), rows, tombstones, chain: null }).target).toEqual(keysOf(b));
	});

	it('a re-add under a fresh stamp beats the older tombstone, and a base pin of a removed key is dropped', () => {
		const a = freshKeyPair();
		const k = freshKeyPair();
		const first = signedRow(k, a);
		const removed = tombstoneFor(first, a);

		// K pinned here out of band (operator pin), removed by A elsewhere: the pin goes.
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, k]), rows: [], tombstones: [removed], chain: null }).target).toEqual(keysOf(a));

		// Re-added under a fresh stamp: the live derivable row wins over the old stamp's tombstone.
		const second = signedRow(k, a);
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, k]), rows: [second], tombstones: [removed], chain: null }).target).toEqual(keysOf(a, k));
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [second], tombstones: [removed], chain: null }).target).toEqual(keysOf(a, k));
	});

	it('refuses a mutual removal that would empty the anchor, and applies it when a third owner remains', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const aRow = foundingRow(a);
		const bRow = signedRow(b, a);
		const tombstones = [tombstoneFor(aRow, b), tombstoneFor(bRow, a)];

		const refused = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b]), rows: [], tombstones, chain: null });
		expect(refused.target).toEqual(keysOf(a, b));
		expect(new Set(refused.refusedRemovals)).toEqual(keysOf(a, b));

		const applied = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b, c]), rows: [], tombstones, chain: null });
		expect(applied.target).toEqual(keysOf(c));
		expect(applied.refusedRemovals).toEqual([]);
	});

	it('ignores a tombstone whose signer is not anchored, signs its own removal, or does not verify', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const stranger = freshKeyPair();
		const bRow = signedRow(b, a);
		const byStranger = tombstoneFor(bRow, stranger);
		const bySelf = tombstoneFor(bRow, b);
		const forged = { ...tombstoneFor(bRow, a), signerSig: tombstoneFor(signedRow(b, a), a).signerSig };

		// B's row is kept out so the tombstones' stamps retire nothing; B is base, as a pin would be.
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b]), rows: [], tombstones: [byStranger, bySelf, forged], chain: null }).target).toEqual(keysOf(a, b));
	});
});
