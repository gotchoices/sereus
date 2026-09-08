/**
 * Unit coverage for `controlNodeConfig`, the one builder every scenario's node config
 * now comes from (`src/harness/node-fixtures.ts`).
 *
 * WHY THIS EXISTS SEPARATELY. Folding a scenario's private config literal onto this
 * builder is a change that PASSES ITS OWN TESTS while producing a different node: a
 * dropped `enableRelay` still boots, a defaulted `profile` still replicates, and the
 * scenario goes on asserting something it no longer means to assert. The integration
 * suites cannot catch that — they are the thing being mislead. So the builder's output
 * is asserted directly here, field by field, and the folds have a guard instead of a
 * careful reading.
 *
 * Pure unit tests over the returned object: no libp2p, no cadre node, no strand.
 */

import { describe, expect, it } from 'vitest';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { CadreNodeConfig, RawStorageProvider } from '@serfab/cadre-core';
import { controlNodeConfig, type ControlNodeOpts } from '../src/harness/node-fixtures.js';

/**
 * `CadreNodeConfig` leaves `network` and `storage` optional for embedders that accept the
 * cadre-core defaults; `controlNodeConfig` always populates both, and asserting that here
 * is what lets every other case read a field without a guard.
 */
function builtConfig(opts: ControlNodeOpts): Required<Pick<CadreNodeConfig, 'network' | 'storage'>> & CadreNodeConfig {
	const config = controlNodeConfig(opts);
	expect(config.network).toBeDefined();
	expect(config.storage).toBeDefined();
	return config as Required<Pick<CadreNodeConfig, 'network' | 'storage'>> & CadreNodeConfig;
}

/**
 * `RawStorageProvider` is either a per-scope factory OR a single store used for every
 * scope. Every config this builder produces uses the factory arm, so a test that wants to
 * see what a scope resolves to narrows here rather than at each call.
 */
function storeForScope(provider: RawStorageProvider, scope: string) {
	if (typeof provider !== 'function') throw new Error('expected a per-scope factory, got a bare store');
	return provider(scope);
}

describe('controlNodeConfig', () => {
	describe('defaults — what a scenario gets when it passes only a party id', () => {
		const config = builtConfig({ partyId: 'p' });

		it('is a non-relaying transaction node on a loopback WS listener, all strands, no hibernation', () => {
			expect(config.controlNetwork).toEqual({ partyId: 'p', bootstrapNodes: [] });
			expect(config.profile).toBe('transaction');
			expect(config.strandFilter).toEqual({ mode: 'all' });
			expect(config.network.listenAddrs).toEqual(['/ip4/127.0.0.1/tcp/0/ws']);
			expect(config.hibernation).toEqual({ enabled: false });
		});

		it('omits every optional key rather than setting it undefined, so CadreNode defaults stand', () => {
			// `enableRelay` unset is NOT `enableRelay: false` — CadreNode derives it from the
			// profile. A builder that emitted the key with an undefined value would look the
			// same to a spread but read as "explicitly unset" to an `in` check.
			for (const key of ['enableRelay', 'relayAddrs', 'unauthorizedRelayReservationCap',
				'controlCohort', 'connectionGater'] as const) {
				expect(key in config.network).toBe(false);
			}
			for (const key of ['privateKey', 'strandWatchInterval', 'enrolledMachines', 'trustedOwners'] as const) {
				expect(key in config).toBe(false);
			}
		});

		it('hands out a FRESH store per scope, so nothing leaks between two nodes', () => {
			const provider = config.storage.provider;
			expect(storeForScope(provider, 'scope-a')).not.toBe(storeForScope(provider, 'scope-b'));
		});
	});

	describe('the values scenarios depend on being forwarded verbatim', () => {
		it('keeps an EMPTY listenAddrs — the dial-only client shape, not an omission', () => {
			expect(builtConfig({ partyId: 'p', listenAddrs: [] }).network.listenAddrs).toEqual([]);
		});

		it('forwards enableRelay: false, which a truthiness test would silently drop', () => {
			// The defect the private copies actually shipped: a storage-profile node asked to
			// stop relaying kept relaying, because `false` failed the copy's truthiness guard.
			expect(builtConfig({ partyId: 'p', profile: 'storage', enableRelay: false }).network.enableRelay)
				.toBe(false);
			expect(builtConfig({ partyId: 'p', enableRelay: true }).network.enableRelay).toBe(true);
		});

		it('forwards a zero unauthorizedRelayReservationCap, the other falsy-but-meaningful value', () => {
			expect(builtConfig({ partyId: 'p', unauthorizedRelayReservationCap: 0 })
				.network.unauthorizedRelayReservationCap).toBe(0);
		});

		it('forwards bootstrapNodes, profile, strandFilter, strandWatchMs and reconcileMs', () => {
			const config = builtConfig({
				partyId: 'p',
				bootstrapNodes: ['/ip4/1.2.3.4/tcp/1/ws/p2p/x'],
				profile: 'storage',
				strandFilter: 'none',
				strandWatchMs: 250,
				reconcileMs: 2_000,
			});
			expect(config.controlNetwork.bootstrapNodes).toEqual(['/ip4/1.2.3.4/tcp/1/ws/p2p/x']);
			expect(config.profile).toBe('storage');
			expect(config.strandFilter).toEqual({ mode: 'none' });
			expect(config.strandWatchInterval).toBe(250);
			expect(config.network.controlCohort).toEqual({ reconcileMs: 2_000 });
		});

		it('uses storageProvider verbatim, so a caller can pin ONE store across a restart', () => {
			const store = new MemoryRawStorage();
			const provider = builtConfig({ partyId: 'p', storageProvider: () => store }).storage.provider;
			expect(storeForScope(provider, 'scope-a')).toBe(store);
			expect(storeForScope(provider, 'scope-b')).toBe(store);
		});

		it('forwards pinnedOwnerKeys under trustedOwners', () => {
			expect(controlNodeConfig({ partyId: 'p', pinnedOwnerKeys: ['k'] }).trustedOwners)
				.toEqual({ pinnedKeys: ['k'] });
		});
	});

	it('refuses storageProvider together with storageOpDelayMs instead of picking one', () => {
		expect(() => controlNodeConfig({
			partyId: 'p',
			storageProvider: () => new MemoryRawStorage(),
			storageOpDelayMs: 5,
		})).toThrow(/mutually exclusive/);
	});
});
