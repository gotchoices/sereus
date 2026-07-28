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
 * End-to-end suite for the `Strand` membership/RBAC schema being applied to every
 * strand by the shared composition (`composeStrand`), alongside the sApp schema.
 *
 * These tests run in bootstrap mode (real libp2p node + real FileRawStorage +
 * the optimystic local transactor) so they exercise the real apply/hydrate/DML
 * path, not a fake. They construct their own `Header`/membership rows directly
 * via `db.exec(... with context ...)`; runtime population of membership rows is
 * owned by `strand-membership-lifecycle-population`, not this ticket.
 *
 * Scope note: this ticket applies the schema and proves the constraints are
 * active (bootstrap accepted, unauthorized rejected). It does NOT sign writes —
 * the rejection cases reject because no matching `Manager`/`Header` row exists,
 * which is the same gate the (later) signed flows will satisfy with real ed25519
 * signatures.
 */

/** The six membership tables the Strand schema must expose on every strand. */
const STRAND_TABLES = ['Header', 'Invite', 'ConsumedInvite', 'Member', 'MemberPeer', 'Manager'] as const;

async function selectCount(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return (row as { c: number }).c;
	}
	throw new Error('count query returned no rows');
}

/**
 * Insert the singleton `Header` with the given Type. Every Header column is
 * NOT NULL (Quereus defaults unqualified columns to NOT NULL), so all are
 * supplied with placeholder values — only `Type` is load-bearing for these tests
 * (it drives the `OnlyClosed` constraints).
 */
async function insertHeader(db: Database, type: 'o' | 'c'): Promise<void> {
	await db.exec(
		`insert into Strand.Header
			(Id, Type, sAppId, sAppVersion, sAppSchema, sAppSignature, Engine, EngineVersion)
			values (?, ?, ?, ?, ?, ?, ?, ?)`,
		['strand-id', type, 'sapp', '1.0.0', 'schema', 'sig', 'engine', '1.0.0'],
	);
}

describe('Strand membership schema (apply e2e)', () => {
	let storageDir: string;
	let db: Database | null = null;
	let result: SereusPluginResult | null = null;

	beforeEach(async () => {
		storageDir = path.join(os.tmpdir(), 'sereus-strand-schema-e2e', randomUUID());
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

	it('applies the Strand schema on a fresh strand and coexists with the sApp schema', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, {
			strandId,
			mode: 'bootstrap',
			storage,
			// An sApp schema is also supplied to prove the two schemas coexist.
			schema: 'table Note (Id integer primary key, Body text not null)',
		});

		// All six membership tables are queryable (empty, but no error).
		for (const table of STRAND_TABLES) {
			expect(await selectCount(db, `select count(*) as c from Strand.${table}`)).toBe(0);
		}

		// Strand.* and App.* coexist in the same DB without name collision.
		expect(await selectCount(db, 'select count(*) as c from App.Note')).toBe(0);
		expect(await selectCount(db, 'select count(*) as c from Strand.Member')).toBe(0);
	});

	it('applies the Strand schema even when no sApp schema is supplied', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		// No `schema` option: the Strand schema must still be applied unconditionally.
		result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });

		expect(await selectCount(db, 'select count(*) as c from Strand.Manager')).toBe(0);

		// App.* must still be absent (no sApp schema was applied).
		await expect(async () => {
			for await (const _row of db!.eval('select count(*) as c from App.Note')) {
				// unreachable
			}
		}).rejects.toThrow();
	});

	it('re-applies cleanly on a warm restart (hydrate primes the persisted membership tables)', async () => {
		const strandId = randomUUID();

		// Cold session: apply schema, insert a closed Header + founding Member, shut down.
		{
			const storage1 = new FileRawStorage(storageDir);
			const db1 = new Database();
			const r1 = await connectToStrand(db1, { strandId, mode: 'bootstrap', storage: storage1 });
			try {
				expect(r1.hydrated).toEqual({ tables: 0, indexes: 0 });
				await insertHeader(db1, 'c');
				await db1.exec(
					`insert into Strand.Member (Key)
						with context ManagerKey = null, ManagerSignature = null
						values (?)`,
					['m1'],
				);
			} finally {
				await r1.shutdown();
				db1.close();
			}
		}

		// Warm session: fresh Database + FileRawStorage over the same dir/strandId.
		const storage2 = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage: storage2 });

		// Hydrate actually ran on reopen and surfaced the persisted membership tables,
		// so `apply schema Strand;` diffs against a primed catalog (no churn).
		expect(result.hydrated).toBeDefined();
		expect(result.hydrated!.tables).toBeGreaterThan(0);

		// The persisted membership data survives and the tables are still queryable.
		expect(await selectCount(db, 'select count(*) as c from Strand.Member')).toBe(1);
		expect(await selectCount(db, 'select count(*) as c from Strand.Header')).toBe(1);
	});

	it('accepts the bootstrap founding Member and Manager in a closed strand', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });

		await insertHeader(db, 'c');

		// First Member: the `count(Member) <= 1` bootstrap branch — no manager needed.
		await db.exec(
			`insert into Strand.Member (Key)
				with context ManagerKey = null, ManagerSignature = null
				values (?)`,
			['m1'],
		);
		expect(await selectCount(db, 'select count(*) as c from Strand.Member')).toBe(1);

		// First Manager: the `count(Manager) <= 1` bootstrap branch — no manager needed.
		await db.exec(
			`insert into Strand.Manager (MemberKey, Generation)
				with context ManagerKey = null, Signature = null
				values (?, 0)`,
			['m1'],
		);
		expect(await selectCount(db, 'select count(*) as c from Strand.Manager')).toBe(1);
	});

	it('rejects unauthorized membership writes in a closed strand (constraints active)', async () => {
		const strandId = randomUUID();
		const storage = new FileRawStorage(storageDir);
		db = new Database();
		result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });

		await insertHeader(db, 'c');
		// Bootstrap the founder so the strand is past the `count <= 1` branch.
		await db.exec(
			`insert into Strand.Member (Key)
				with context ManagerKey = null, ManagerSignature = null
				values (?)`,
			['m1'],
		);
		await db.exec(
			`insert into Strand.Manager (MemberKey, Generation)
				with context ManagerKey = null, Signature = null
				values (?, 0)`,
			['m1'],
		);

		// A second Member that is neither manager-signed nor invite-backed: rejected
		// by Member.Authorized (count is now 2, no matching Manager for a null key,
		// no ConsumedInvite). The reject IS the proof the constraint is active — it
		// fires the same SQL shape the accepted bootstrap case above used, so this is
		// a genuine constraint failure, not a parse/no-op artifact. The deferred
		// (subquery-bearing) CHECK rejection is also atomic: the optimystic transactor
		// rolls the violating row back, so the Member count is unchanged afterward
		// (regression guard for optimystic-deferred-constraint-rejection-not-rolled-back).
		const memberCountBefore = await selectCount(db, 'select count(*) as c from Strand.Member');
		await expect(
			db.exec(
				`insert into Strand.Member (Key)
					with context ManagerKey = null, ManagerSignature = null
					values (?)`,
				['m2'],
			),
		).rejects.toThrow();
		expect(await selectCount(db, 'select count(*) as c from Strand.Member')).toBe(memberCountBefore);

		// An Invite with no valid issuing Manager: rejected by Invite.InviteValid
		// (no Manager row matches the non-existent ManagerKey). The rejected row
		// must not survive the deferred-constraint rollback.
		await expect(
			db.exec(
				`insert into Strand.Invite (Key, Expiration)
					with context ManagerKey = ?, ManagerSignature = null, InviteSignature = null
					values (?, null)`,
				['nobody', 'inv1'],
			),
		).rejects.toThrow();
		expect(await selectCount(db, 'select count(*) as c from Strand.Invite')).toBe(0);
	});

	it('enforces OnlyClosed: membership inserts fail in an open strand, succeed in a closed one', async () => {
		// Open strand: OnlyClosed must reject Member / Manager / Invite inserts even
		// though the row would otherwise satisfy its bootstrap branch. Each rejection
		// is a deferred-constraint failure that the optimystic transactor rolls back,
		// so the target table is left empty (regression guard for
		// optimystic-deferred-constraint-rejection-not-rolled-back).
		{
			const strandId = randomUUID();
			const storage = new FileRawStorage(storageDir);
			const dbOpen = new Database();
			const rOpen = await connectToStrand(dbOpen, { strandId, mode: 'bootstrap', storage });
			try {
				await insertHeader(dbOpen, 'o');

				await expect(
					dbOpen.exec(
						`insert into Strand.Member (Key)
							with context ManagerKey = null, ManagerSignature = null
							values (?)`,
						['m1'],
					),
				).rejects.toThrow();
				expect(await selectCount(dbOpen, 'select count(*) as c from Strand.Member')).toBe(0);

				await expect(
					dbOpen.exec(
						`insert into Strand.Manager (MemberKey, Generation)
							with context ManagerKey = null, Signature = null
							values (?, 0)`,
						['m1'],
					),
				).rejects.toThrow();
				expect(await selectCount(dbOpen, 'select count(*) as c from Strand.Manager')).toBe(0);

				await expect(
					dbOpen.exec(
						`insert into Strand.Invite (Key, Expiration)
							with context ManagerKey = null, ManagerSignature = null, InviteSignature = null
							values (?, null)`,
						['inv1'],
					),
				).rejects.toThrow();
				expect(await selectCount(dbOpen, 'select count(*) as c from Strand.Invite')).toBe(0);
			} finally {
				await rOpen.shutdown();
				dbOpen.close();
			}
		}

		// Closed strand (fresh dir/strandId): the same first-Member insert now succeeds,
		// proving Header.Type is what flips the OnlyClosed gate.
		{
			const closedDir = path.join(os.tmpdir(), 'sereus-strand-schema-e2e', randomUUID());
			await fs.mkdir(closedDir, { recursive: true });
			const strandId = randomUUID();
			const storage = new FileRawStorage(closedDir);
			db = new Database();
			result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });

			await insertHeader(db, 'c');
			await db.exec(
				`insert into Strand.Member (Key)
					with context ManagerKey = null, ManagerSignature = null
					values (?)`,
				['m1'],
			);
			expect(await selectCount(db, 'select count(*) as c from Strand.Member')).toBe(1);

			await fs.rm(closedDir, { recursive: true, force: true });
		}
	});
});
