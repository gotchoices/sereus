/**
 * `start-options.ts` — reading back the options the phone last started with. The
 * record selects the party every node-local record is filed under, so a damaged one
 * must neither crash a launch nor cost the phone its party id over a lesser field.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseSavedStartOptions, serializeSavedStartOptions, type SavedStartOptions } from '../src/start-options';

const SAVED: SavedStartOptions = {
	options: {
		partyId: 'party-7f3a',
		bootstrapAddrs: ['/ip4/192.168.1.20/tcp/4002/ws/p2p/12D3KooWBootstrapPeerForTheStartOptionsTest'],
		relayAddrs: ['/ip4/203.0.113.7/tcp/4002/ws/p2p/12D3KooWRelayPeerForTheStartOptionsTest'],
		noiseCryptoMode: 'full',
	},
	autoStart: true,
};

/** The stored JSON of {@link SAVED}, with `fields` overriding it. */
function recordWith(fields: Record<string, unknown>): string {
	return JSON.stringify({ ...JSON.parse(serializeSavedStartOptions(SAVED)), ...fields });
}

describe('parseSavedStartOptions', () => {
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns what was serialized', () => {
		expect(parseSavedStartOptions(serializeSavedStartOptions(SAVED))).toEqual(SAVED);
	});

	it('treats an unusable record as absent: not JSON, an unknown version, or no party id', () => {
		expect(parseSavedStartOptions('{"version":1,"partyId":')).toBeUndefined();
		expect(parseSavedStartOptions(recordWith({ version: 2 }))).toBeUndefined();
		expect(parseSavedStartOptions(recordWith({ partyId: '' }))).toBeUndefined();
	});

	it('keeps the party id when a lesser field is malformed, defaulting that field', () => {
		const parsed = parseSavedStartOptions(recordWith({ noiseCryptoMode: 'turbo', relayAddrs: 'not-a-list' }));

		expect(parsed).toEqual({
			options: { partyId: SAVED.options.partyId, bootstrapAddrs: SAVED.options.bootstrapAddrs, relayAddrs: [] },
			autoStart: true,
		});
	});
});
