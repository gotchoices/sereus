import { describe, it, expect } from 'vitest';
import { deriveOwnerAnchor } from '../src/owner-anchor-sync.js';
import {
	ownerGrantAddDigest,
	ownerGrantConsentDigest,
	ownerGrantRedeemDigest,
	ownerKeyAddDigest,
	revocationDigest,
} from '../src/peer-authorization.js';
import type { TrustSource } from '../src/trusted-owner-store.js';
import type { OwnerGrantChain, OwnerGrantRow, OwnerGrantUsageRow, OwnerKeyRow, RevocationRow } from '../src/types.js';
import { freshKeyPair, freshStamp, signB64 } from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';

/** The party every proof here is signed for; the digests bind it, so one id serves the whole file. */
const PARTY_ID = 'owner-anchor-sync-spec';

/**
 * The rule by which every node recomputes its trusted-owner anchor from the replicated
 * `OwnerKey` table (`owner-anchor-sync.ts`), driven with real signatures and no database:
 * rows, tombstones and owner-grant chains are built the way the writers store them, in the
 * base64url digest forms the verifiers check.
 */

/** An owner-signed `OwnerKey` row for `owner`, vouched by `voucher`, as `insertOwnerKeyVouched` stores it. */
function signedRow(owner: KeyPair, voucher: KeyPair, stampId = freshStamp()): OwnerKeyRow {
	return {
		key: owner.publicKey,
		label: null,
		stampId,
		vouchOwner: voucher.publicKey,
		vouchSig: signB64(voucher, ownerKeyAddDigest(PARTY_ID, owner.publicKey, null, stampId)),
		vouchUsage: null,
	};
}

/** The founding row: no proof at all. */
function foundingRow(owner: KeyPair): OwnerKeyRow {
	return { key: owner.publicKey, label: null, stampId: freshStamp(), vouchOwner: null, vouchSig: null, vouchUsage: null };
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
 * An owner grant issued by `issuer`, with the label it chose, redeemed for a fresh key: the
 * seated `OwnerKey` row plus the usage and grant rows it is verified through, every signature
 * valid, built as `redeemOwnerGrant` stores them.
 */
function grantSeatedOwner(issuer: KeyPair, label: string | null = 'Backup'): { row: OwnerKeyRow; grant: OwnerGrantRow; grantChain: OwnerGrantChain } {
	const seated = freshKeyPair();
	const grantKeys = freshKeyPair();
	const signed = { key: grantKeys.publicKey, label, expiresAt: null, totalUses: 1, stampId: freshStamp() };
	const grant: OwnerGrantRow = { ...signed, issuerKey: issuer.publicKey, issuerSig: signB64(issuer, ownerGrantAddDigest(PARTY_ID, signed)) };
	const usageStampId = freshStamp();
	const seatedStampId = freshStamp();
	const usage: OwnerGrantUsageRow = {
		usageStampId,
		grantKey: grant.key,
		seatedKey: seated.publicKey,
		seatedStampId,
		grantSig: signB64(grantKeys, ownerGrantRedeemDigest(PARTY_ID, grant.key, usageStampId, seated.publicKey)),
		ownerSig: signB64(seated, ownerGrantConsentDigest(PARTY_ID, grant.key, usageStampId, seated.publicKey)),
	};
	const row: OwnerKeyRow = { key: seated.publicKey, label, stampId: seatedStampId, vouchOwner: issuer.publicKey, vouchSig: null, vouchUsage: usageStampId };
	return { row, grant, grantChain: { usages: new Map([[usageStampId, usage]]), grants: new Map([[grant.key, grant]]) } };
}

const keysOf = (...owners: KeyPair[]): Set<string> => new Set(owners.map(owner => owner.publicKey));
/** An anchor as `TrustedOwnerStore.sources()` reports it: `base` pinned out of band, `derived` under `chain`. */
const anchorOf = (base: KeyPair[], derived: KeyPair[] = []): Map<string, TrustSource> => new Map([
	...base.map((owner): [string, TrustSource] => [owner.publicKey, 'operator']),
	...derived.map((owner): [string, TrustSource] => [owner.publicKey, 'chain']),
]);

describe('deriveOwnerAnchor', () => {
	it('derives a chain of two in one pass, owner-signed then grant-seated, and never the founding row', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const bRow = signedRow(b, a);
		const seated = grantSeatedOwner(b);
		// Rows listed with the far end first, so a single sweep in row order could not find B before C needs it.
		const rows = [seated.row, bRow, foundingRow(a)];

		const { target, refusedRemovals } = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows, tombstones: [], grantChain: seated.grantChain });
		expect(target).toEqual(new Set([a.publicKey, b.publicKey, seated.row.key]));
		expect(refusedRemovals).toEqual([]);

		// With no anchored voucher at the root, nothing is derived — the table alone seats nobody.
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: new Map(), rows, tombstones: [], grantChain: seated.grantChain }).target.size).toBe(0);
	});

	it('derives a grant-seated owner from an anchored issuer, and not one whose grant signature is altered', () => {
		const a = freshKeyPair();
		const { row, grant, grantChain } = grantSeatedOwner(a);
		const inputs = { partyId: PARTY_ID, anchor: anchorOf([a]), rows: [row], tombstones: [] };

		expect(deriveOwnerAnchor({ ...inputs, grantChain }).target).toEqual(new Set([a.publicKey, row.key]));
		// With the issuer unanchored, the table alone seats nobody.
		expect(deriveOwnerAnchor({ ...inputs, anchor: new Map(), grantChain }).target.size).toBe(0);

		// The grant re-signed by a stranger under the issuer's name: the chain fails at the grant.
		const forgedGrant = { ...grant, issuerSig: signB64(freshKeyPair(), ownerGrantAddDigest(PARTY_ID, grant)) };
		const forged: OwnerGrantChain = { ...grantChain, grants: new Map([[grant.key, forgedGrant]]) };
		expect(deriveOwnerAnchor({ ...inputs, grantChain: forged }).target).toEqual(keysOf(a));
		// No usage row to judge the row by: not derived either.
		expect(deriveOwnerAnchor({ ...inputs, grantChain: null }).target).toEqual(keysOf(a));
	});

	it('keeps an owner a removed owner had added where it was derived, and cannot derive it elsewhere until re-added', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const bRow = signedRow(b, a);
		const cByB = signedRow(c, b);
		const bRemoved = tombstoneFor(bRow, a);

		// A machine that had derived B and C: B's row is retired, so B goes; C's row is live, so C stays.
		const kept = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a], [b, c]), rows: [bRow, cByB], tombstones: [bRemoved], grantChain: null });
		expect(kept.target).toEqual(keysOf(a, c));

		// A machine that never held C: its chain from A runs through B's retired row.
		const unreached = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [bRow, cByB], tombstones: [bRemoved], grantChain: null });
		expect(unreached.target).toEqual(keysOf(a));

		const cByA = signedRow(c, a);
		const healed = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [cByA], tombstones: [bRemoved], grantChain: null });
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
		const rotation = { rows: [aRow, a2Row], tombstones: [tombstoneFor(aRow, a2)], grantChain: null };

		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), ...rotation }).target).toEqual(keysOf(a2));
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([], [a2]), ...rotation }).target).toEqual(keysOf(a2));

		// A2 is a full owner afterwards: B derives through its vouch, and B's removal of A2 applies.
		const bRow = signedRow(b, a2);
		const rows = [...rotation.rows, bRow];
		expect(deriveOwnerAnchor({ ...rotation, partyId: PARTY_ID, anchor: anchorOf([], [a2]), rows }).target).toEqual(keysOf(a2, b));
		const tombstones = [...rotation.tombstones, tombstoneFor(a2Row, b)];
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([], [a2, b]), rows, tombstones, grantChain: null }).target).toEqual(keysOf(b));
	});

	it('a re-add under a fresh stamp beats the older tombstone, and a base pin of a removed key is dropped', () => {
		const a = freshKeyPair();
		const k = freshKeyPair();
		const first = signedRow(k, a);
		const removed = tombstoneFor(first, a);

		// K pinned here out of band (operator pin), removed by A elsewhere: the pin goes.
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, k]), rows: [], tombstones: [removed], grantChain: null }).target).toEqual(keysOf(a));

		// Re-added under a fresh stamp: the live derivable row wins over the old stamp's tombstone.
		const second = signedRow(k, a);
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, k]), rows: [second], tombstones: [removed], grantChain: null }).target).toEqual(keysOf(a, k));
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a]), rows: [second], tombstones: [removed], grantChain: null }).target).toEqual(keysOf(a, k));
	});

	it('refuses a mutual removal that would empty the anchor, and applies it when a third owner remains', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const aRow = foundingRow(a);
		const bRow = signedRow(b, a);
		const tombstones = [tombstoneFor(aRow, b), tombstoneFor(bRow, a)];

		const refused = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b]), rows: [], tombstones, grantChain: null });
		expect(refused.target).toEqual(keysOf(a, b));
		expect(new Set(refused.refusedRemovals)).toEqual(keysOf(a, b));

		const applied = deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b, c]), rows: [], tombstones, grantChain: null });
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
		expect(deriveOwnerAnchor({ partyId: PARTY_ID, anchor: anchorOf([a, b]), rows: [], tombstones: [byStranger, bySelf, forged], grantChain: null }).target).toEqual(keysOf(a, b));
	});
});
