import { describe, it, expect } from 'vitest';
import { CohortOutOfSpaceError } from '@optimystic/db-core';
import { cohortOutOfSpaceOf } from '../src/write-errors.js';

/**
 * An app on a strand sees a full cohort only as a failed `db.exec`, because Optimystic gives the
 * refusal no SQL error of its own. `cohortOutOfSpaceOf` is the whole of how an app tells it apart
 * from contention or an unreachable cohort, and Quereus and the Optimystic plugin each add a layer
 * between the cohort's refusal and the app's `catch` — so the chain walk is what is worth pinning.
 */
describe('cohortOutOfSpaceOf', () => {
	it('finds the refusal however deeply it is wrapped, and nothing in any other failure', () => {
		const out = new CohortOutOfSpaceError({ peerIds: ['peer-a', 'peer-b'], approvals: 1, peerCount: 3, needed: 3 });
		expect(cohortOutOfSpaceOf(out)).toBe(out);
		expect(cohortOutOfSpaceOf(new Error('commit failed', { cause: out }))).toBe(out);
		expect(cohortOutOfSpaceOf(new Error('statement failed', { cause: new Error('commit failed', { cause: out }) }))).toBe(out);

		// Every other way a write can fail, and the two non-errors a `catch` can be handed.
		expect(cohortOutOfSpaceOf(new Error('cohort unreachable'))).toBeUndefined();
		expect(cohortOutOfSpaceOf(new Error('outer', { cause: new Error('revision taken') }))).toBeUndefined();
		expect(cohortOutOfSpaceOf('Cohort is out of space')).toBeUndefined();
		expect(cohortOutOfSpaceOf(undefined)).toBeUndefined();
	});
});
