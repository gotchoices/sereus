/**
 * rental-store.spec.ts — the contract `rentalStore` (`@serfab/cadre-rn/provider`) gives an app over
 * the node-local database, which the React Native app's resume and poll rely on: records are kept
 * per party and updated in place, an update for a container no record names is a no-op, a record
 * that cannot be read reads as no rentals rather than throwing, and a read fault still throws. The
 * slot and the key under it are `node-local.spec.ts`'s.
 */
import { describe, expect, it, vi } from 'vitest';
import { rentalStore, type Rental } from '../../src/provider/index.js';
import { rentalsKvKey, type KvStoreApi } from '../../src/node-local.js';

class FakeKvStore implements KvStoreApi {
	readonly map = new Map<string, string>();
	getError: Error | null = null;

	async get(key: string): Promise<string | undefined> {
		if (this.getError) throw this.getError;
		return this.map.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.map.set(key, value);
	}
}

function rental(containerId: string, overrides: Partial<Rental> = {}): Rental {
	return { providerId: 'acme', providerName: 'Acme Nodes', containerId, join: 'claim', createdAt: 1_000, finished: false, ...overrides };
}

describe('rentalStore', () => {
	it('keeps each party\'s records in order, updates one in place, and ignores an update for an unknown container', async () => {
		const store = rentalStore(new FakeKvStore());
		await store.add('party-a', rental('c1'));
		await store.add('party-a', rental('c2', { join: 'invitation' }));
		await store.add('party-b', rental('c3'));
		await store.update('party-a', 'c1', { finished: true, peerId: 'peer-1' });
		await store.update('party-a', 'c9', { finished: true });

		expect(await store.list('party-a')).toEqual([rental('c1', { finished: true, peerId: 'peer-1' }), rental('c2', { join: 'invitation' })]);
		expect(await store.list('party-b')).toEqual([rental('c3')]);

		await store.remove('party-a', 'c1');
		expect(await store.list('party-a')).toEqual([rental('c2', { join: 'invitation' })]);
		expect(await store.list('party-b')).toEqual([rental('c3')]);
	});

	it('reads a record that is not a rental list as no rentals, logged, while a read fault throws', async () => {
		const kv = new FakeKvStore();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			kv.map.set(rentalsKvKey('party-a'), '{not json');
			expect(await rentalStore(kv).list('party-a')).toEqual([]);
			kv.map.set(rentalsKvKey('party-a'), JSON.stringify([{ providerId: 'acme', containerId: 'c1' }]));
			expect(await rentalStore(kv).list('party-a')).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
		kv.getError = new Error('database locked');
		await expect(rentalStore(kv).list('party-a')).rejects.toThrow('database locked');
	});
});
