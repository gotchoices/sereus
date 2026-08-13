import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { connectToStrand } from '../../src/connect.js';
import type { SereusPluginResult } from '../../src/types.js';

/**
 * End-to-end suite for the `local` transactor — a strand database running
 * entirely in this process, consulting no peers: real libp2p node + real
 * FileRawStorage + the real optimystic plugin's local transactor. No `vi.mock`
 * calls — the sibling unit spec's `vi.mock('@optimystic/db-p2p', ...)` is scoped
 * to that file by Vitest, so this file inherits no fakes.
 *
 * The headline assertion is the persistence test: data written by one
 * `connectToStrand({ transactor: 'local', storage })` call must be readable by
 * a second connection built over the same storage directory after the first has
 * shut down. This closes the cold-start loop deferred to the host app in
 * tickets/complete/1-wire-strand-storage-into-bootstrap-transactor.md.
 *
 * Applications run on the default `network` transactor (covered by
 * `networked.e2e.spec.ts`); `local` is for in-process tests and tooling.
 */

const TEST_SCHEMA = 'table Msg (Id integer primary key, Body text not null)';

describe('connectToStrand (local transactor e2e)', () => {
	let storageDir: string;
	let db: Database | null = null;
	let result: SereusPluginResult | null = null;

	beforeEach(async () => {
		storageDir = path.join(os.tmpdir(), 'sereus-plugin-e2e', randomUUID());
		await fs.mkdir(storageDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			if (result) {
				await result.shutdown();
				result = null;
			}
		} catch (err) {
			console.error('shutdown error in afterEach:', err);
		}
		try {
			if (db) {
				db.close();
				db = null;
			}
		} catch (err) {
			console.error('db.close error in afterEach:', err);
		}
		await fs.rm(storageDir, { recursive: true, force: true });
	});

	it('runs CRUD round-trip in a single local-transactor connection', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId,
			transactor: 'local',
			storage,
			schema: TEST_SCHEMA,
		});

		// The option landed: everything below really is the local transactor, not
		// the network one silently resolving a lone node against itself.
		expect(result.transactor).toBe('local');

		await db.exec(`insert into App.Msg(Id, Body) values (1,'a'),(2,'b'),(3,'c')`);

		const countRows: Array<{ c: number }> = [];
		for await (const row of db.eval('select count(*) as c from App.Msg')) {
			countRows.push(row as { c: number });
		}
		expect(countRows[0].c).toBe(3);

		await db.exec(`update App.Msg set Body='B' where Id=2`);
		const updatedRows: Array<{ Body: string }> = [];
		for await (const row of db.eval('select Body from App.Msg where Id=2')) {
			updatedRows.push(row as { Body: string });
		}
		expect(updatedRows).toHaveLength(1);
		expect(updatedRows[0].Body).toBe('B');

		await db.exec(`delete from App.Msg where Id=1`);
		const afterDelete: Array<{ c: number }> = [];
		for await (const row of db.eval('select count(*) as c from App.Msg')) {
			afterDelete.push(row as { c: number });
		}
		expect(afterDelete[0].c).toBe(2);
	});

	it('persists DML across reopen of the same storage path', async () => {
		const strandId = randomUUID();

		// First session: insert and shutdown.
		{
			const storage1 = new FileRawStorage(storageDir);
			const db1 = new Database();
			const r1 = await connectToStrand(db1, {
				strandId,
				transactor: 'local',
				storage: storage1,
				schema: TEST_SCHEMA,
			});
			try {
				await db1.exec(`insert into App.Msg(Id, Body) values (42, 'persisted')`);
			} finally {
				await r1.shutdown();
				db1.close();
			}
		}

		// Second session: fresh Database, fresh FileRawStorage over the same dir,
		// same strandId. Schema apply should be a no-op (declarative-schema diff).
		const storage2 = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId,
			transactor: 'local',
			storage: storage2,
			schema: TEST_SCHEMA,
		});

		const rows: Array<{ Id: number; Body: string }> = [];
		for await (const row of db.eval('select Id, Body from App.Msg')) {
			rows.push(row as { Id: number; Body: string });
		}
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ Id: 42, Body: 'persisted' });
	});

	it('hydrates the catalog from a persisted multi-table+index schema on warm restart', async () => {
		const strandId = randomUUID();

		// A non-trivial schema: two tables plus an explicit index. This is what a
		// 2-column single-table schema (the `persists DML` case above) cannot
		// catch — the regression is that without a pre-`apply schema` hydrate, a
		// warm restart re-emits CREATE TABLE / CREATE INDEX for every persisted
		// object instead of seeing them already in the catalog.
		const HYDRATE_SCHEMA = `
			table Account (Id integer primary key, Name text not null);
			table Post (Id integer primary key, AccountId integer not null, Body text not null);
			index PostByAccount on Post (AccountId);
		`;

		// First (cold) session: apply schema + insert, then shut down. Cold start
		// has nothing persisted yet, so hydrate is a no-op.
		{
			const storage1 = new FileRawStorage(storageDir);
			const db1 = new Database();
			const r1 = await connectToStrand(db1, {
				strandId,
				transactor: 'local',
				storage: storage1,
				schema: HYDRATE_SCHEMA,
			});
			try {
				expect(r1.hydrated).toEqual({ tables: 0, indexes: 0 });
				await db1.exec(`insert into App.Account(Id, Name) values (1, 'alice')`);
				await db1.exec(`insert into App.Post(Id, AccountId, Body) values (1, 1, 'hello')`);
			} finally {
				await r1.shutdown();
				db1.close();
			}
		}

		// Second (warm) session: fresh Database + FileRawStorage over the same dir,
		// same strandId. Hydrate MUST prime the catalog from the persisted vtab
		// schemas before `apply schema App;` so the declarative diff is a no-op.
		const storage2 = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId,
			transactor: 'local',
			storage: storage2,
			schema: HYDRATE_SCHEMA,
		});

		// The headline regression assertion: hydration actually ran on reopen and
		// surfaced the persisted tables AND the index.
		expect(result.hydrated).toBeDefined();
		expect(result.hydrated!.tables).toBeGreaterThan(0);
		expect(result.hydrated!.indexes).toBeGreaterThan(0);

		// Persisted data survives and both hydrated tables are queryable via a join.
		const rows: Array<{ Name: string; Body: string }> = [];
		for await (const row of db.eval(
			'select A.Name as Name, P.Body as Body from App.Post P join App.Account A on A.Id = P.AccountId',
		)) {
			rows.push(row as { Name: string; Body: string });
		}
		expect(rows).toEqual([{ Name: 'alice', Body: 'hello' }]);
	});

	it('rejects queries against App.* when schema is omitted', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId,
			transactor: 'local',
			storage,
		});

		await expect(async () => {
			for await (const _row of db!.eval('select * from App.Msg')) {
				// should not reach
			}
		}).rejects.toThrow();
	});

	it('releases handles cleanly so the storage path can be reused in the same process', async () => {
		const strandId = randomUUID();

		// Three open/close cycles over the same storage dir, same strand. Catches
		// leaks (file lock, libp2p socket) that only manifest on the second cycle.
		for (let i = 0; i < 3; i++) {
			const storage = new FileRawStorage(storageDir);
			const cycleDb = new Database();
			const cycleResult = await connectToStrand(cycleDb, {
				strandId,
				transactor: 'local',
				storage,
				schema: TEST_SCHEMA,
			});
			try {
				const rows: Array<{ c: number }> = [];
				for await (const row of cycleDb.eval('select count(*) as c from App.Msg')) {
					rows.push(row as { c: number });
				}
				expect(rows).toHaveLength(1);
			} finally {
				await cycleResult.shutdown();
				cycleDb.close();
			}
		}
	});
});
