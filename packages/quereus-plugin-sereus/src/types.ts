import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';

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
	 * built with its own value). Every peer on the strand must use the same
	 * number — see `resolveClusterSize`. Defaults to `DEFAULT_CLUSTER_SIZE` (2).
	 */
	clusterSize?: number;
	/** Inject an existing libp2p node instead of creating one */
	libp2pNode?: Libp2p;
	/** Required when libp2pNode is provided */
	coordinatedRepo?: IRepo;
	/**
	 * Lifecycle mode. `'networked'` (default) uses the network transactor and
	 * is appropriate for multi-peer participation. `'bootstrap'` switches to a
	 * local transactor so a solo node can apply schema and accept DML with no
	 * peer round trips; pair it with a persistent `storage` to survive restart.
	 */
	mode?: 'bootstrap' | 'networked';
	/**
	 * Persistent raw storage. When provided:
	 *  - it is passed to `createLibp2pNode` as `storage` so the libp2p data path uses it,
	 *  - in `bootstrap` mode it is also handed to the optimystic plugin as
	 *    `rawStorageFactory: () => storage` so the local transactor persists DML
	 *    on the same instance (avoids cache divergence between the two consumers).
	 *
	 * The plugin treats `storage` as borrowed — it is NOT closed on `shutdown()`.
	 */
	storage?: IRawStorage;
	/** @internal Override transactor type. Used by unit tests with `'test'`. When set, takes precedence only if `mode` is not specified. */
	transactor?: string;
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
