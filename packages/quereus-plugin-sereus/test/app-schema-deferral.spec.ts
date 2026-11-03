import { describe, it, expect } from 'vitest';
import { Database, type SqlValue } from '@quereus/quereus';
import { PromiseShortfallError, type ICohortReachability, type ITransactor } from '@optimystic/db-core';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { applyRegistrations } from '../src/compose-strand.js';
import { applyAppSchema, applyAppSchemaOrDefer, type PeerConnectEvents } from '../src/app-schema.js';

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

function registerOnline(db: Database) {
	const plugin = optimysticPlugin(db, {
		default_transactor: 'local',
		default_key_network: 'libp2p',
	} as unknown as Record<string, SqlValue>);
	applyRegistrations(db, plugin);
	db.setDefaultVtabName('optimystic');
	db.setDefaultVtabArgs({ networkName: 'app-schema-deferral', transactor: 'local', keyNetwork: 'libp2p' });
	return plugin;
}

type TransactorOptions = Parameters<ReturnType<typeof registerOnline>['collectionFactory']['createTransactor']>[0];

async function selectAll(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const row of db.eval(sql)) {
		rows.push(row);
	}
	return rows;
}

const noteIndexes = (db: Database): string[] =>
	(db.schemaManager.findTable('Note', 'App')!.indexes ?? []).map(index => index.name);

/**
 * `Note` with one row queued, as a connect meets it: it applies its schema before the app can enter
 * the mode, so the queue it meets is what `hydrate` restored.
 */
async function queueOneNote(db: Database, plugin: ReturnType<typeof registerOffline>) {
	await applyAppSchema(db, SCHEMA);
	plugin.offline.enter();
	await db.exec(`insert into App.Note (Id, Body) values (1, 'queued')`);
	plugin.offline.exit();
	const [queued] = plugin.offline.entries();
	expect(queued?.status.kind).toBe('queued');
	return queued!;
}

describe('applyAppSchemaOrDefer', () => {
	it('defers an apply queued transactions refuse, and applies it once they drain', async () => {
		const db = new Database();
		const gate = new Gate();
		const plugin = registerOffline(db, gate);
		try {
			const queued = await queueOneNote(db, plugin);

			const apply = await applyAppSchemaOrDefer(db, UPGRADED, { queue: plugin.offline }, new AbortController().signal);
			expect(apply.appSchemaWaitingFor).toBe('queue');
			expect(apply.appSchemaDeferredBy).toEqual([queued.transactionId]);
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

	it('waits for a transaction the app holds open to end instead of applying inside it', async () => {
		const db = new Database();
		const gate = new Gate();
		const plugin = registerOffline(db, gate);
		try {
			await queueOneNote(db, plugin);
			const apply = await applyAppSchemaOrDefer(db, UPGRADED, { queue: plugin.offline }, new AbortController().signal);

			await db.beginTransaction();
			await db.exec(`insert into App.Note (Id, Body) values (2, 'rolled back')`);
			gate.open();
			await plugin.offline.whenDrained();
			// Room for the retry to meet the open transaction before the app rolls it back.
			await new Promise(resolve => setTimeout(resolve, 50));
			await db.rollback();

			expect(await apply.appSchema).toEqual({ state: 'applied', deferred: true });
			const [report] = await plugin.verifyIndexes(db, 'Note', 'App');
			expect(report).toMatchObject({ index: 'NoteByBody', missing: [], orphaned: [] });
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	describe('when the cohort refuses the closing catalog commit', () => {
		const WITH_EXTRA = 'table Note (Id integer primary key, Body text, Extra text null)';

		/** The store, shared by the databases a test opens as a restart would. Refuses writes while `down`. */
		async function refusingStore() {
			const seed = new Database();
			const seedPlugin = registerOnline(seed);
			const local = await seedPlugin.collectionFactory.createTransactor({ transactor: 'local', keyNetwork: 'libp2p' } as TransactorOptions);
			const store = { down: false, transactor: local };
			store.transactor = new Proxy(local, {
				get(target, property) {
					const member = Reflect.get(target, property) as unknown;
					if (typeof member !== 'function') {
						return member;
					}
					if (property !== 'pend' && property !== 'commit') {
						return member.bind(target) as unknown;
					}
					return (...args: unknown[]): unknown => {
						if (store.down) {
							throw new PromiseShortfallError({ approvals: 1, rejections: 0, peerCount: 2, needed: 2, silentPeers: ['absent-member'] });
						}
						return (member as (...a: unknown[]) => unknown).apply(target, args);
					};
				},
			});
			return store;
		}

		/** A database over `transactor`, hydrated from the store as a connect is. */
		async function open(transactor: ITransactor) {
			const db = new Database();
			const plugin = registerOnline(db);
			plugin.collectionFactory.registerTransactor('local:libp2p', transactor);
			await plugin.hydrate(db);
			return { db, plugin };
		}

		async function close({ db, plugin }: Awaited<ReturnType<typeof open>>): Promise<void> {
			db.close();
			await plugin.dispose();
		}

		/** Peer connects a test can fire, which wake a retry waiting for the cohort. */
		function peerEvents() {
			const target = new EventTarget();
			return {
				peers: target as unknown as PeerConnectEvents,
				connect: (): void => { target.dispatchEvent(new Event('peer:connect')); },
			};
		}

		it.each([
			['an added index', UPGRADED],
			['an added table', `${SCHEMA}\ntable Later (Id integer primary key)`],
			['an added nullable column', WITH_EXTRA],
		])('keeps the earlier schema through %s, and a retry saves it once the cohort returns', async (_change, upgraded) => {
			const store = await refusingStore();
			const founding = await open(store.transactor);
			await applyAppSchema(founding.db, SCHEMA);
			await founding.db.exec(`insert into App.Note (Id, Body) values (1, 'kept')`);
			await close(founding);

			const restarted = await open(store.transactor);
			const { db } = restarted;
			const { peers, connect } = peerEvents();
			const released = new AbortController();
			try {
				store.down = true;
				const apply = await applyAppSchemaOrDefer(db, upgraded, { peers }, released.signal);
				expect(apply.appSchemaWaitingFor).toBe('cohort');
				expect(noteIndexes(db)).toEqual([]);
				expect(db.schemaManager.findTable('Later', 'App')).toBeUndefined();

				// A retry that still meets the refusal keeps waiting: past the 2 s a connect settles for.
				connect();
				await new Promise(resolve => setTimeout(resolve, 2_500));
				expect(await Promise.race([apply.appSchema, Promise.resolve('waiting')])).toBe('waiting');

				store.down = false;
				connect();
				expect(await apply.appSchema).toEqual({ state: 'applied', deferred: true });
			} finally {
				released.abort();
				await close(restarted);
			}

			// With the store refusing writes again, a fresh database finds nothing to send.
			store.down = true;
			const reopened = await open(store.transactor);
			try {
				await applyAppSchema(reopened.db, upgraded);
				expect(await selectAll(reopened.db, 'select Id, Body from App.Note')).toEqual([{ Id: 1, Body: 'kept' }]);
				expect(await selectAll(reopened.db, `select Id from App.Note where Body = 'kept'`)).toEqual([{ Id: 1 }]);
			} finally {
				await close(reopened);
			}
		}, 30_000);

		it('fails a refused apply that dropped a column, instead of retrying it to a false success', async () => {
			const store = await refusingStore();
			const founding = await open(store.transactor);
			await applyAppSchema(founding.db, WITH_EXTRA);
			await close(founding);

			const restarted = await open(store.transactor);
			try {
				store.down = true;
				await expect(applyAppSchemaOrDefer(restarted.db, SCHEMA, {}, new AbortController().signal))
					.rejects.toThrow(/super-majority/);
			} finally {
				await close(restarted);
			}
		}, 30_000);
	});
});
