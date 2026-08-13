import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';

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
