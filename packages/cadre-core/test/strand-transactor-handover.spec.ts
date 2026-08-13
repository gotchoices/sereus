import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { Database } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { tempStorageDir } from './control-db-node-helpers.js';

/**
 * **The migration case for retiring the strand `bootstrap` mode: bytes written
 * by the LOCAL transactor, read — and appended to — through the NETWORK
 * transactor.**
 *
 * Every strand on every device that has ever run solo has its blocks on disk
 * written by the local transactor. After the retirement
 * (`retire-strand-mode-in-cadre-core`), those same bytes are read and extended
 * through the network transactor. Both paths write through the same
 * `StorageRepo`, so this is expected to work — and it is the one place a silent
 * data-visibility regression could hide, which is why it gets a spec rather
 * than an argument.
 *
 * Phase 1 uses the plugin's `transactor: 'local'` option, NOT
 * `mode: 'bootstrap'`: `transactor` is the knob that survives ticket three
 * (`drop-strand-mode-option-from-sql-plugin`), so this spec needs no edit when
 * the mode goes away.
 *
 * Phase 2 builds a FRESH `FileRawStorage` over the same directory, so only the
 * bytes on disk cross the phase boundary — the idiom
 * `control-database-solo-warm-start.spec.ts` established (nothing survives in
 * the heap; a handover that only appears to work because the old storage object
 * was still around cannot pass).
 *
 * Each phase boots a real (isolated, empty-bootstrap-list) libp2p node via
 * `connectToStrand`, so the timeout is generous.
 *
 * NOTE: this spec cannot assert that phase 1 really ran on the local transactor —
 * `SereusPluginResult` does not report the resolved transactor, so a phase 1 whose
 * `transactor` option went unread would degrade this into a network→network test
 * that still passes. It is the retirement's data-safety evidence, and
 * `tickets/implement/13-drop-strand-mode-option-from-sql-plugin.md` is the ticket
 * that rewrites that option — its arm adds the resolved transactor to the result
 * so both phases can pin their arm here.
 */

const SCHEMA = 'create table Note (Id text primary key, Body text not null);';

/** Rows the local-transactor era writes; the network era must see every one. */
const GEN1_IDS = ['gen1-a', 'gen1-b', 'gen1-c'];
/** The row the network-transactor era appends over the inherited bytes. */
const GEN2_ID = 'gen2-a';

async function insertNote(db: Database, id: string, body: string): Promise<void> {
	await db.exec('insert into App.Note (Id, Body) values (?, ?)', [id, body]);
}

async function selectNoteIds(db: Database): Promise<Set<string>> {
	const ids = new Set<string>();
	for await (const row of db.eval('select Id from App.Note')) {
		ids.add(row.Id as string);
	}
	return ids;
}

describe('strand transactor handover: local-transactor blocks under the network transactor', () => {
	it('reads and appends, through the network transactor, a store the local transactor wrote', async () => {
		const dir = tempStorageDir('handover');
		const strandId = `handover-${Math.random().toString(36).slice(2)}`;
		try {
			// --- Phase 1: the solo era — local transactor writes real files -------
			const db1 = new Database();
			const era1 = await connectToStrand(db1, {
				strandId,
				schema: SCHEMA,
				transactor: 'local',
				storage: new FileRawStorage(dir)
			});
			try {
				for (const id of GEN1_IDS) {
					await insertNote(db1, id, `written by the local transactor: ${id}`);
				}
				expect(await selectNoteIds(db1)).toEqual(new Set(GEN1_IDS));
			} finally {
				// `shutdown` stops the libp2p node this connect created; a leaked node
				// keeps vitest alive.
				await era1.shutdown();
				db1.close();
			}

			// --- Phase 2: the same directory, a fresh storage, network transactor -
			// `transactor` deliberately omitted: the default ('network') is exactly
			// what every strand runs on after the retirement.
			const db2 = new Database();
			const era2 = await connectToStrand(db2, {
				strandId,
				schema: SCHEMA,
				storage: new FileRawStorage(dir)
			});
			try {
				// The catalog HYDRATED from the local era's persisted schemas rather
				// than being re-created — a re-create would mask a store the network
				// transactor cannot actually read.
				expect(era2.hydrated, 'composition finished without running hydrate').toBeDefined();
				expect(era2.hydrated!.tables,
					'phase 2 hydrated zero tables — the network transactor did not read the catalog the local transactor persisted'
				).toBeGreaterThan(0);

				// Every local-era row is still visible through the network transactor.
				expect(await selectNoteIds(db2)).toEqual(new Set(GEN1_IDS));

				// And the inherited store ACCEPTS a network-transactor commit.
				await insertNote(db2, GEN2_ID, 'appended by the network transactor');
				expect(await selectNoteIds(db2)).toEqual(new Set([...GEN1_IDS, GEN2_ID]));
			} finally {
				await era2.shutdown();
				db2.close();
			}
		} finally {
			// `force` so a failure before phase 1 wrote anything still cleans up; the
			// retries are for Windows, where a straggling file handle raises EBUSY.
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	}, 120_000);
});
