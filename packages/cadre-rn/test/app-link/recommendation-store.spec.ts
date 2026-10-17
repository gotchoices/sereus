import { describe, expect, it, vi } from 'vitest';
import type { DurableSlot } from '@serfab/cadre-core';

import { AppRecommendationStore, RECOMMENDATION_TTL_MS } from '../../src/app-link/index.js';

/** A slot over one in-memory text, as the node-local LevelDB key behaves. */
function memorySlot(initial?: string): DurableSlot {
	let text = initial;
	return {
		load: async () => text,
		save: async (next) => {
			text = next;
		},
	};
}

const PARTY = 'party-a';
const CHAT = { scheme: 'sereus-chat', appName: 'Sereus P2P Chat', partyId: PARTY };
const NOTES = { scheme: 'sereus-notes', appName: 'Sereus Notes', partyId: PARTY };

/** The owner app's security contract: a pre-approval admits one request, from that app, into that party, within the hour. */
describe('AppRecommendationStore', () => {
	it('gives a live pre-approval to the one take that matches its scheme and party, then none', async () => {
		const store = new AppRecommendationStore(memorySlot(), () => 1_000);
		const approved = await store.approve(CHAT);
		expect(approved).toEqual({ ...CHAT, approvedAtMs: 1_000 });

		expect(await store.take(CHAT.scheme, 'party-b')).toBeNull();
		expect(await store.take('sereus-notes', PARTY)).toBeNull();
		expect(await store.take(CHAT.scheme, PARTY)).toEqual(approved);
		expect(await store.take(CHAT.scheme, PARTY)).toBeNull();
	});

	it('gives none once the pre-approval is older than the hour', async () => {
		let now = 1_000;
		const store = new AppRecommendationStore(memorySlot(), () => now);
		await store.approve(CHAT);
		now += RECOMMENDATION_TTL_MS + 1;
		expect(await store.live(PARTY)).toEqual([]);
		expect(await store.take(CHAT.scheme, PARTY)).toBeNull();
	});

	it('replaces the pre-approval when the same app is approved again, and keeps another app\'s', async () => {
		let now = 1_000;
		// A stored entry with a field the shape does not have reads without it.
		const store = new AppRecommendationStore(memorySlot(JSON.stringify([{ ...CHAT, grantsOwner: true, approvedAtMs: 1_000 }])), () => now);
		expect(await store.live(PARTY)).toEqual([{ ...CHAT, approvedAtMs: 1_000 }]);
		await store.approve(NOTES);
		now += 10;
		await store.approve(CHAT);
		expect(await store.live(PARTY)).toEqual([
			{ ...CHAT, approvedAtMs: 1_010 },
			{ ...NOTES, approvedAtMs: 1_000 },
		]);

		await store.take(CHAT.scheme, PARTY);
		await store.withdraw('sereus-unknown');
		expect(await store.live(PARTY)).toEqual([{ ...NOTES, approvedAtMs: 1_000 }]);
		await store.withdraw(NOTES.scheme);
		expect(await store.live(PARTY)).toEqual([]);
	});

	it('reads a malformed record as none, and the next approval replaces it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const malformed = JSON.stringify([{ ...CHAT, approvedAtMs: 1_000 }, { ...NOTES, approvedAtMs: 'yesterday' }]);
			const store = new AppRecommendationStore(memorySlot(malformed), () => 1_000);
			expect(await store.take(CHAT.scheme, PARTY)).toBeNull();
			expect(warn).toHaveBeenCalledTimes(1);

			await store.approve(NOTES);
			expect(await store.live(PARTY)).toEqual([{ ...NOTES, approvedAtMs: 1_000 }]);
		} finally {
			warn.mockRestore();
		}
	});
});
