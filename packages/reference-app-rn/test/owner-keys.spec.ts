/**
 * `owner-keys.ts` — what Owner keys makes of an import's answer, and what a removal re-vouches
 * from its Keep switches.
 */
import { describe, it, expect } from 'vitest';
import type { CadreMachine, CadreOwnerKey, OwnerKeyRemovalPlan } from '@serfab/cadre-core';
import { dependentRows, importOutcome, revouchOf } from '../src/owner-keys';

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
