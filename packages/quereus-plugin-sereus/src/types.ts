import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { SqlCommitDurabilityListener, CommitFullyHeldListener } from '@optimystic/quereus-plugin-optimystic/plugin';

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

export interface StrandConnectionOptions {
	/** UUID of the strand to connect to */
	strandId: string;
	/** Bootstrap multiaddrs for peer discovery */
	bootstrapNodes?: string[];
	/** sApp schema DDL to apply (optional - omit if schema already exists on strand) */
	schema?: string;
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
	/** Required when libp2pNode is provided */
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
}

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
	/** Shuts down the libp2p node and collection factory. Call when done. */
	shutdown: () => Promise<void>;
}

/**
 * Extended Libp2p node type with coordinatedRepo attached by createLibp2pNode.
 * @internal
 */
export interface Libp2pNodeWithRepo extends Libp2p {
	coordinatedRepo: IRepo;
}
