import { describe, it, expect } from 'vitest';
import { CONTROL_COHORT_REDIAL_MS, DEFAULT_CONTROL_COHORT_RECONCILE_MS, nextReconcileWakeMs } from '../src/control-cohort.js';

/**
 * The reconcile pass's own wake (`nextReconcileWakeMs`): the redial ladder for a sibling
 * or bootstrap peer a pass left unconnected, and the strand-address due time a pass left
 * behind. The spin rule — a due time at or before the pass's start is not a reason to wake —
 * is the part that is easy to break.
 */

const BACKSTOP_MS = DEFAULT_CONTROL_COHORT_RECONCILE_MS;
const PASS_STARTED_AT = 1_000_000;
/** The pass ran for a second. */
const NOW = PASS_STARTED_AT + 1_000;

function wake(input: { redialStreak?: number; strandAddrDueAt?: number[]; backstopMs?: number }): number | undefined {
	return nextReconcileWakeMs({
		redialStreak: input.redialStreak ?? 0,
		passStartedAt: PASS_STARTED_AT,
		strandAddrDueAt: input.strandAddrDueAt ?? [],
		now: NOW,
		backstopMs: input.backstopMs ?? BACKSTOP_MS,
	});
}

describe('nextReconcileWakeMs', () => {
	it('doubles the redial from 15 s per unconnected pass until the backstop caps it', () => {
		expect(wake({ redialStreak: 1 })).toBe(CONTROL_COHORT_REDIAL_MS);
		expect(wake({ redialStreak: 2 })).toBe(2 * CONTROL_COHORT_REDIAL_MS);
		expect(wake({ redialStreak: 3 })).toBe(4 * CONTROL_COHORT_REDIAL_MS);
		expect(wake({ redialStreak: 40 })).toBe(BACKSTOP_MS);
	});

	it('caps the first redial at a backstop shorter than it', () => {
		expect(wake({ redialStreak: 1, backstopMs: 2_000 })).toBe(2_000);
	});

	it('wakes for a strand-address due time later than the pass start', () => {
		expect(wake({ strandAddrDueAt: [PASS_STARTED_AT + 41_000] })).toBe(40_000);
	});

	it('ignores a due time at or before the pass start, so a skipped sibling cannot spin it', () => {
		expect(wake({ strandAddrDueAt: [PASS_STARTED_AT, PASS_STARTED_AT - 5_000] })).toBeUndefined();
	});

	it('ignores a due time at or beyond the backstop, which covers it', () => {
		expect(wake({ strandAddrDueAt: [NOW + BACKSTOP_MS] })).toBeUndefined();
	});

	it('takes the sooner of the redial and the strand-address wake', () => {
		expect(wake({ redialStreak: 3, strandAddrDueAt: [PASS_STARTED_AT + 41_000] })).toBe(40_000);
		expect(wake({ redialStreak: 1, strandAddrDueAt: [PASS_STARTED_AT + 41_000] })).toBe(CONTROL_COHORT_REDIAL_MS);
	});

	it('wakes at once for a due time that passed during the pass', () => {
		expect(wake({ strandAddrDueAt: [PASS_STARTED_AT + 500] })).toBe(0);
	});
});
