import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '../../src/connect.js';

/**
 * `createEmptyCollections` commits a collection for every declared table that has none, and
 * only for those. The reopen is the proof: a second connection over the same storage opens
 * every tree (main, index and unique-enforcement) as already committed, so it finds nothing
 * left to create. A collection the first pass staged but did not write would open invented
 * again and be counted.
 */

const SCHEMA = `
	table Post (Id integer primary key, Author text not null, Body text not null);
	index PostByAuthor on Post (Author);
`;

async function connect(strandId: string, storage: MemoryRawStorage): Promise<{ db: Database; result: Awaited<ReturnType<typeof connectToStrand>> }> {
	const db = new Database();
	const result = await connectToStrand(db, { strandId, transactor: 'local', storage, schema: SCHEMA });
	return { db, result };
}

describe('createEmptyCollections', () => {
	it('commits every declared table\'s collections once, so a reopen finds none to create', async () => {
		const strandId = randomUUID();
		const storage = new MemoryRawStorage();

		const founding = await connect(strandId, storage);
		try {
			expect(await founding.result.createEmptyCollections()).toBeGreaterThan(0);
		} finally {
			await founding.result.shutdown();
			founding.db.close();
		}

		const reopened = await connect(strandId, storage);
		try {
			expect(await reopened.result.createEmptyCollections()).toBe(0);
		} finally {
			await reopened.result.shutdown();
			reopened.db.close();
		}
	});
});
