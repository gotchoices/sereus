import { describe, expect, it } from 'vitest';

import type { StrandRemovalResult } from '../src/lib/state.svelte.js';
import { removalFeedback, requiresTypedConfirmation } from '../src/lib/strand-removal.js';

function result(over: Partial<StrandRemovalResult> = {}): StrandRemovalResult {
	return {
		strandId: 'ledger-2024',
		published: true,
		type: 'o',
		removed: true,
		alone: false,
		...over,
	};
}

describe('requiresTypedConfirmation', () => {
	it('demands a typed confirmation only for closed strands', () => {
		expect(requiresTypedConfirmation('c')).toBe(true);
		expect(requiresTypedConfirmation('o')).toBe(false);
	});
});

describe('removalFeedback', () => {
	it('reports a delete that reached siblings as a success toast', () => {
		expect(removalFeedback(result())).toEqual({
			kind: 'toast',
			tone: 'success',
			text: 'Left ledger-2024',
		});
	});

	it('reports an id that was never published as an info toast', () => {
		expect(removalFeedback(result({ published: false, type: null, removed: false }))).toEqual({
			kind: 'toast',
			tone: 'info',
			text: 'ledger-2024 was already removed',
		});
	});

	it('raises the banner only when this call issued the delete while alone', () => {
		expect(removalFeedback(result({ removed: true, alone: true }))).toEqual({
			kind: 'banner',
			strandId: 'ledger-2024',
		});
	});

	it('does not raise the banner when alone but nothing was deleted', () => {
		// `alone` is sampled on every call — on its own it says nothing about a write.
		expect(removalFeedback(result({ removed: false, alone: true })).kind).toBe('toast');
		expect(removalFeedback(result({ published: false, removed: false, alone: true }))).toEqual({
			kind: 'toast',
			tone: 'info',
			text: 'ledger-2024 was already removed',
		});
	});

	it('names the id the node acted on, not the one the row showed', () => {
		// The node trims; the feedback must quote what it actually removed.
		expect(removalFeedback(result({ strandId: 'ns/strand' })).kind).toBe('toast');
		expect(removalFeedback(result({ strandId: 'ns/strand', alone: true }))).toEqual({
			kind: 'banner',
			strandId: 'ns/strand',
		});
	});

	it('gives exactly one piece of feedback for every outcome', () => {
		for (const published of [true, false]) {
			for (const removed of [true, false]) {
				for (const alone of [true, false]) {
					const feedback = removalFeedback(result({ published, removed, alone }));
					expect(['toast', 'banner']).toContain(feedback.kind);
				}
			}
		}
	});
});
