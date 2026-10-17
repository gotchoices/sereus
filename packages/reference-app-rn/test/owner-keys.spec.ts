/**
 * `owner-keys.ts` — what Owner keys makes of an import's answer and of an owner grant's
 * redemption, what a removal re-vouches from its Keep switches, and which owner grants its prompt
 * says stop working. The error classes are the real ones from `@serfab/cadre-core`, so an
 * `instanceof` that stops matching fails here rather than on a phone.
 */
import { describe, it, expect } from 'vitest';
import {
	OwnerGrantRejectedError,
	OwnerGrantUnreachableError,
	OwnerKeyAddRefusedError,
	type CadreMachine,
	type CadreOwnerKey,
	type OwnerGrantRow,
	type OwnerKeyRemovalPlan,
} from '@serfab/cadre-core';
import { dependentRows, describeOwnerKeyFailure, grantRemovalLines, importOutcome, redemptionAlert, revouchOf } from '../src/owner-keys';

function ownerKey(key: string, label: string | null, heldHere = false): CadreOwnerKey {
	return { key, label, vouchedBy: null, heldHere, trusted: true };
}

describe('importOutcome', () => {
	const listed = [ownerKey('phone-key', 'phone', true), ownerKey('backup-key', 'Backup')];

	// `importOwnerKey` answers `wired: false` both for a key the cadre does not list and for one it
	// does, on a node already signing with another key; only the list tells them apart.
	it('tells a listed key the node will take at its next start from a key that is no owner', () => {
		expect(importOutcome({ publicKey: 'backup-key', wired: true }, listed)).toBe('owner');
		expect(importOutcome({ publicKey: 'backup-key', wired: false }, listed)).toBe('owner-from-next-start');
		expect(importOutcome({ publicKey: 'stranger-key', wired: false }, listed)).toBe('not-an-owner');
	});
});

describe('the removal\'s Keep switches', () => {
	it('re-vouches exactly the rows left on, devices by peer id and owner keys by key', () => {
		const plan: OwnerKeyRemovalPlan = {
			ownerKey: ownerKey('lost-key', 'lost phone'),
			refusal: null,
			dependents: { peers: ['peer-app', 'peer-gone'], owners: ['key-named', 'key-unlisted'] },
			revouchesOwnRow: false,
			ownDependency: false,
			grants: [],
		};
		const machines: CadreMachine[] = [
			{ peerId: 'peer-app', publicKey: 'abcdefgh-identity', isSelf: false, trusted: true, profile: 'transaction', lastPublishedAt: null, vouchedBy: 'lost-key' },
		];
		const rows = dependentRows(plan, [ownerKey('key-named', 'YubiKey')], machines);

		expect(rows.map((row) => [row.kind, row.id, row.name])).toEqual([
			['device', 'peer-app', 'App abcdefgh'],
			['device', 'peer-gone', 'peer-gone…r-gone'],
			['owner-key', 'key-named', 'YubiKey (key-name)'],
			['owner-key', 'key-unlisted', 'key-unli'],
		]);
		expect(revouchOf(rows, new Set(['peer-gone', 'key-named']))).toEqual({ peers: ['peer-gone'], owners: ['key-named'] });
	});
});

describe('redeeming an owner grant', () => {
	const listed = [ownerKey('slot-key', 'tablet', true)];

	it('tells becoming an owner from being one already and from a key whose row has not arrived', () => {
		expect(redemptionAlert({ ownerKey: 'slot-key', alreadyOwner: false, wired: true }, listed).title).toBe('Now an owner');
		expect(redemptionAlert({ ownerKey: 'slot-key', alreadyOwner: true, wired: true }, listed).message).toMatch(/not used/);
		expect(redemptionAlert({ ownerKey: 'slot-key', alreadyOwner: false, wired: false }, listed).message).toMatch(/next start/);
	});

	it.each<[string, unknown, RegExp]>([
		['a spent or withdrawn grant', new OwnerGrantRejectedError('grant-spent', 'withdrawn'), /expired, withdrawn or used up/],
		['no member reachable', new OwnerGrantUnreachableError([]), /could be reached/],
		['a member with no connection to the others', new OwnerKeyAddRefusedError('slot-key', 'alone'), /^Connect to your cadre/],
		['text that is not an owner grant, refused by the decoder', new Error('This is an owner key, not an owner grant'), /^This is an owner key/],
	])('words the refusal of %s', (_label, err, expected) => {
		expect(describeOwnerKeyFailure(err)).toMatch(expected);
	});
});

describe('the removal prompt\'s owner grants', () => {
	it('names each live grant the removed key made, a backup as a backup', () => {
		const grants = [grantRow('Paper', null), grantRow(null, null), grantRow('tablet', '2026-10-17 12:00:00')];

		expect(grantRemovalLines(grants)).toEqual([
			'Backup "Paper" stops working.',
			'A backup with no name stops working.',
			'The owner grant "tablet" stops working.',
		]);
	});
});

function grantRow(label: string | null, expiresAt: string | null): OwnerGrantRow {
	return { key: `grant-${label}`, label, expiresAt, totalUses: 1, stampId: 'stamp', issuerKey: 'lost-key', issuerSig: 'sig' };
}
