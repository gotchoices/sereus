import debug from 'debug';
import { QuereusError, StatusCode, type ChangeScope, type Database, type SqlValue, type Subscription } from '@quereus/quereus';
import { BlockPossiblyStaleError, BlockUnavailableError } from '@optimystic/db-core';
import { ConcurrentModificationError } from '@optimystic/quereus-plugin-optimystic/plugin';
import { offlineControllerOf } from './offline-controllers.js';
import { AppSchemaOutdatedError } from './app-schema-errors.js';
import { COHORT_CONNECT_SETTLE_MS, deferralOf, execOutsideOpenTransaction, type Deferral, type PeerConnectEvents } from './app-schema-waits.js';
import type { AppSchemaOutcome } from './types.js';

const log = debug('sereus:plugin:strand');

/**
 * The version gate of `applyAppSchema`: compare `declared` with the version the strand records in
 * `Strand.AppSchemaVersion`, the highest any member has applied (docs/strands/app-schema.md → "Every
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
export async function gateAppSchemaVersion(db: Database, declared: number, released: AbortSignal): Promise<void> {
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
	if (!db.schemaManager.findTable(VERSION_TABLE.table, VERSION_TABLE.schema)) {
		throw new Error('Strand.AppSchemaVersion is not declared: an sApp schema applies only to a database composed as a strand (composeStrand)');
	}
}

const VERSION_TABLE = { schema: 'Strand', table: 'AppSchemaVersion' } as const;

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
		throw versionRecordFault('read the strand\'s App schema version', err);
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
 * so the commit would wait behind them holding the database's execution lock (docs/strands/writes.md →
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
		throw versionRecordFault('record the App schema version', err);
	}
}

/**
 * A fault reading or writing `Strand.AppSchemaVersion`, behind a plain `Error` link: the table is the
 * strand's, so its faults are never a refusal of the app's schema, and a transient `ERROR`-coded read
 * fault must not be typed as a refusal and stop a host retrying the strand.
 */
function versionRecordFault(what: string, cause: unknown): Error {
	return new Error(`Could not ${what}`, { cause });
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

/** The version gate could not finish for a reason that passes; nothing was applied, so a retry has the record and the whole apply to send. */
export class AppSchemaVersionDeferredError extends Error {
	constructor(readonly deferral: Deferral, what: string, cause?: unknown) {
		super(deferral.wait === 'queue'
			? `Could not ${what}: the offline queue holds transactions (${deferral.transactionIds.join(', ')}) a network-acknowledged write would wait behind`
			: `Could not ${what}: the strand's members could not be reached`, { cause });
		this.name = 'AppSchemaVersionDeferredError';
	}
}

/** Told once that a member recorded a higher App schema version than the one this connection runs. */
export type AppSchemaSupersededListener = (error: AppSchemaOutdatedError) => void;

/** Where a connection's running version check wakes, and when it stops. */
export interface AppSchemaVersionCheckWaits {
	/** The strand node, when there is one: each peer connect checks, {@link COHORT_CONNECT_SETTLE_MS} after it. */
	peers?: PeerConnectEvents;
	/** Aborted when the connection shuts down: the check stops, and nothing is reported after. */
	released: AbortSignal;
}

/**
 * A connection's check of the strand's recorded App schema version while it runs, and its one report
 * that another member has recorded a higher version than the one it runs
 * (`SereusPluginResult.onAppSchemaSuperseded`): this connection's writes can then erase what the newer
 * version added (docs/strands/app-schema.md → "A running member stops").
 *
 * Each check is a live read of `Strand.AppSchemaVersion`, run on every `Database.watch` wake of that
 * table (this machine's commits and, with strand reactivity, any machine's), {@link COHORT_CONNECT_SETTLE_MS}
 * after each peer connect, and at least every {@link APP_SCHEMA_VERSION_CHECK_MS}. One check runs at a
 * time; a wake during one runs one more after it. A read that fails is logged and left to the next wake.
 * A check starts with no read, since the version gate of the apply before it has just read the version.
 *
 * The report is kept once made, so a listener added after it is called at once: a host subscribes after
 * the connect returns, and the check starts inside it.
 */
export class AppSchemaVersionCheck {
	private error: AppSchemaOutdatedError | undefined;
	private readonly listeners = new Set<AppSchemaSupersededListener>();
	private running: AppSchemaVersionWatch | undefined;
	/** The connect-time apply {@link afterApply} waits on, until it settles or {@link stop} drops it. */
	private pending: Promise<AppSchemaOutcome> | undefined;

	constructor(private readonly db: Database, private readonly waits: AppSchemaVersionCheckWaits) {
		waits.released.addEventListener('abort', () => {
			this.stop();
			this.listeners.clear();
		}, { once: true });
	}

	/** Be told once that a higher version is recorded. Returns an idempotent unsubscribe. */
	onSuperseded(listener: AppSchemaSupersededListener): () => void {
		if (this.waits.released.aborted) {
			return () => undefined;
		}
		if (this.error) {
			deliver(listener, this.error);
			return () => undefined;
		}
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/**
	 * Check `schemaVersion` once the connect-time apply has landed. A deferred retry that found the strand
	 * ahead leaves the connection on the schema it hydrated, below the recorded one, so it is the same report.
	 */
	afterApply(apply: Promise<AppSchemaOutcome>, schemaVersion: number): void {
		this.pending = apply;
		void apply.then(outcome => {
			if (this.pending !== apply) {
				return;
			}
			this.pending = undefined;
			if (outcome.state === 'applied') {
				this.start(schemaVersion);
			} else if (outcome.state === 'failed' && outcome.error instanceof AppSchemaOutdatedError) {
				this.report(outcome.error);
			}
		});
	}

	/** Check `schemaVersion`, the version the connection now runs, in place of any check running. */
	start(schemaVersion: number): void {
		this.stop();
		if (this.waits.released.aborted || this.error) {
			return;
		}
		this.running = new AppSchemaVersionWatch(this.db, schemaVersion, this.waits.peers, recorded => {
			this.running = undefined;
			this.report(new AppSchemaOutdatedError(schemaVersion, recorded));
		});
	}

	/**
	 * Stop the running check, returning the version it checked, so a caller about to apply a newer schema
	 * is not reported superseded by its own record, and can start the old check again if its apply fails.
	 * A connect-time apply still deferred no longer starts one when it lands.
	 *
	 * NOTE: a live `applyAppSchema` that fails while the connect-time apply is still deferred leaves no
	 * check running, even once that deferred apply lands. Unreachable from cadre-core, which applies live
	 * only to a replica composed without a schema. If a host ever applies live during a deferral, have the
	 * failed apply hand the dropped `pending` back to {@link afterApply}.
	 */
	stop(): number | undefined {
		const running = this.running;
		this.running = undefined;
		this.pending = undefined;
		running?.stop();
		return running?.schemaVersion;
	}

	private report(error: AppSchemaOutdatedError): void {
		if (this.error || this.waits.released.aborted) {
			return;
		}
		this.error = error;
		log('A member recorded App schema version %d, above this connection\'s %d: the host must close the database', error.strandSchemaVersion, error.appSchemaVersion);
		for (const listener of [...this.listeners]) {
			deliver(listener, error);
		}
		this.listeners.clear();
	}
}

/** A listener's throw is logged, so one listener cannot keep the report from the others. */
function deliver(listener: AppSchemaSupersededListener, error: AppSchemaOutdatedError): void {
	try {
		listener(error);
	} catch (err) {
		log('An App schema superseded listener threw: %O', err);
	}
}

/**
 * The floor of the running version check: how long it goes without a read when no watch wake and no
 * peer connect has come. The change-notification renewal interval, which bounds a lost notification
 * the same way (docs/strands/app-schema.md → "Change notifications").
 *
 * NOTE: a member's writes between another member's record and this member's next check can still
 * erase what the newer version added: milliseconds with strand reactivity, up to this long without.
 * If that window matters before lenses land (`feat-app-schema-migration-through-lenses`), check the
 * version in the commit path instead of on a schedule.
 */
export const APP_SCHEMA_VERSION_CHECK_MS = 30_000;

/** How long a watch wake waits, so the two wakes one commit raises (Quereus's, then the storage bridge's) share one read. */
const WATCH_COALESCE_MS = 50;

/**
 * One running check of {@link AppSchemaVersionCheck}, for one version, until it finds a higher one
 * recorded or is stopped.
 *
 * NOTE: a read waits on the cohort while holding the database's statement lock, as any app read does,
 * so a member alone pays one such wait per floor interval. If that shows up as stalled app statements,
 * skip the floor's read while the strand node has no connections: a peer connect checks anyway.
 */
class AppSchemaVersionWatch {
	private readonly subscription: Subscription;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** When {@link timer} fires, so a wake due later leaves an earlier one armed. */
	private due = 0;
	private reading = false;
	/** A wake came while a read was in flight: read once more after it. */
	private again = false;
	private stopped = false;

	constructor(
		private readonly db: Database,
		readonly schemaVersion: number,
		private readonly peers: PeerConnectEvents | undefined,
		private readonly onHigher: (recorded: number) => void,
	) {
		const scope: ChangeScope = {
			watches: [{ table: VERSION_TABLE, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		// The handler runs inside the committing call: it only arms a timer.
		this.subscription = db.watch(scope, () => this.wake(WATCH_COALESCE_MS));
		peers?.addEventListener('peer:connect', this.onPeerConnect);
		this.wake(APP_SCHEMA_VERSION_CHECK_MS);
	}

	stop(): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.subscription.unsubscribe();
		this.peers?.removeEventListener('peer:connect', this.onPeerConnect);
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private readonly onPeerConnect = (): void => this.wake(COHORT_CONNECT_SETTLE_MS);

	/** Read in `delayMs`, unless a read is already due sooner. */
	private wake(delayMs: number): void {
		const due = Date.now() + delayMs;
		if (this.stopped || (this.timer !== undefined && this.due <= due)) {
			return;
		}
		clearTimeout(this.timer);
		this.due = due;
		this.timer = setTimeout(() => this.fire(), delayMs);
		// A connection its host never shuts down must not keep a Node process alive on this timer alone.
		(this.timer as { unref?: () => void }).unref?.();
	}

	private fire(): void {
		this.timer = undefined;
		if (this.reading) {
			this.again = true;
			return;
		}
		void this.check();
	}

	private async check(): Promise<void> {
		this.reading = true;
		const recorded = await this.readVersion();
		this.reading = false;
		if (this.stopped) {
			return;
		}
		if (recorded !== undefined && recorded > this.schemaVersion) {
			this.stop();
			this.onHigher(recorded);
			return;
		}
		const followUp = this.again;
		this.again = false;
		this.wake(followUp ? 0 : APP_SCHEMA_VERSION_CHECK_MS);
	}

	private async readVersion(): Promise<number | undefined> {
		try {
			return await readRecordedVersion(this.db);
		} catch (err) {
			log('App schema version check could not read the recorded version; the next check reads it again: %O', err);
			return undefined;
		}
	}
}
