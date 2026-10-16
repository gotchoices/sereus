/**
 * `lazyRawStorage` — one open shared by every call on the proxy, a failed open forgotten so the
 * next call retries, and an iterator method that opens only once iteration starts.
 *
 * The one-line delegating methods are not tested one by one: each takes its signature from
 * `IRawStorage`, so a wrong delegation is a type error.
 */
import { describe, expect, it } from 'vitest';
import type { IRawStorage } from '@optimystic/db-p2p';
import { lazyRawStorage } from '../../src/edge-node/lazy-raw-storage.js';

const METADATA = { tag: 'metadata' };
const REVISIONS = [{ tag: 'rev-1' }, { tag: 'rev-2' }];

/** Stands in for an opened storage; only the methods these tests call. */
function fakeStorage(calls: { metadata: string[]; listRevisions: [string, number, number][] }): IRawStorage {
	const storage: Pick<IRawStorage, 'getMetadata' | 'listRevisions'> = {
		getMetadata: async (blockId) => {
			calls.metadata.push(blockId);
			return METADATA as never;
		},
		listRevisions: async function* (blockId, startRev, endRev) {
			calls.listRevisions.push([blockId, startRev, endRev]);
			yield* REVISIONS as never[];
		},
	};
	return storage as IRawStorage;
}

/** An opener that records each open and fails the first `failures` of them. */
function opener(failures: Error[] = []) {
	const calls = { opens: 0, metadata: [] as string[], listRevisions: [] as [string, number, number][] };
	const opened: IRawStorage[] = [];
	const open = async (): Promise<IRawStorage> => {
		calls.opens += 1;
		const failure = failures.shift();
		if (failure) throw failure;
		const storage = fakeStorage(calls);
		opened.push(storage);
		return storage;
	};
	return { open, calls, opened };
}

describe('lazyRawStorage', () => {
	it('opens once, however many operations run, the first ones concurrently', async () => {
		const { open, calls, opened } = opener();
		const storage = lazyRawStorage(open, 'power-loss');

		await Promise.all([storage.getMetadata('x'), storage.getMetadata('y')]);
		await storage.getMetadata('later');

		expect(calls.opens).toBe(1);
		expect(opened).toHaveLength(1);
		expect(calls.metadata).toEqual(['x', 'y', 'later']);
		expect(storage.durability).toBe('power-loss');
	});

	it('reports a failed open to the operations awaiting it, then retries on the next one', async () => {
		const openError = new Error('database not ready');
		const { open, calls } = opener([openError]);
		const storage = lazyRawStorage(open, 'power-loss');

		const outcomes = await Promise.allSettled([storage.getMetadata('x'), storage.getMetadata('y')]);

		expect(outcomes).toEqual([
			{ status: 'rejected', reason: openError },
			{ status: 'rejected', reason: openError },
		]);
		expect(calls.opens).toBe(1);

		expect<unknown>(await storage.getMetadata('z')).toBe(METADATA);
		expect(calls.opens).toBe(2);
	});

	it('streams listRevisions from the delegate, opening only once iteration starts', async () => {
		const { open, calls } = opener();

		const revisions = lazyRawStorage(open, 'power-loss').listRevisions('block', 3, 7);
		expect(calls.opens).toBe(0);

		const yielded: unknown[] = [];
		for await (const revision of revisions) yielded.push(revision);

		expect(yielded).toEqual(REVISIONS);
		expect(calls.listRevisions).toEqual([['block', 3, 7]]);
		expect(calls.opens).toBe(1);
	});
});
