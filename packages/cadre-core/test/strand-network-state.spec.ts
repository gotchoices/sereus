import { describe, it, expect } from 'vitest';
import { PERSISTED_STATE_VERSION, type PersistedNetworkState } from '@optimystic/db-p2p';
import {
	MemoryStrandNetworkStateStore,
	PersistentStrandNetworkStateStore,
	strandNetworkStatePersistence
} from '../src/strand-network-state.js';
import type { DurableSlot } from '../src/node-local-snapshot.js';

const PARTY = 'party-alpha';

/** A state distinguishable by its high-water mark; the store never looks inside it. */
function stateWith(networkHighWaterMark: number): PersistedNetworkState {
	return {
		version: PERSISTED_STATE_VERSION,
		networkHighWaterMark,
		lastConnectedTimestamp: 0,
		consecutiveIsolatedSessions: 0
	};
}

/** An in-memory {@link DurableSlot} whose text a test can read and replace. */
function memorySlot(): DurableSlot & { text: string | undefined } {
	const slot = {
		text: undefined as string | undefined,
		load: async () => slot.text,
		save: async (next: string) => { slot.text = next; }
	};
	return slot;
}

describe('PersistentStrandNetworkStateStore', () => {
	it('keeps each strand across a reopen, drops a forgotten one, and drops a non-object entry on load', async () => {
		const slot = memorySlot();
		const first = await PersistentStrandNetworkStateStore.open(slot, PARTY);
		await first.save('strand-a', stateWith(3));
		await first.save('strand-b', stateWith(5));

		const second = await PersistentStrandNetworkStateStore.open(slot, PARTY);
		expect(second.load('strand-a')).toEqual(stateWith(3));
		expect(second.load('strand-b')).toEqual(stateWith(5));
		await second.forget('strand-a');

		const envelope = JSON.parse(slot.text!) as { strands: Record<string, unknown> };
		envelope.strands['strand-junk'] = 'not a state';
		slot.text = JSON.stringify(envelope);

		const third = await PersistentStrandNetworkStateStore.open(slot, PARTY);
		expect(third.load('strand-a')).toBeUndefined();
		expect(third.load('strand-b')).toEqual(stateWith(5));
		expect(third.load('strand-junk')).toBeUndefined();
	});
});

describe('strandNetworkStatePersistence', () => {
	it('drops a save that arrives after the strand was forgotten, until a new adapter is built', async () => {
		const store = new MemoryStrandNetworkStateStore(PARTY);
		const tornDown = strandNetworkStatePersistence(store, 'strand-a');
		await tornDown.save(stateWith(3));
		await store.forget('strand-a');

		await tornDown.save(stateWith(4));
		expect(await tornDown.load()).toBeUndefined();

		const relaunched = strandNetworkStatePersistence(store, 'strand-a');
		await relaunched.save(stateWith(5));
		expect(await relaunched.load()).toEqual(stateWith(5));
	});
});
