import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { DurableSlot } from '@serfab/cadre-core';
import { CADRE_INVITATION_PREFIX } from '@serfab/cadre-core';

import {
	encodeCadreJoinResponse,
	KNOWN_SEREUS_APPS,
	LINK_REQUEST_TTL_MS,
	LinkRequestStore,
	parseCadreLink,
	UnsolicitedJoinResponseError,
	type CadreJoinResponse,
} from '../../src/app-link/index.js';

/** A slot over one in-memory text, as the node-local LevelDB key behaves. */
function memorySlot(): DurableSlot {
	let text: string | undefined;
	return {
		load: async () => text,
		save: async (next) => {
			text = next;
		},
	};
}

function invited(nonce: string): CadreJoinResponse {
	return { v: 1, nonce, appName: 'Sereus P2P Chat', invitation: `${CADRE_INVITATION_PREFIX}eyJ2IjoxfQ` };
}

describe('parseCadreLink', () => {
	it.each([
		['sereus-join-request:1.eyJ2IjoxfQ', { kind: 'join-request', text: 'sereus-join-request:1.eyJ2IjoxfQ' }],
		['sereus-chat://cadre-join-request/sereus-join-request:1.eyJ2IjoxfQ', { kind: 'join-request', text: 'sereus-join-request:1.eyJ2IjoxfQ' }],
		['sereus-chat-2://cadre-join-response/sereus-join-response:1.eyJ2IjoxfQ', { kind: 'join-response', text: 'sereus-join-response:1.eyJ2IjoxfQ' }],
		// A node code and an invitation belong to the app's other link routing.
		['sereus-join:1.eyJ2IjoxfQ', null],
		[`${CADRE_INVITATION_PREFIX}eyJ2IjoxfQ`, null],
		['sereus-chat://settings/cadre', null],
		['sereus-chat://cadre-join-response/', null],
	])('%s', (url, expected) => {
		expect(parseCadreLink(url)).toEqual(expected);
	});
});

/** The asking app's security contract: it takes only the answer to the request it has open, once. */
describe('LinkRequestStore', () => {
	it('takes the answer to the open request once, and keeps the nonce across a second tap', async () => {
		const store = new LinkRequestStore(memorySlot());
		const first = await store.begin('Sereus P2P Chat');
		expect(await store.begin(null)).toEqual(first);

		expect(await store.take(encodeCadreJoinResponse(invited(first.nonce)))).toEqual(invited(first.nonce));
		expect(await store.current()).toBeNull();
		await expect(store.take(encodeCadreJoinResponse(invited(first.nonce)))).rejects.toThrow(UnsolicitedJoinResponseError);

		const second = await store.begin(null);
		const refused: CadreJoinResponse = { v: 1, nonce: second.nonce, appName: 'Owner', refused: 'not-owner' };
		expect(await store.take(encodeCadreJoinResponse(refused))).toEqual(refused);
	});

	it('refuses an answer with another nonce, an answer after the request expired, and one when none is open', async () => {
		let now = 1_000_000;
		const store = new LinkRequestStore(memorySlot(), () => now);
		const refusal: CadreJoinResponse = { v: 1, nonce: 'another-request-nonce', appName: 'Owner', refused: 'denied' };
		await expect(store.take(encodeCadreJoinResponse(refusal))).rejects.toThrow(UnsolicitedJoinResponseError);

		const open = await store.begin(null);
		await expect(store.take(encodeCadreJoinResponse(refusal))).rejects.toThrow(/different join request/);
		now += LINK_REQUEST_TTL_MS + 1;
		await expect(store.take(encodeCadreJoinResponse({ ...refusal, nonce: open.nonce }))).rejects.toThrow(UnsolicitedJoinResponseError);
		expect((await store.begin(null)).nonce).not.toBe(open.nonce);
	});
});

describe('config plugin', () => {
	it('lists the same known apps as the kit, since the CommonJS plugin keeps its own copy', () => {
		const plugin = createRequire(import.meta.url)('../../app.plugin.cjs') as { KNOWN_SEREUS_APPS: unknown };
		expect(plugin.KNOWN_SEREUS_APPS).toEqual(KNOWN_SEREUS_APPS);
	});
});
