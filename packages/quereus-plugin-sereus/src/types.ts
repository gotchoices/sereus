import type { Libp2p } from '@libp2p/interface';
import type { ICohortReachability, IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { SqlCommitDurabilityListener, CommitFullyHeldListener, OfflineConfig, OfflineMode } from '@optimystic/quereus-plugin-optimystic/plugin';
import type { AppSchemaOutdatedError } from './app-schema-errors.js';
import type { VersionedAppSchema } from './app-schema.js';

/**
 * Which Optimystic transactor a strand connection commits through — a choice of
 * storage engine, nothing more. See {@link StrandConnectionOptions.transactor}.
 *
 * Deliberately a closed union, and narrower than what Optimystic's
 * `collection-factory.ts` accepts: that factory also switches on `'mesh-test'`
 * (its production transactor stack over a one-node mock mesh) and falls through
 * to a host-registered custom transactor for any other name. Neither is offered
 * here — `composeStrand`'s node gate special-cases only `'test'`, so
 * `'mesh-test'` would get a real libp2p node it does not want, and nothing in
 * this repo registers a custom transactor. A closed union lets `parseConfig`
 * reject a typo (`'locl'`) instead of handing it downstream; widen it (and the
 * node gate with it) when one of those values is actually needed.
 */
export type StrandTransactor = 'local' | 'network' | 'test';

/**
 * The sApp schema a connection applies, and its version: both or neither, so a schema cannot reach the
 * strand without the number its version gate compares (docs/strands/app-schema.md → "Every member on
 * the same schema version").
 */
export type StrandAppSchemaOptions =
	| {
		/** sApp schema DDL to apply, as the body of `declare schema App { … }`. */
		schema: string;
		/**
		 * Version of {@link schema}: a whole number of at least 1 the app raises with every change to it.
		 * The connect refuses with `AppSchemaOutdatedError` when the strand records a higher one.
		 */
		schemaVersion: number;
	}
	/** No sApp schema: a storage replica, or a connection to the strand's tables alone. */
	| { schema?: undefined; schemaVersion?: undefined };

export type StrandConnectionOptions = StrandConnectionBaseOptions & StrandAppSchemaOptions;

/** {@link StrandConnectionOptions} apart from the sApp schema. */
export interface StrandConnectionBaseOptions {
	/** UUID of the strand to connect to */
	strandId: string;
	/** Bootstrap multiaddrs for peer discovery */
	bootstrapNodes?: string[];
	/** sApp author public key */
	sAppId?: string;
	/** sApp version */
	sAppVersion?: string;
	/** libp2p listening port (default: 0 = random) */
	port?: number;
	/** Enable optimystic caching (default: true) */
	enableCache?: boolean;
	/** FRET profile (default: 'edge') */
	fretProfile?: 'edge' | 'core';
	/**
	 * Number of nodes Optimystic is told this strand's replication cluster should
	 * have. Ignored when {@link libp2pNode} is injected (the injected node was
	 * built with its own value). Every peer on the strand should use the same
	 * number — see `resolveStrandClusterSize`. Defaults to
	 * `DEFAULT_STRAND_CLUSTER_SIZE` (4 — the smallest breadth whose 0.75
	 * super-majority still commits with one holder offline).
	 */
	clusterSize?: number;
	/** Inject an existing libp2p node instead of creating one */
	libp2pNode?: Libp2p;
	/**
	 * The handle through which {@link libp2pNode} coordinates writes to the blocks it holds.
	 * Required with an injected node that serves blocks, and refused with one that does not
	 * (a client node, `NodeOptions.servesBlocks: false`, holds no blocks and so has none).
	 * Unused when no node is injected: a node this connection creates always serves blocks,
	 * and its repo is read off the node.
	 */
	coordinatedRepo?: IRepo;
	/**
	 * Persistent raw storage. When provided:
	 *  - it is passed to `createLibp2pNode` as `storage` so the libp2p data path uses it,
	 *  - with `transactor: 'local'` it is also handed to the optimystic plugin as
	 *    `rawStorageFactory: () => storage` so the local transactor persists DML
	 *    on the same instance (avoids cache divergence between the two consumers).
	 *
	 * The plugin treats `storage` as borrowed — it is NOT closed on `shutdown()`.
	 */
	storage?: IRawStorage;
	/**
	 * Which Optimystic transactor writes and reads go through (default
	 * `'network'`):
	 *
	 *  - `'network'` — transactions go through the strand's libp2p cohort. A node
	 *    that is alone coordinates for itself, so this works with one peer or
	 *    many; it is the only value an application should use.
	 *  - `'local'` — transactions go straight to this process's raw storage, no
	 *    peers consulted. For in-process tests and tooling; pair it with a
	 *    persistent {@link storage} to survive restart.
	 *  - `'test'` — Optimystic's in-memory fake. No libp2p node is created unless
	 *    one is injected. Unit tests only.
	 */
	transactor?: StrandTransactor;
	/**
	 * Turn on Optimystic's offline queue for this connection (docs/strands/writes.md → "Offline mode").
	 * Absent: no offline configuration reaches the plugin, and the result carries no
	 * {@link SereusPluginResult.offline}. Programmatic only — the SQL plugin config cannot carry it.
	 */
	offline?: StrandOfflineOptions;
	/**
	 * The gate this connection's offline queue and offline live reads ask, in place of the node's
	 * own `cohortReachability` (Optimystic's `docs/offline-sync.md` → "When to submit"). Registered
	 * with the collection factory before any table opens, so every table takes it. cadre-core passes
	 * a gate that also waits for the party's own machines (docs/strands/writes.md → "Waiting for the
	 * party's own machines"). Absent: the node's gate, or the always-open one on a transactor without a
	 * cohort.
	 */
	cohortReachability?: ICohortReachability;
}

/**
 * The Optimystic plugin's `offline` registration block (its README § "Offline mode"), less
 * `journalLabel`: the composition derives the label from the strand id (`strandJournalLabel`).
 * Without a `journal` the queue lives in memory, except where a platform defaults one (the browser
 * connect journals into the strand's IndexedDB database).
 */
export type StrandOfflineOptions = Omit<OfflineConfig, 'journalLabel'>;

/**
 * The application's handle on a strand connection's offline queue: the part of Optimystic's
 * `OfflineMode` an app calls. The class's other public methods are the plugin's internals.
 */
export type StrandOfflineController = Pick<OfflineMode,
	'enter' | 'exit' | 'isEntered' | 'whenDrained' | 'onStatus' | 'onQueueState' | 'queueState'
	| 'entries' | 'status' | 'discard' | 'outcomes' | 'acknowledge'>;

/** What a deferred sApp schema apply waits for (see {@link SereusPluginResult.appSchemaWaitingFor}). */
export type AppSchemaWait = 'queue' | 'cohort';

/**
 * How a connection's sApp schema apply ended (see {@link SereusPluginResult.appSchema}):
 *
 *  - `applied` — the schema is in place. `deferred` when the first apply was refused (by queued
 *    offline transactions, or because the strand's cohort could not be reached) and a later one landed.
 *  - `failed` — a deferred retry failed for another reason; the connection keeps the schema it had
 *    before.
 *  - `cancelled` — the connection shut down before a deferred retry landed.
 */
export type AppSchemaOutcome =
	| { state: 'applied'; deferred?: true }
	| { state: 'failed'; error: unknown }
	| { state: 'cancelled' };

export interface SereusPluginResult {
	vtables: [];
	functions: [];
	collations: [];
	/**
	 * Catalog-hydration counts from the warm-restart hydrate that runs before
	 * `apply schema App;`. On a cold start (empty storage) both are 0; on a warm
	 * restart they report the persisted tables/indexes the catalog was primed
	 * with — so a test can assert hydration actually ran. `undefined` only if
	 * composition threw before hydrate.
	 */
	hydrated?: { tables: number; indexes: number };
	/**
	 * The transactor this connection actually resolved to — the RESOLVED value,
	 * not the requested one, so a spec whose whole point is the arm it runs on can
	 * assert it rather than assume it. Equals `options.transactor` when one was
	 * given, `'network'` otherwise.
	 */
	transactor: StrandTransactor;
	/**
	 * Be told, after every commit on this connection that wrote something, who holds what it
	 * wrote. Called once per such commit, synchronously, before the commit returns. The Optimystic
	 * plugin's listener of the same name, passed through; what the report means is in that
	 * plugin's README § "A commit's durability". Returns an idempotent unsubscribe.
	 */
	onCommitDurability: (listener: SqlCommitDurabilityListener) => () => void;
	/**
	 * Be told once when a commit reported `followed` below full replication becomes held by
	 * every member of its cohort. Can fire inside the commit, right after its durability report.
	 * Followed commits live in memory: {@link shutdown} or a restart forgets them, and nothing
	 * fires for a forgotten one. Passed through like {@link onCommitDurability}.
	 */
	onCommitFullyHeld: (listener: CommitFullyHeldListener) => () => void;
	/**
	 * Commit an empty collection for every table declared in the `Strand` and `App` schemas that
	 * has none yet (main, index and unique-enforcement trees), and resolve to how many were
	 * committed. A founder calls it before its founding write, so a read of a table nobody has
	 * written is answered from local storage rather than by the cohort proving absence.
	 *
	 * `except` names qualified tables (`'Strand.Header'`) the caller is about to write, whose
	 * collections that write creates; every tree of those tables is left out. A name matching no
	 * declared table throws.
	 *
	 * Run it only while no other writer can reach this connection's `Database`: each collection's
	 * `sync()` commits whatever is staged in it, outside any SQL transaction.
	 */
	createEmptyCollections: (except?: readonly string[]) => Promise<number>;
	/** The offline queue's controller. Present only when {@link StrandConnectionOptions.offline} was given. */
	offline?: StrandOfflineController;
	/**
	 * Present when {@link StrandConnectionOptions.schema} was given; never rejects. Resolves
	 * `{ state: 'applied' }` at once when the apply succeeded at connect. When queued offline
	 * transactions refused it, or the strand's cohort could not be reached, the connection comes up
	 * anyway and retries ({@link appSchemaWaitingFor}); this settles when a retry lands, fails
	 * otherwise, or {@link shutdown} runs first.
	 */
	appSchema?: Promise<AppSchemaOutcome>;
	/**
	 * What the connect-time apply waits for: `'queue'`, queued offline transactions (retried each time
	 * the queue drains), or `'cohort'`, the strand's members (retried when the strand node connects to
	 * a peer, and on a backoff). Present only when it was deferred.
	 */
	appSchemaWaitingFor?: AppSchemaWait;
	/** The queued transaction ids that refused the connect-time apply. Present only when the queue refused it. */
	appSchemaDeferredBy?: readonly string[];
	/**
	 * Be told once that another member has recorded a higher App schema version than the one this
	 * connection runs, as an `AppSchemaOutdatedError` naming both. This connection's writes can then
	 * erase what the newer version added, with no error anywhere, so the host must close the database
	 * (cadre-core stops the strand). Reported by a check that runs from when the `App` schema is applied
	 * until {@link shutdown} (docs/strands/app-schema.md → "A running member stops"), and by a deferred
	 * {@link appSchema} retry that finds the strand ahead. Never on a connection with no `App` schema. A
	 * listener added after the report is called at once. Returns an idempotent unsubscribe.
	 */
	onAppSchemaSuperseded: (listener: (error: AppSchemaOutdatedError) => void) => () => void;
	/**
	 * Apply an `App` schema to this live connection, as an app claiming a strand it serves as a storage
	 * replica does (cadre-core's `StrandDatabase.attachAppSchema`): the declaration, version gate and
	 * refusals of the connect-time apply, not deferred. Once it lands, the version check of
	 * {@link onAppSchemaSuperseded} runs for `app.schemaVersion`.
	 */
	applyAppSchema: (app: VersionedAppSchema) => Promise<void>;
	/** Shuts down the libp2p node and collection factory. Call when done. */
	shutdown: () => Promise<void>;
}

/**
 * A libp2p node as the composition reads it: the handles `createLibp2pNode` attaches that
 * matter here. Both fields are optional because neither is guaranteed on a node that reaches
 * `composeStrand`:
 *
 *  - a client node (`NodeOptions.servesBlocks: false`) declares `servesBlocks: false` and carries
 *    no `coordinatedRepo` at all — it stores no blocks, so there is nothing to coordinate writes to;
 *  - a node built by something other than `createLibp2pNode` carries neither field.
 *
 * Optimystic's own `FactoryNode` records the same reasoning. Read `servesBlocks === false`
 * explicitly, never `!servesBlocks`: the second treats a node that declares nothing as a client.
 * @internal
 */
export interface Libp2pNodeWithRepo extends Libp2p {
	coordinatedRepo?: IRepo;
	servesBlocks?: boolean;
}
