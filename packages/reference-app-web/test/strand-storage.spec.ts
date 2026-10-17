/**
 * `deleteStore` — removing a party's block database when another tab of this site still holds it
 * open. The browser then fires `blocked` and waits for as long as that tab runs, so a dissolve
 * that waited on the request would never finish (the edge node's `destroyScope`). Real IndexedDB is not
 * needed: the branch is how the request's events are handled, so a fake `indexedDB` global that
 * hands back the request and lets the test fire its events is enough.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteStore, StoreDeleteBlockedError } from '../src/lib/strand-storage';

/** The part of `IDBOpenDBRequest` `deleteStore` uses. */
interface FakeDeleteRequest {
	error: DOMException | null;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	onblocked: (() => void) | null;
}

function fakeIndexedDb(): FakeDeleteRequest[] {
	const requests: FakeDeleteRequest[] = [];
	vi.stubGlobal('indexedDB', {
		deleteDatabase(_name: string): FakeDeleteRequest {
			const request: FakeDeleteRequest = { error: null, onsuccess: null, onerror: null, onblocked: null };
			requests.push(request);
			return request;
		},
	});
	return requests;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('deleteStore', () => {
	it('gives up on a blocked delete, and refuses a second one while the first still waits', async () => {
		const requests = fakeIndexedDb();

		const first = deleteStore('control-blocked');
		requests[0]!.onblocked!();
		await expect(first).rejects.toBeInstanceOf(StoreDeleteBlockedError);

		// A second request would queue behind the first and hang just the same.
		await expect(deleteStore('control-blocked')).rejects.toBeInstanceOf(StoreDeleteBlockedError);
		expect(requests).toHaveLength(1);
	});
});
