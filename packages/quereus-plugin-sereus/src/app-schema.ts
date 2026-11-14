import debug from 'debug';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import { QueueDisposedError } from '@optimystic/quereus-plugin-optimystic/plugin';
import { AppSchemaRefusedError } from './app-schema-errors.js';
import { AppSchemaVersionDeferredError, gateAppSchemaVersion } from './app-schema-version.js';
import {
	abortableDelay, COHORT_CONNECT_SETTLE_MS, deferralOf, outsideOpenTransaction, type Deferral, type PeerConnectEvents,
} from './app-schema-waits.js';
import type { StrandOfflineController, AppSchemaOutcome, AppSchemaWait } from './types.js';

const log = debug('sereus:plugin:strand');

/** An sApp schema and its version: cadre-core's `SAppConfig` carries both, and is one. */
export interface VersionedAppSchema {
	/** The schema body, the items inside `declare schema App { … }`. */
	schema: string;
	/** A whole number of at least 1 that the app raises with every change to {@link schema}. */
	schemaVersion: number;
}

/**
 * Step 7 of `composeStrand`: declare the sApp's schema as `App`, gate it on the version the strand
 * has recorded, and apply it — a declarative diff against the catalog, so re-applying a schema that
 * is already in place emits nothing. The one site that applies an `App` schema: `composeStrand`
 * calls it at bring-up (through {@link applyAppSchemaOrDefer}, whose deferred retry shares its
 * declaration and gate), and the connection's `SereusPluginResult.applyAppSchema` calls it on a live
 * storage replica when an app claims the strand (cadre-core's `StrandDatabase.attachAppSchema`). The database must already be composed (optimystic set as
 * the default vtab, the `Strand` schema applied), or the tables land in memory instead of the strand.
 *
 * Refuses a schema holding an item the Quereus parser skipped: it keeps any item whose leading
 * keyword it does not model (`create unique index …`, a misspelled `tabel`, `domain`) as an
 * opaque placeholder that apply ignores, so the app would otherwise run without that item.
 *
 * Refuses a schema holding a `seed` item: the apply runs on every node of the strand at every
 * connect, so seed inserts would put a network write on each bring-up and two nodes inserting
 * the same key at once would collide. Rows an app needs at birth are the founding app's to write.
 *
 * Refuses a version below the one the strand records with `AppSchemaOutdatedError`, applying
 * and writing nothing, and records a higher version before applying ({@link gateAppSchemaVersion}).
 *
 * Every refusal decided by the schema itself, or by the schema against this node's tables and rows,
 * throws {@link AppSchemaRefusedError}: retrying the same schema here fails the same way.
 */
export async function applyAppSchema(db: Database, app: VersionedAppSchema): Promise<void> {
	try {
		await declareAppSchema(db, app);
		await gateAppSchemaVersion(db, app.schemaVersion, NEVER_RELEASED);
		await db.exec('apply schema App;');
	} catch (err) {
		throw asAppSchemaRefusal(err);
	}
}

/**
 * The refusals of {@link applyAppSchema} decided by the schema text and version alone (a version
 * that is not a whole number of at least 1, a seed item, an item the parser skipped, a syntax error),
 * thrown as {@link AppSchemaRefusedError} without a strand database: `declare schema` only parses and
 * records, so it runs on a throwaway Quereus database that writes nothing anywhere. A refusal decided
 * against a strand's tables, rows and recorded version needs that strand, so it passes here.
 */
export async function checkAppSchema(app: VersionedAppSchema): Promise<void> {
	const db = new Database();
	try {
		await declareAppSchema(db, app);
	} catch (err) {
		throw asAppSchemaRefusal(err);
	} finally {
		await db.close();
	}
}

/** Declare `app.schema` as `App`, refusing what {@link applyAppSchema} refuses before it reads the strand. Writes nothing to the strand. */
async function declareAppSchema(db: Database, app: VersionedAppSchema): Promise<void> {
	assertValidSchemaVersion(app.schemaVersion);
	await db.exec(`
		declare schema App {
			${app.schema}
		}
	`);
	assertNoIgnoredItems(db);
	assertNoSeedItems(db);
}

function assertValidSchemaVersion(schemaVersion: number): void {
	if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
		throw new AppSchemaRefusedError(`sApp schemaVersion must be a whole number of at least 1 (got ${String(schemaVersion)})`);
	}
}

/** Never aborted: {@link applyAppSchema} has no composition whose shutdown would end a wait. */
const NEVER_RELEASED = new AbortController().signal;

/** What {@link applyAppSchemaOrDefer} reports, in the shape `SereusPluginResult` carries it. */
export interface AppSchemaApply {
	appSchema: Promise<AppSchemaOutcome>;
	/** What the connect-time apply waits for. Present only when it was deferred. */
	appSchemaWaitingFor?: AppSchemaWait;
	/** The queued transaction ids that refused the connect-time apply. Present only when the queue refused it. */
	appSchemaDeferredBy?: readonly string[];
}

/** Where a deferred apply waits: the offline queue, when there is one, and the strand node, when there is one. */
export interface AppSchemaWaits {
	queue?: Pick<StrandOfflineController, 'whenDrained'>;
	peers?: PeerConnectEvents;
}

/**
 * Step 7 of `composeStrand`: {@link applyAppSchema}, except that an apply refused for a reason
 * that passes does not throw. Two such reasons:
 *
 *  - queued offline transactions wrote a table the apply changes (`QueuedEntriesBlockSchemaChangeError`),
 *    or the version record would wait behind queued transactions; retried each time the queue drains;
 *  - the strand's cohort could not be reached (Optimystic's `classifyCommitFailure` says
 *    `cohort-unreachable`, or the version read could not settle what the members hold): an apply
 *    writes the strand's catalog, which needs the cohort, so a member alone after an app update would
 *    otherwise not open the strand at all (gotchoices/sereus#55). Retried when the strand node connects
 *    to a peer, and on a backoff ({@link COHORT_RETRY_MS}).
 *
 * Quereus unwinds a refused apply, whether a migration step or the closing catalog commit refused it,
 * so `db` keeps the `App` schema it had, and `appSchema` settles with how the retries ended. Any other
 * error from the first apply is thrown ({@link AppSchemaRefusedError} when the schema can never apply
 * to these tables, `AppSchemaOutdatedError` when the strand records a higher version), and so is
 * a refusal Quereus could not unwind that leaves a retry nothing to send ({@link retryableRefusalOf}).
 * A retry that ends in such a refusal settles `failed` with it, typed the same way. Every retry runs
 * the whole version gate again, so one that finds another member has recorded a higher version
 * meanwhile settles `failed` with `AppSchemaOutdatedError`.
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
	app: VersionedAppSchema,
	waits: AppSchemaWaits,
	released: AbortSignal,
): Promise<AppSchemaApply> {
	try {
		await applyAppSchema(db, app);
		log('sApp schema applied');
		return { appSchema: Promise.resolve({ state: 'applied' }) };
	} catch (err) {
		const deferral = await retryableRefusalOf(db, err);
		if (!deferral) {
			throw err;
		}
		logDeferral('sApp schema apply', deferral);
		return {
			appSchema: retryDeferredAppSchema(db, app, deferral, waits, released),
			appSchemaWaitingFor: deferral.wait,
			...(deferral.wait === 'queue' && { appSchemaDeferredBy: deferral.transactionIds }),
		};
	}
}

async function retryDeferredAppSchema(
	db: Database,
	app: VersionedAppSchema,
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
			await outsideOpenTransaction(() => gateAndApplyAtomically(db, app, released), released);
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
				return { state: 'failed', error: asAppSchemaRefusal(err) };
			}
			logDeferral('Deferred sApp schema apply', again);
			deferral = again;
		}
	}
}

/**
 * A retry's declare, version gate and apply, the apply as one atomic batch. Run whole again when the
 * apply meets an open transaction. A wait the record meets re-sends the record alone, over the version
 * read before the wait; a member that recorded meanwhile makes the key or `Rises` refuse it, and the
 * gate reads again.
 */
async function gateAndApplyAtomically(db: Database, app: VersionedAppSchema, released: AbortSignal): Promise<void> {
	await declareAppSchema(db, app);
	await gateAppSchemaVersion(db, app.schemaVersion, released);
	await db.exec('apply schema App;', undefined, { transaction: true });
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
 * The refusal `err` is or wraps, when retrying it would send something. A version gate that could not
 * finish ran before the apply, so a retry has the record and the whole apply to send. An apply refused
 * after a `drop table` or `drop column` cannot be unwound, so `db` can already hold the whole new schema
 * while the store holds the old one. A retry would then diff clean and settle `applied` with nothing
 * written, so that refusal counts as a failure: a restart plans the change again from the store.
 */
async function retryableRefusalOf(db: Database, err: unknown): Promise<Deferral | undefined> {
	if (err instanceof AppSchemaVersionDeferredError) {
		return err.deferral;
	}
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

function declaredAppItems(db: Database) {
	return db.declaredSchemaManager.getDeclaredSchema('App')?.items ?? [];
}

function assertNoIgnoredItems(db: Database): void {
	const ignored = declaredAppItems(db).filter(item => item.type === 'declareIgnored').length;
	if (ignored > 0) {
		// Only a count: Quereus leaves an ignored item's source text empty.
		throw new AppSchemaRefusedError(`sApp schema has ${ignored} item(s) the parser does not recognize (a \`create …\` prefix or a misspelled item keyword such as \`tabel\`); items are \`table\`, \`index\`, \`unique index\`, \`view\`, \`materialized view\` and \`assertion\``);
	}
}

function assertNoSeedItems(db: Database): void {
	// Quereus refuses a second seed for one table at declare, so these names are distinct.
	const tables = declaredAppItems(db).flatMap(item => item.type === 'declaredSeed' ? [item.tableName] : []);
	if (tables.length > 0) {
		throw new AppSchemaRefusedError(`sApp schema has seed item(s) for table(s) ${tables.join(', ')}; Sereus does not apply seed rows to a strand — insert the rows an app needs at birth from the app when it founds the strand`);
	}
}

/** `err` typed as an {@link AppSchemaRefusedError} when {@link isSchemaRefusal} holds, else `err` unchanged. */
function asAppSchemaRefusal(err: unknown): unknown {
	if (!isSchemaRefusal(err)) {
		return err;
	}
	return new AppSchemaRefusedError(`sApp schema cannot be applied to this strand's tables: ${err.message}`, { cause: err });
}

/**
 * Status codes Quereus raises for a refusal it decides from the schema and the catalog and rows it holds:
 * a failed migration step is `ERROR` with the step's own error as `cause` (a backfill that breaks
 * `not null` is `CONSTRAINT`, a key or type change it cannot make is `ERROR` or `UNSUPPORTED`).
 * An allowlist rather than a list of fault codes, so a code Quereus adds later keeps today's retries.
 */
const SCHEMA_REFUSAL_CODES: ReadonlySet<number> = new Set([
	StatusCode.ERROR,
	StatusCode.CONSTRAINT,
	StatusCode.MISMATCH,
	StatusCode.UNSUPPORTED,
	StatusCode.SYNTAX,
	StatusCode.SCHEMA,
	StatusCode.RANGE,
]);

/**
 * Whether every link of `err`'s `cause` chain is a `QuereusError` with a {@link SCHEMA_REFUSAL_CODES} code.
 * A storage or network fault anywhere in the chain is a plain `Error` (Optimystic's `PromiseShortfallError`,
 * `BlockUnavailableError`) or carries `BUSY` or `MISUSE`, so it keeps the error untyped and retryable.
 *
 * NOTE: `ERROR` is broad, and one known `ERROR` with no `cause` is transient: Optimystic's "Committed read
 * refused: storage is in a partially-committed state". An apply makes no committed reads (Quereus refuses
 * them while a schema migrates), so it cannot reach this test, and the version gate's read, which can,
 * puts its faults behind a plain `Error` (`versionRecordFault` in app-schema-version.ts). If a transient fault is ever seen typed as a
 * refusal, have Optimystic give it a fault code or a `cause` rather than matching its message here.
 */
function isSchemaRefusal(err: unknown): err is QuereusError {
	let at = err;
	do {
		if (!(at instanceof QuereusError) || !SCHEMA_REFUSAL_CODES.has(at.code)) {
			return false;
		}
		at = at.cause;
	} while (at !== undefined);
	return true;
}
