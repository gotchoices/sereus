import { describe, it, expect } from 'vitest';
import { deriveOwnerAnchor } from '../src/owner-anchor-sync.js';
import {
	cadreInviteAddDigest,
	cadreInviteConsentDigest,
	cadreInviteRedeemDigest,
	ownerKeyAddDigest,
	revocationDigest,
} from '../src/peer-authorization.js';
import type { InvitationChain, OwnerKeyRow, RevocationRow } from '../src/types.js';
import { freshKeyPair, freshStamp, signB64 } from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';
import { mintContactJoiner } from './formation-consent-helper.js';

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
		vouchSig: signB64(voucher, ownerKeyAddDigest(owner.publicKey, stampId)),
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
		signerSig: signB64(signer, revocationDigest('OwnerKey', row.key, row.stampId)),
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
	const invite = { ...signed, issuerKey: issuer.publicKey, issuerSig: signB64(issuer, cadreInviteAddDigest(signed)) };
	const usageStampId = freshStamp();
	const ownerStampId = freshStamp();
	const usage = {
		usageStampId,
		inviteKey: invite.key,
		peerId: device.partyId,
		peerKey: device.peerKey,
		peerStampId: freshStamp(),
		ownerStampId,
		inviteSig: signB64(inviteKeys, cadreInviteRedeemDigest(invite.key, usageStampId, device.peerKey)),
		peerSig: signB64({ privateKey: device.privateKey, publicKey: device.peerKey }, cadreInviteConsentDigest(invite.key, usageStampId, device.peerKey)),
	};
	const row: OwnerKeyRow = { key: device.peerKey, stampId: ownerStampId, vouchOwner: issuer.publicKey, vouchSig: null, vouchUsage: usageStampId };
	return {
		row,
		device: { privateKey: device.privateKey, publicKey: device.peerKey },
		chain: { usages: new Map([[usageStampId, usage]]), invites: new Map([[invite.key, invite]]) },
	};
}

const keysOf = (...owners: KeyPair[]): Set<string> => new Set(owners.map(owner => owner.publicKey));

describe('deriveOwnerAnchor', () => {
	it('derives a chain of two in one pass, owner-signed then invitation-admitted, and never the founding row', async () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const bRow = signedRow(b, a);
		const admitted = await invitationAdmittedOwner(b);
		// Rows listed with the far end first, so a single sweep in row order could not find B before C needs it.
		const rows = [admitted.row, bRow, foundingRow(a)];

		const { target, refusedRemovals } = deriveOwnerAnchor({ base: keysOf(a), rows, tombstones: [], chain: admitted.chain });
		expect(target).toEqual(keysOf(a, b, admitted.device));
		expect(refusedRemovals).toEqual([]);

		// With no anchored voucher at the root, nothing is derived — the table alone seats nobody.
		expect(deriveOwnerAnchor({ base: new Set(), rows, tombstones: [], chain: admitted.chain }).target.size).toBe(0);
	});

	it('prunes an owner vouched by a removed owner, and derives it again once a remaining owner re-adds it', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const bRow = signedRow(b, a);
		const cByB = signedRow(c, b);
		const bRemoved = tombstoneFor(bRow, a);

		// A machine that holds B's row beside its tombstone: B is retired, so C's chain from A is broken.
		const pruned = deriveOwnerAnchor({ base: keysOf(a), rows: [bRow, cByB], tombstones: [bRemoved], chain: null });
		expect(pruned.target).toEqual(keysOf(a));

		const cByA = signedRow(c, a);
		const healed = deriveOwnerAnchor({ base: keysOf(a), rows: [cByA], tombstones: [bRemoved], chain: null });
		expect(healed.target).toEqual(keysOf(a, c));
	});

	it('a re-add under a fresh stamp beats the older tombstone, and a base pin of a removed key is dropped', () => {
		const a = freshKeyPair();
		const k = freshKeyPair();
		const first = signedRow(k, a);
		const removed = tombstoneFor(first, a);

		// K pinned here out of band (operator pin), removed by A elsewhere: the pin goes.
		expect(deriveOwnerAnchor({ base: keysOf(a, k), rows: [], tombstones: [removed], chain: null }).target).toEqual(keysOf(a));

		// Re-added under a fresh stamp: the live derivable row wins over the old stamp's tombstone.
		const second = signedRow(k, a);
		expect(deriveOwnerAnchor({ base: keysOf(a, k), rows: [second], tombstones: [removed], chain: null }).target).toEqual(keysOf(a, k));
		expect(deriveOwnerAnchor({ base: keysOf(a), rows: [second], tombstones: [removed], chain: null }).target).toEqual(keysOf(a, k));
	});

	it('refuses a mutual removal that would empty the anchor, and applies it when a third owner remains', () => {
		const a = freshKeyPair();
		const b = freshKeyPair();
		const c = freshKeyPair();
		const aRow = foundingRow(a);
		const bRow = signedRow(b, a);
		const tombstones = [tombstoneFor(aRow, b), tombstoneFor(bRow, a)];

		const refused = deriveOwnerAnchor({ base: keysOf(a, b), rows: [], tombstones, chain: null });
		expect(refused.target).toEqual(keysOf(a, b));
		expect(new Set(refused.refusedRemovals)).toEqual(keysOf(a, b));

		const applied = deriveOwnerAnchor({ base: keysOf(a, b, c), rows: [], tombstones, chain: null });
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
		expect(deriveOwnerAnchor({ base: keysOf(a, b), rows: [], tombstones: [byStranger, bySelf, forged], chain: null }).target).toEqual(keysOf(a, b));
	});
});
