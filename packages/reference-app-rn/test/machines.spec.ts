/**
 * machines.spec.ts — the removal prompt's Keep switches (`dependentsOf` and `revouchFor` in
 * src/machines.ts). A device the removed machine added as an owner has both its peer row and its
 * owner key among the plan's dependents; it must be one switch, so keeping it never re-vouches
 * half of it.
 */

import { describe, expect, it } from 'vitest';
import type { CadreMachine, MachineRemovalPlan } from '@serfab/cadre-core';
import { dependentsOf, revouchFor } from '../src/machines';

function machine(peerId: string, publicKey: string): CadreMachine {
	return {
		peerId, publicKey, isSelf: false, isOwner: false, isMember: true, trusted: true,
		profile: 'transaction', lastPublishedAt: null, vouchedBy: 'removed-key',
	};
}

function planWith(owners: string[], peers: string[]): MachineRemovalPlan {
	return { machine: null, refusal: null, removesOwnerKey: true, dependents: { owners, peers }, invitations: [], ownDependency: false };
}

const MACHINES = [machine('peer-a', 'key-a'), machine('peer-b', 'key-b'), machine('peer-c', 'key-c')];

describe('dependentsOf', () => {
	it.each([
		{
			case: 'an owner device it added is one switch; a member device another',
			owners: ['key-a'], peers: ['peer-a', 'peer-b'], kept: ['peer-a', 'peer-b'],
			switches: ['peer-a', 'peer-b'], revouch: { owners: ['key-a'], peers: ['peer-a', 'peer-b'] },
		},
		{
			case: 'an owner key whose machine row it did not add, and one no listed machine holds',
			owners: ['key-c', 'key-z'], peers: [], kept: ['key-c', 'key-z'],
			switches: ['key-c', 'key-z'], revouch: { owners: ['key-c', 'key-z'], peers: [] },
		},
		{
			case: 'a switch turned off re-vouches neither the row nor the key',
			owners: ['key-a'], peers: ['peer-a', 'peer-b'], kept: ['peer-b'],
			switches: ['peer-a', 'peer-b'], revouch: { owners: [], peers: ['peer-b'] },
		},
	])('$case', ({ owners, peers, kept, switches, revouch }) => {
		const dependents = dependentsOf(planWith(owners, peers), MACHINES);
		expect(dependents.map((dependent) => dependent.id)).toEqual(switches);
		expect(revouchFor(dependents, new Set(kept))).toEqual(revouch);
	});
});
