import debug from 'debug';
import { Database, QuereusError, StatusCode, TransactionActiveError, type SqlParameters, type SqlValue } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { BlockPossiblyStaleError, BlockUnavailableError, classifyCommitFailure } from '@optimystic/db-core';
import { ConcurrentModificationError, QueuedEntriesBlockSchemaChangeError, QueueDisposedError } from '@optimystic/quereus-plugin-optimystic/plugin';
import { offlineControllerOf } from './offline-controllers.js';
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
 * declaration and gate), and cadre-core's `StrandDatabase.attachAppSchema` calls it on a live storage
 * replica when an app claims the strand. The database must already be composed (optimystic set as
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
 * Refuses a version below the one the strand records with {@link AppSchemaOutdatedError}, applying
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

/**
 * The version gate of {@link applyAppSchema}: compare `declared` with the version the strand records in
 * `Strand.AppSchemaVersion`, the highest any member has applied (docs/strands.md → "Until then: every
 * member on the same schema version").
 *
 *  - none recorded, or a lower one: record `declared`, so the apply that follows may proceed;
 *  - the same: nothing to record;
 *  - a higher one: throw {@link AppSchemaOutdatedError}, having written nothing.
 *
 * Recorded before the apply, not with it: `apply schema` commits the catalog in a batch of its own, so
 * no row can share its commit. Recording first means a reader between the two sees the new number over
 * the old schema and refuses a lower member a moment early; recording after would let a lower member
 * in between pass the gate and drop what the apply just added.
 *
 * A record refused because another member recorded at the same moment reads again and decides again,
 * up to {@link RECORD_ROUNDS} times. A read or record that has to wait for the strand's members, or a
 * record that would wait behind the offline queue, throws {@link AppSchemaVersionDeferredError}.
 */
async function gateAppSchemaVersion(db: Database, declared: number, released: AbortSignal): Promise<void> {
	assertVersionTableDeclared(db);
	for (let round = 1; ; round++) {
		const recorded = await readRecordedVersion(db);
		if (recorded !== undefined && recorded > declared) {
			throw new AppSchemaOutdatedError(declared, recorded);
		}
		if (recorded === declared) {
			return;
		}
		try {
			await recordVersion(db, declared, recorded, released);
			log('Recorded App schema version %d (was %s)', declared, recorded ?? 'unrecorded');
			return;
		} catch (err) {
			if (!isRecordConflict(err)) {
				throw err;
			}
			if (round >= RECORD_ROUNDS) {
				// A plain `Error` link, so the conflict is not typed as a refusal of the schema: a later connect can get past it.
				throw new Error(`Could not record App schema version ${declared}: other members recorded concurrently ${RECORD_ROUNDS} times`, { cause: err });
			}
			log('App schema version record conflicted with another member\'s; reading it again: %O', err);
		}
	}
}

/** How many times {@link gateAppSchemaVersion} reads and decides again after a record another member's conflicted with. */
const RECORD_ROUNDS = 3;

/** A composed strand declares the table in `STRAND_SCHEMA`; without it there is no strand to gate against. */
function assertVersionTableDeclared(db: Database): void {
	if (!db.schemaManager.findTable('AppSchemaVersion', 'Strand')) {
		throw new Error('Strand.AppSchemaVersion is not declared: an sApp schema applies only to a database composed as a strand (composeStrand)');
	}
}

/** The recorded version, by a live read, so what other members committed is pulled first. */
async function readRecordedVersion(db: Database): Promise<number | undefined> {
	try {
		for await (const row of db.eval('select Version from Strand.AppSchemaVersion')) {
			return versionValue(row.Version);
		}
		return undefined;
	} catch (err) {
		if (blockAvailabilityFailureIn(err)) {
			throw new AppSchemaVersionDeferredError({ wait: 'cohort' }, 'read the strand\'s App schema version', err);
		}
		throw err;
	}
}

function versionValue(value: SqlValue | undefined): number {
	if (typeof value === 'number' || typeof value === 'bigint') {
		return Number(value);
	}
	throw new Error(`Strand.AppSchemaVersion.Version holds ${typeof value}, not an integer`);
}

/**
 * A read that could not settle what the other members hold: `BlockUnavailableError` (not just the two
 * reasons `classifyCommitFailure` calls `cohort-unreachable`; a table another member created that this
 * machine has not fetched fails with the others) or `BlockPossiblyStaleError`. Reaching more of the
 * cohort is the remedy for each, so the read waits for the cohort.
 */
function blockAvailabilityFailureIn(err: unknown): boolean {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof BlockUnavailableError || at instanceof BlockPossiblyStaleError) {
			return true;
		}
	}
	return false;
}

/**
 * Write `declared` over `recorded` as one atomic batch outside any transaction another caller holds.
 * Refused without trying while the offline queue lists transactions: the table is network-acknowledged,
 * so the commit would wait behind them holding the database's execution lock (docs/strands.md →
 * "Membership writes are refused while transactions are queued").
 */
async function recordVersion(db: Database, declared: number, recorded: number | undefined, released: AbortSignal): Promise<void> {
	const queued = offlineControllerOf(db)?.entries() ?? [];
	if (queued.length > 0) {
		throw new AppSchemaVersionDeferredError({ wait: 'queue', transactionIds: queued.map(entry => entry.transactionId) }, 'record the App schema version');
	}
	const sql = recorded === undefined
		? 'insert into Strand.AppSchemaVersion (Version) values (:version)'
		: 'update Strand.AppSchemaVersion set Version = :version';
	try {
		await execOutsideOpenTransaction(db, sql, { ':version': declared }, released);
	} catch (err) {
		const deferral = deferralOf(err);
		if (deferral) {
			throw new AppSchemaVersionDeferredError(deferral, 'record the App schema version', err);
		}
		throw err;
	}
}

/**
 * Another member's record landed first: the singleton key refused a second insert (`CONSTRAINT`), `Rises`
 * refused an update below it (`CONSTRAINT`), or the update lost the row it read (`ConcurrentModificationError`).
 */
function isRecordConflict(err: unknown): boolean {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof ConcurrentModificationError || (at instanceof QuereusError && at.code === StatusCode.CONSTRAINT)) {
			return true;
		}
	}
	return false;
}

/** Never aborted: {@link applyAppSchema} has no composition whose shutdown would end a wait. */
const NEVER_RELEASED = new AbortController().signal;

/** The version gate could not finish for a reason that passes; nothing was applied, so a retry has the record and the whole apply to send. */
class AppSchemaVersionDeferredError extends Error {
	constructor(readonly deferral: Deferral, what: string, cause?: unknown) {
		super(deferral.wait === 'queue'
			? `Could not ${what}: the offline queue holds transactions (${deferral.transactionIds.join(', ')}) a network-acknowledged write would wait behind`
			: `Could not ${what}: the strand's members could not be reached`, { cause });
		this.name = 'AppSchemaVersionDeferredError';
	}
}

/**
 * An sApp schema refused for a reason that does not pass: the schema itself (a seed item, an item the
 * parser skipped, a syntax error, an invalid version), the schema against the tables and rows this node
 * holds, such as a `not null` column with no default added to a table that has rows, or a version below
 * the one the strand records ({@link AppSchemaOutdatedError}). Applying the same schema here again
 * fails the same way, so a host should not retry it until the app supplies a different one. A storage
 * or network fault is never this error.
 *
 * `cause` is the error Quereus raised, when it raised one.
 */
export class AppSchemaRefusedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'AppSchemaRefusedError';
	}
}

/**
 * The strand records a higher App schema version than this app declares: a member has applied a newer
 * schema, and this app's would remove what it added. Not retryable: the app must update. A subclass of
 * {@link AppSchemaRefusedError}, so every host that stops retrying a refused schema stops retrying this.
 */
export class AppSchemaOutdatedError extends AppSchemaRefusedError {
	/** The version this app declares (`schemaVersion`). */
	readonly appSchemaVersion: number;
	/** The version the strand records, the highest any member has applied. */
	readonly strandSchemaVersion: number;

	constructor(appSchemaVersion: number, strandSchemaVersion: number) {
		super(`This app's schema is version ${appSchemaVersion}, and a member of this strand has applied version ${strandSchemaVersion}: update the app to open the strand`);
		this.name = 'AppSchemaOutdatedError';
		this.appSchemaVersion = appSchemaVersion;
		this.strandSchemaVersion = strandSchemaVersion;
	}
}

/** The {@link AppSchemaRefusedError} `err` is or wraps, walking `cause`, so a wrapper added between the apply and the catch cannot hide it. */
export function appSchemaRefusalOf(err: unknown): AppSchemaRefusedError | undefined {
	for (let at = err; at instanceof Error; at = at.cause) {
		if (at instanceof AppSchemaRefusedError) {
			return at;
		}
	}
	return undefined;
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
 * to these tables, {@link AppSchemaOutdatedError} when the strand records a higher version), and so is
 * a refusal Quereus could not unwind that leaves a retry nothing to send ({@link retryableRefusalOf}).
 * A retry that ends in such a refusal settles `failed` with it, typed the same way. Every retry runs
 * the whole version gate again, so one that finds another member has recorded a higher version
 * meanwhile settles `failed` with {@link AppSchemaOutdatedError}.
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
 * A retry's declare, version gate and apply, the apply as one atomic batch. Run whole again after a
 * wait for an open transaction, so the gate's decision is never older than that wait.
 */
async function gateAndApplyAtomically(db: Database, app: VersionedAppSchema, released: AbortSignal): Promise<void> {
	await declareAppSchema(db, app);
	await gateAppSchemaVersion(db, app.schemaVersion, released);
	await db.exec('apply schema App;', undefined, { transaction: true });
}

/** `sql` as one atomic batch, once no other caller holds a transaction open. */
async function execOutsideOpenTransaction(db: Database, sql: string, params: SqlParameters | undefined, released: AbortSignal): Promise<void> {
	await outsideOpenTransaction(() => db.exec(sql, params, { transaction: true }), released);
}

/**
 * Runs `attempt`, which ends in an atomic batch, until no other caller's open transaction refuses it.
 * Throws the open-transaction refusal when `released` aborts during the wait.
 */
async function outsideOpenTransaction(attempt: () => Promise<void>, released: AbortSignal): Promise<void> {
	for (;;) {
		try {
			await attempt();
			return;
		} catch (err) {
			if (!(err instanceof TransactionActiveError)) {
				throw err;
			}
			log('sApp schema write waiting for an open transaction to end');
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

/**
 * The refusal `err` is or wraps, when a later retry can get past it: Quereus rewraps an error out of
 * a migration step, keeping it as `cause`.
 *
 * `classifyCommitFailure` refuses to walk `cause` itself, because a commit-phase shortfall nested
 * there means the write is in doubt rather than unsent. Walking it here is safe for both writes it
 * sorts: an apply is a declarative diff, so a retry after a write that did land changes nothing, and
 * a retried version record reads the version again before writing it.
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
 * them while a schema migrates), so it cannot reach this test. If a transient fault is ever seen typed as a
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
