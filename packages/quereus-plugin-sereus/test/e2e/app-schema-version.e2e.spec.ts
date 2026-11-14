import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database, type SqlValue } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '../../src/connect.js';
import type { VersionedAppSchema } from '../../src/app-schema.js';
import { AppSchemaOutdatedError, appSchemaRefusalOf } from '../../src/app-schema-errors.js';

/**
 * gotchoices/sereus#59: a member whose app declares an older App schema version must not open a
 * strand a newer version was applied to, or its declarative diff drops what the newer version
 * added. Each connection over the one store stands for a member; the last proves the refused
 * connect changed nothing.
 */

const V1 = 'table T (Id integer primary key, A text)';
const V2 = 'table T (Id integer primary key, A text, B text null)';

async function selectAll(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

/** Connect as a member running `app`, run `use`, and shut down, so the next member opens the same store. */
async function asMember(strandId: string, storage: MemoryRawStorage, app: VersionedAppSchema, use: (db: Database) => Promise<void>): Promise<void> {
	const db = new Database();
	const result = await connectToStrand(db, { strandId, transactor: 'local', storage, ...app });
	try {
		await use(db);
	} finally {
		await result.shutdown();
		db.close();
	}
}

describe('App schema version gate', () => {
	it('refuses a member below the version the strand records, and applies nothing for it', async () => {
		const strandId = randomUUID();
		const storage = new MemoryRawStorage();
		await asMember(strandId, storage, { schema: V1, schemaVersion: 1 }, db => db.exec(`insert into App.T (Id, A) values (1, 'a')`));
		await asMember(strandId, storage, { schema: V2, schemaVersion: 2 }, db => db.exec(`update App.T set B = 'b'`));

		const db = new Database();
		try {
			const refusal: unknown = await connectToStrand(db, { strandId, transactor: 'local', storage, schema: V1, schemaVersion: 1 })
				.then(async result => { await result.shutdown(); return undefined; }, (err: unknown) => err);
			expect(refusal).toBeInstanceOf(AppSchemaOutdatedError);
			expect(refusal).toMatchObject({ appSchemaVersion: 1, strandSchemaVersion: 2 });
			expect(appSchemaRefusalOf(refusal)).toBe(refusal);
		} finally {
			db.close();
		}

		await asMember(strandId, storage, { schema: V2, schemaVersion: 2 }, async db => {
			expect(await selectAll(db, 'select A, B from App.T')).toEqual([{ A: 'a', B: 'b' }]);
		});
	});
});
