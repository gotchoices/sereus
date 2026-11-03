import debug from 'debug';
import { TransactionActiveError, type Database } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { classifyCommitFailure } from '@optimystic/db-core';
import { QueuedEntriesBlockSchemaChangeError, QueueDisposedError } from '@optimystic/quereus-plugin-optimystic/plugin';
import type { StrandOfflineController, AppSchemaOutcome, AppSchemaWait } from './types.js';

const log = debug('sereus:plugin:strand');

/**
 * Step 7 of `composeStrand`: declare the sApp's schema as `App` and apply it — a
 * declarative diff against the catalog, so re-applying a schema that is already in place
 * emits nothing. The one site that applies an `App` schema: `composeStrand` calls it at
 * bring-up (through {@link applyAppSchemaOrDefer}, whose deferred retry shares its
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

/** What {@link applyAppSchemaOrDefer} reports, in the shape `SereusPluginResult` carries it. */
export interface AppSchemaApply {
	appSchema: Promise<AppSchemaOutcome>;
	/** What the connect-time apply waits for. Present only when it was deferred. */
	appSchemaWaitingFor?: AppSchemaWait;
	/** The queued transaction ids that refused the connect-time apply. Present only when the queue refused it. */
	appSchemaDeferredBy?: readonly string[];
}

/** The strand node's peer events, which a retry waiting for the cohort wakes on. */
export type PeerConnectEvents = Pick<Libp2p, 'addEventListener' | 'removeEventListener'>;

/** Where a deferred apply waits: the offline queue, when there is one, and the strand node, when there is one. */
export interface AppSchemaWaits {
	queue?: Pick<StrandOfflineController, 'whenDrained'>;
	peers?: PeerConnectEvents;
}

/** Why an apply was refused, when it is a refusal a later retry can get past. */
type Deferral = { wait: 'queue'; transactionIds: readonly string[] } | { wait: 'cohort' };

/**
 * Step 7 of `composeStrand`: {@link applyAppSchema}, except that an apply refused for a reason
 * that passes does not throw. Two such reasons:
 *
 *  - queued offline transactions wrote a table the apply changes (`QueuedEntriesBlockSchemaChangeError`);
 *    retried each time the queue drains;
 *  - the strand's cohort could not be reached (Optimystic's `classifyCommitFailure` says
 *    `cohort-unreachable`): an apply writes the strand's catalog, which needs the cohort, so a member
 *    alone after an app update would otherwise not open the strand at all (gotchoices/sereus#55).
 *    Retried when the strand node connects to a peer, and on a backoff ({@link COHORT_RETRY_MS}).
 *
 * Quereus unwinds a refused apply, whether a migration step or the closing catalog commit refused it,
 * so `db` keeps the `App` schema it had, and `appSchema` settles with how the retries ended. Any other
 * error from the first apply is thrown, and so is a refusal Quereus could not unwind that leaves a
 * retry nothing to send ({@link retryableRefusalOf}).
 *
 * Waiting before returning was rejected: that withholds the strand from the app right after an app
 * update, which is when a phone is most likely to be offline. So was refusing the connect: the queue
 * can drain only while the composition is alive.
 *
 * `released` is aborted when the composition shuts down; a retry not yet landed then settles
 * `cancelled`.
 *
 * A retry runs while the app is using `db`, so it is one atomic batch that refuses to run inside a
 * transaction another caller holds open, and waits for that transaction to end: run inside it, the
 * apply would be committed or rolled back with the app's rows, and a rollback leaves the index it
 * built holding entries for rows that are gone.
 */
export async function applyAppSchemaOrDefer(
	db: Database,
	schema: string,
	waits: AppSchemaWaits,
	released: AbortSignal,
): Promise<AppSchemaApply> {
	try {
		await applyAppSchema(db, schema);
		log('sApp schema applied');
		return { appSchema: Promise.resolve({ state: 'applied' }) };
	} catch (err) {
		const deferral = await retryableRefusalOf(db, err);
		if (!deferral) {
			throw err;
		}
		logDeferral('sApp schema apply', deferral);
		return {
			appSchema: retryDeferredAppSchema(db, schema, deferral, waits, released),
			appSchemaWaitingFor: deferral.wait,
			...(deferral.wait === 'queue' && { appSchemaDeferredBy: deferral.transactionIds }),
		};
	}
}

async function retryDeferredAppSchema(
	db: Database,
	schema: string,
	first: Deferral,
	waits: AppSchemaWaits,
	released: AbortSignal,
): Promise<AppSchemaOutcome> {
	let deferral = first;
	let cohortRetries = 0;
	for (;;) {
		try {
			await nextChance(deferral, waits, cohortRetries, released);
			if (deferral.wait === 'cohort') {
				cohortRetries++;
			}
			if (released.aborted) {
				return { state: 'cancelled' };
			}
			await applyOutsideOpenTransaction(db, schema, released);
			log('Deferred sApp schema applied');
			return { state: 'applied', deferred: true };
		} catch (err) {
			if (released.aborted || err instanceof QueueDisposedError) {
				log('Deferred sApp schema apply cancelled by shutdown');
				return { state: 'cancelled' };
			}
			const again = await retryableRefusalOf(db, err);
			if (!again) {
				log('Deferred sApp schema apply failed: %O', err);
				return { state: 'failed', error: err };
			}
			logDeferral('Deferred sApp schema apply', again);
			deferral = again;
		}
	}
}

/** One atomic apply, once no other caller holds a transaction open. Throws the open-transaction refusal when `released` aborts during the wait. */
async function applyOutsideOpenTransaction(db: Database, schema: string, released: AbortSignal): Promise<void> {
	for (;;) {
		await declareAppSchema(db, schema);
		try {
			await db.exec('apply schema App;', undefined, { transaction: true });
			return;
		} catch (err) {
			if (!(err instanceof TransactionActiveError)) {
				throw err;
			}
			log('Deferred sApp schema apply waiting for an open transaction to end');
			await abortableDelay(OPEN_TRANSACTION_RETRY_MS, released);
			if (released.aborted) {
				throw err;
			}
		}
	}
}

/** Waits for whatever may get the retry past `deferral`. */
async function nextChance(deferral: Deferral, waits: AppSchemaWaits, cohortRetries: number, released: AbortSignal): Promise<void> {
	if (deferral.wait === 'queue' && waits.queue) {
		// NOTE: this loops without a pause when `whenDrained` resolves at once while the refusal stands
		// (a segment left sealed with nothing queued, say). Upstream counts a removal still in progress
		// as undrained, so no such state is known; if one shows up as a busy loop, back off between tries.
		await waits.queue.whenDrained();
		return;
	}
	await nextCohortChance(waits.peers, cohortRetryDelay(cohortRetries), released);
}

/**
 * The refusal `err` is or wraps, when retrying it would send something. An apply refused after a
 * `drop table` or `drop column` cannot be unwound, so `db` can already hold the whole new schema while
 * the store holds the old one. A retry would then diff clean and settle `applied` with nothing written,
 * so that refusal counts as a failure: a restart plans the change again from the store.
 */
async function retryableRefusalOf(db: Database, err: unknown): Promise<Deferral | undefined> {
	const deferral = deferralOf(err);
	if (!deferral) {
		return undefined;
	}
	try {
		if (await appSchemaHasPendingChanges(db)) {
			return deferral;
		}
		log('sApp schema apply was refused, and the database already holds the new schema: %O', err);
	} catch (diffError) {
		log('Could not check what a refused sApp schema apply left to send: %O', diffError);
	}
	return undefined;
}

async function appSchemaHasPendingChanges(db: Database): Promise<boolean> {
	for await (const _change of db.eval('diff schema App')) {
		return true;
	}
	return false;
}

/**
 * The refusal `err` is or wraps, when a later retry can get past it: Quereus rewraps an error out of
 * a migration step, keeping it as `cause`.
 *
 * `classifyCommitFailure` refuses to walk `cause` itself, because a commit-phase shortfall nested
 * there means the write is in doubt rather than unsent. Walking it here is safe: an apply is a
 * declarative diff, so a retry after a write that did land changes nothing.
 */
function deferralOf(err: unknown): Deferral | undefined {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof QueuedEntriesBlockSchemaChangeError) {
			return { wait: 'queue', transactionIds: at.transactionIds };
		}
		if (classifyCommitFailure(at).kind === 'cohort-unreachable') {
			return { wait: 'cohort' };
		}
	}
	return undefined;
}

function logDeferral(what: string, deferral: Deferral): void {
	if (deferral.wait === 'queue') {
		log('%s refused by queued transactions %o; retrying once they settle', what, deferral.transactionIds);
	} else {
		log('%s could not reach the strand cohort; retrying when a peer connects', what);
	}
}

/**
 * Backoff for a retry waiting for the cohort, by how many came before it. A connect wakes the retry
 * sooner, so the backoff only bounds how long a missed or too-early connect leaves the schema behind.
 */
const COHORT_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;

function cohortRetryDelay(retriesBefore: number): number {
	return COHORT_RETRY_MS[Math.min(retriesBefore, COHORT_RETRY_MS.length - 1)]!;
}

/**
 * How long a retry woken by a connect waits first, so the peer is identified and in the ring before
 * the apply asks for its cohort; a retry that still finds it missing waits for the next chance.
 */
const COHORT_CONNECT_SETTLE_MS = 2_000;

/**
 * Resolves {@link COHORT_CONNECT_SETTLE_MS} after the strand node's next peer connect, after `delayMs`, or when `signal` aborts.
 *
 * NOTE: every connect wakes a retry, the relay's included, and a retry that reaches the cohort's
 * refusal holds the database's statement lock while it waits for it. If that shows up as stalled app
 * statements on a node with many connects, wake only on a connect to a strand member.
 */
async function nextCohortChance(peers: PeerConnectEvents | undefined, delayMs: number, signal: AbortSignal): Promise<void> {
	const byConnect = await new Promise<boolean>(resolve => {
		const done = (connected: boolean): void => {
			clearTimeout(timer);
			peers?.removeEventListener('peer:connect', onConnect);
			signal.removeEventListener('abort', onAbort);
			resolve(connected);
		};
		const onConnect = (): void => done(true);
		const onAbort = (): void => done(false);
		const timer = setTimeout(() => done(false), delayMs);
		peers?.addEventListener('peer:connect', onConnect);
		signal.addEventListener('abort', onAbort, { once: true });
	});
	if (byConnect) {
		await abortableDelay(COHORT_CONNECT_SETTLE_MS, signal);
	}
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
