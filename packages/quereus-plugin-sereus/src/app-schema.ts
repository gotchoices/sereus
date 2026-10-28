import debug from 'debug';
import { TransactionActiveError, type Database } from '@quereus/quereus';
import { QueuedEntriesBlockSchemaChangeError, QueueDisposedError } from '@optimystic/quereus-plugin-optimystic/plugin';
import type { StrandOfflineController, AppSchemaOutcome } from './types.js';

const log = debug('sereus:plugin:strand');

/**
 * Step 7 of `composeStrand`: declare the sApp's schema as `App` and apply it — a
 * declarative diff against the catalog, so re-applying a schema that is already in place
 * emits nothing. The one site that applies an `App` schema: `composeStrand` calls it at
 * bring-up (through {@link applyAppSchemaAfterQueue}, whose deferred retry shares its
 * declaration), and cadre-core's `StrandDatabase.attachAppSchema` calls it on a live storage
 * replica when an app claims the strand. The database must already be composed (optimystic
 * set as the default vtab), or the tables land in memory instead of the strand.
 *
 * Refuses a schema holding an item the Quereus parser skipped: it keeps any item whose leading
 * keyword it does not model (`create unique index …`, a misspelled `tabel`, `domain`) as an
 * opaque placeholder that apply ignores, so the app would otherwise run without that item.
 *
 * Refuses a schema holding a `seed` item: the apply runs on every node of the strand at every
 * connect, so seed inserts would put a network write on each bring-up and two nodes inserting
 * the same key at once would collide. Rows an app needs at birth are the founding app's to write.
 */
export async function applyAppSchema(db: Database, schema: string): Promise<void> {
	await declareAppSchema(db, schema);
	await db.exec('apply schema App;');
}

/** Declare `schema` as `App`, refusing the items {@link applyAppSchema} refuses. Writes nothing to the strand. */
async function declareAppSchema(db: Database, schema: string): Promise<void> {
	await db.exec(`
		declare schema App {
			${schema}
		}
	`);
	assertNoIgnoredItems(db);
	assertNoSeedItems(db);
}

/** What {@link applyAppSchemaAfterQueue} reports, in the shape `SereusPluginResult` carries it. */
export interface AppSchemaApply {
	appSchema: Promise<AppSchemaOutcome>;
	appSchemaDeferredBy?: readonly string[];
}

/**
 * Step 7 of `composeStrand`: {@link applyAppSchema}, except that an apply refused by queued
 * offline transactions (`QueuedEntriesBlockSchemaChangeError` on the error's `cause` chain) does not
 * throw. Quereus unwinds the refused apply, so `db` keeps the `App` schema it had; the apply is
 * retried in the background each time `queue` drains, for as long as the queue is what refuses it,
 * and `appSchema` settles with how that ended. Any other error from the first apply is thrown.
 *
 * Waiting for the queue before returning was rejected: offline, that withholds the strand from the
 * app right after an app update, which is when offline mode matters. So was refusing the connect:
 * the queue can drain only while the composition is alive.
 *
 * `released` is aborted when the composition shuts down; a retry not yet landed then settles
 * `cancelled`.
 *
 * A retry runs while the app is using `db`, so it is one atomic batch that refuses to run inside a
 * transaction another caller holds open, and waits for that transaction to end: run inside it, the
 * apply would be committed or rolled back with the app's rows, and a rollback leaves the index it
 * built holding entries for rows that are gone.
 */
export async function applyAppSchemaAfterQueue(
	db: Database,
	schema: string,
	queue: Pick<StrandOfflineController, 'whenDrained'>,
	released: AbortSignal,
): Promise<AppSchemaApply> {
	try {
		await applyAppSchema(db, schema);
		log('sApp schema applied');
		return { appSchema: Promise.resolve({ state: 'applied' }) };
	} catch (err) {
		const refusal = queueRefusalIn(err);
		if (!refusal) {
			throw err;
		}
		log('sApp schema apply refused by queued transactions %o; retrying once they settle', refusal.transactionIds);
		return {
			appSchema: retryAppSchemaAfterDrain(db, schema, queue, released),
			appSchemaDeferredBy: refusal.transactionIds,
		};
	}
}

async function retryAppSchemaAfterDrain(
	db: Database,
	schema: string,
	queue: Pick<StrandOfflineController, 'whenDrained'>,
	released: AbortSignal,
): Promise<AppSchemaOutcome> {
	// NOTE: this loops without a pause when `whenDrained` resolves at once while the refusal stands
	// (a segment left sealed with nothing queued, say). Upstream counts a removal still in progress
	// as undrained, so no such state is known; if one shows up as a busy loop, back off between tries.
	for (;;) {
		try {
			await queue.whenDrained();
			if (released.aborted) {
				return { state: 'cancelled' };
			}
			await declareAppSchema(db, schema);
			await db.exec('apply schema App;', undefined, { transaction: true });
			log('Deferred sApp schema applied');
			return { state: 'applied', deferred: true };
		} catch (err) {
			if (released.aborted || err instanceof QueueDisposedError) {
				log('Deferred sApp schema apply cancelled by shutdown');
				return { state: 'cancelled' };
			}
			if (err instanceof TransactionActiveError) {
				log('Deferred sApp schema apply waiting for an open transaction to end');
				await abortableDelay(OPEN_TRANSACTION_RETRY_MS, released);
				continue;
			}
			const refusal = queueRefusalIn(err);
			if (!refusal) {
				log('Deferred sApp schema apply failed: %O', err);
				return { state: 'failed', error: err };
			}
			log('sApp schema apply refused again by queued transactions %o', refusal.transactionIds);
		}
	}
}

/** The offline queue's refusal `err` is or wraps: Quereus rewraps it out of `apply schema`, keeping it as `cause`. */
function queueRefusalIn(err: unknown): QueuedEntriesBlockSchemaChangeError | undefined {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof QueuedEntriesBlockSchemaChangeError) {
			return at;
		}
	}
	return undefined;
}

/** How long a deferred sApp schema apply waits before trying again while another caller's transaction is open. */
const OPEN_TRANSACTION_RETRY_MS = 250;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

function declaredAppItems(db: Database) {
	return db.declaredSchemaManager.getDeclaredSchema('App')?.items ?? [];
}

function assertNoIgnoredItems(db: Database): void {
	const ignored = declaredAppItems(db).filter(item => item.type === 'declareIgnored').length;
	if (ignored > 0) {
		// Only a count: Quereus leaves an ignored item's source text empty.
		throw new Error(`sApp schema has ${ignored} item(s) the parser does not recognize (a \`create …\` prefix or a misspelled item keyword such as \`tabel\`); items are \`table\`, \`index\`, \`unique index\`, \`view\`, \`materialized view\` and \`assertion\``);
	}
}

function assertNoSeedItems(db: Database): void {
	// Quereus refuses a second seed for one table at declare, so these names are distinct.
	const tables = declaredAppItems(db).flatMap(item => item.type === 'declaredSeed' ? [item.tableName] : []);
	if (tables.length > 0) {
		throw new Error(`sApp schema has seed item(s) for table(s) ${tables.join(', ')}; Sereus does not apply seed rows to a strand — insert the rows an app needs at birth from the app when it founds the strand`);
	}
}
