/**
 * `rentalStore`: the app's record of the nodes it rented from hosting providers, by party, in
 * the app-private node-local database (`rentalsKvKey(partyId)` in `/node-local`). cadre-core's
 * `rentNode` persists nothing, so this is what lets an app find a rental it was killed in the
 * middle of on its next launch (`finishRental`), poll the provider for each node's standing,
 * and tell a rented node from any other machine in its device list.
 *
 * The record is not trust-bearing: it names a container to ask the provider about, and the
 * provider's answer, not the record, is what the app shows. A record that cannot be read
 * reads as no rentals, logged, since the containers still exist at the provider and the user
 * finds them on the provider's own pages.
 */
import type { DurableSlot } from '@serfab/cadre-core';
import { kvStoreSlot, rentalsKvKey, type KvStoreApi } from '../node-local.js';

/** One container the app rented for a party. */
export interface Rental {
	/** The provider descriptor's `id`. */
	providerId: string;
	/** The provider's `name` when the rental was made, for the device list's "Rented from" fact. */
	providerName: string;
	containerId: string;
	/** Which path `rentNode` took. */
	join: 'claim' | 'invitation';
	/** The node's peer id, once known: at once on the claim path, from a status read on the invitation path. */
	peerId?: string;
	createdAt: number;
	/**
	 * Whether `rentNode` or `finishRental` returned for this container. False from the create until
	 * then, so an app killed mid-flow finds the rental and offers to finish it.
	 */
	finished: boolean;
}

export interface RentalStore {
	/** The party's rentals, oldest first. A read fault throws. */
	list(partyId: string): Promise<Rental[]>;
	/** Record a rental, replacing any record of the same container. */
	add(partyId: string, rental: Rental): Promise<void>;
	/** Change a rental's `peerId` or `finished`; nothing happens when no record names the container. */
	update(partyId: string, containerId: string, patch: Partial<Pick<Rental, 'peerId' | 'finished'>>): Promise<void>;
	/** Drop the record; the container, if it still exists, is untouched. */
	remove(partyId: string, containerId: string): Promise<void>;
}

/**
 * Create one per app, over `PhoneNode.nodeLocalRecords()`: its calls run one at a time, so a
 * record written while another is being finished is not lost to a read-modify-write race.
 */
export function rentalStore(kv: KvStoreApi): RentalStore {
	let turn: Promise<unknown> = Promise.resolve();
	const inTurn = <T>(op: () => Promise<T>): Promise<T> => {
		const result = turn.then(op);
		turn = result.catch(() => undefined);
		return result;
	};
	const slotFor = (partyId: string): DurableSlot => kvStoreSlot(kv, rentalsKvKey(partyId));
	const write = (partyId: string, rentals: readonly Rental[]): Promise<void> => slotFor(partyId).save(JSON.stringify(rentals));

	return {
		list: (partyId) => inTurn(() => readRentals(slotFor(partyId), partyId)),
		add: (partyId, rental) => inTurn(async () => {
			const others = (await readRentals(slotFor(partyId), partyId)).filter((entry) => entry.containerId !== rental.containerId);
			await write(partyId, [...others, rental]);
		}),
		update: (partyId, containerId, patch) => inTurn(async () => {
			const rentals = await readRentals(slotFor(partyId), partyId);
			const current = rentals.find((entry) => entry.containerId === containerId);
			if (!current) return;
			await write(partyId, rentals.map((entry) => (entry === current ? { ...entry, ...patch } : entry)));
		}),
		remove: (partyId, containerId) => inTurn(async () => {
			const rentals = await readRentals(slotFor(partyId), partyId);
			if (!rentals.some((entry) => entry.containerId === containerId)) return;
			await write(partyId, rentals.filter((entry) => entry.containerId !== containerId));
		}),
	};
}

async function readRentals(slot: DurableSlot, partyId: string): Promise<Rental[]> {
	const text = await slot.load();
	return text === undefined ? [] : parseRentals(text, partyId);
}

/** The saved list, or an empty one, logged, when it is not one. */
function parseRentals(text: string, partyId: string): Rental[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.warn(`[cadre-rn/provider] the rental record of party ${partyId} is not JSON; reading it as no rentals:`, err);
		return [];
	}
	const rentals = Array.isArray(parsed) ? parsed.map(parseRental) : null;
	if (!rentals?.every((rental): rental is Rental => rental !== null)) {
		console.warn(`[cadre-rn/provider] the rental record of party ${partyId} has the wrong shape; reading it as no rentals:`, text);
		return [];
	}
	return rentals;
}

function parseRental(value: unknown): Rental | null {
	const { providerId, providerName, containerId, join, peerId, createdAt, finished } = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
	if (typeof providerId !== 'string' || typeof providerName !== 'string' || typeof containerId !== 'string'
		|| (join !== 'claim' && join !== 'invitation') || (peerId !== undefined && typeof peerId !== 'string')
		|| typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof finished !== 'boolean') {
		return null;
	}
	return { providerId, providerName, containerId, join, createdAt, finished, ...(peerId !== undefined ? { peerId } : {}) };
}
