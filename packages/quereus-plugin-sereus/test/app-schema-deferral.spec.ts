import { describe, it, expect } from 'vitest';
import { Database, type SqlValue } from '@quereus/quereus';
import type { ICohortReachability } from '@optimystic/db-core';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { applyAppSchema, applyAppSchemaAfterQueue, applyRegistrations } from '../src/compose-strand.js';

/**
 * Step 7 of `composeStrand` when queued offline transactions refuse the sApp schema apply: the
 * strand keeps the `App` schema it had and the apply lands once the queue drains. The Optimystic
 * plugin is registered directly on the `local` transactor, with a reachability gate that holds the
 * queue closed in place of the cohort a network strand would wait for.
 */

const SCHEMA = 'table Note (Id integer primary key, Body text)';
const UPGRADED = `${SCHEMA}\nindex NoteByBody on Note (Body)`;

/** Closed until {@link open}, which wakes the drain as a peer connecting does. */
class Gate implements ICohortReachability {
	private isOpen = false;
	private readonly listeners = new Set<() => void>();
	readonly reachable = (): Promise<boolean> => Promise.resolve(this.isOpen);
	readonly onChange = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	open(): void {
		this.isOpen = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
	}
}

function registerOffline(db: Database, gate: Gate) {
	const plugin = optimysticPlugin(db, {
		default_transactor: 'local',
		default_key_network: 'libp2p',
		offline: {},
	} as unknown as Record<string, SqlValue>);
	applyRegistrations(db, plugin);
	plugin.collectionFactory.registerCohortReachability('local:libp2p', gate);
	db.setDefaultVtabName('optimystic');
	db.setDefaultVtabArgs({ networkName: 'app-schema-deferral', transactor: 'local', keyNetwork: 'libp2p' });
	return plugin;
}

async function selectAll(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

const noteIndexes = (db: Database): string[] =>
	(db.schemaManager.findTable('Note', 'App')!.indexes ?? []).map(index => index.name);

describe('applyAppSchemaAfterQueue', () => {
	it('defers an apply queued transactions refuse, and applies it once they drain', async () => {
		const db = new Database();
		const gate = new Gate();
		const plugin = registerOffline(db, gate);
		try {
			await applyAppSchema(db, SCHEMA);
			plugin.offline.enter();
			await db.exec(`insert into App.Note (Id, Body) values (1, 'queued')`);
			// A connect applies its schema before the app can enter the mode: the queue it meets is
			// what `hydrate` restored.
			plugin.offline.exit();
			const [queued] = plugin.offline.entries();
			expect(queued?.status.kind).toBe('queued');

			const apply = await applyAppSchemaAfterQueue(db, UPGRADED, plugin.offline, new AbortController().signal);
			expect(apply.appSchemaDeferredBy).toEqual([queued!.transactionId]);
			expect(noteIndexes(db)).toEqual([]);
			expect(await selectAll(db, 'select Id, Body from App.Note')).toEqual([{ Id: 1, Body: 'queued' }]);

			gate.open();
			expect(await apply.appSchema).toEqual({ state: 'applied', deferred: true });
			expect(noteIndexes(db)).toEqual(['NoteByBody']);
		} finally {
			db.close();
			await plugin.dispose();
		}
	});
});
