import debug from 'debug';
import type { Database, VTablePluginInfo, FunctionPluginInfo, CollationPluginInfo } from '@quereus/quereus';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import type { SqlCommitDurabilityListener, CommitFullyHeldListener, OfflineConfig, OfflineMode } from '@optimystic/quereus-plugin-optimystic/plugin';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IKVStore, IRawStorage, NodeOptions } from '@optimystic/db-p2p';
import type {
	StrandConnectionOptions, SereusPluginResult, StrandTransactor, Libp2pNodeWithRepo,
	StrandOfflineOptions, StrandOfflineController,
} from './types.js';
import { applyAppSchemaAfterQueue, type AppSchemaApply } from './app-schema.js';
import { STRAND_SCHEMA } from './strand-schema.js';
import { resolveStrandClusterSize, STRAND_CLUSTER_POLICY } from './cluster-size.js';
import { wrapStorageWithCache, disposeStorageCache } from './cached-storage.js';
import { createEmptyCollections, type CollectionRegistrySource } from './empty-collections.js';

const log = debug('sereus:plugin:strand');
const timing = debug('sereus:plugin:strand:timing');

/** The schemas whose tables a strand founder gives a collection: strand membership, then the sApp's. */
const FOUNDED_SCHEMAS = ['Strand', 'App'] as const;

/** The offline controller of each live strand composition composed with `offline`, by its `Database`. */
const offlineControllers = new WeakMap<Database, StrandOfflineController>();

/**
 * The offline controller of the live strand composition over `db`, or `undefined` when it was
 * composed without `offline`, has shut down, or `db` is no strand composition. For Sereus's own
 * writers, which are handed a bare `Database` and must see whether its queue holds transactions.
 */
export function offlineControllerOf(db: Database): StrandOfflineController | undefined {
	return offlineControllers.get(db);
}

/**
 * Minimal interface for the CollectionFactory returned by the optimystic plugin.
 * We only need the methods this composition actually uses.
 */
interface CollectionFactory {
	registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void;
	/** Releases the read caches and network watches; leaves every registered node running. */
	dispose(): Promise<void>;
	/** {@link dispose}, after stopping every registered node. */
	shutdown(): Promise<void>;
}

/**
 * Release a composition's hold on the optimystic plugin. The offline queue goes first: its drain
 * keeps timers and may have a submission in flight, which reports its commit through the bridge's
 * follower, so the bridge must outlive it (the plugin's own `dispose()` orders them the same way).
 * A queue `hydrate` restored before a failed composition is stopped here too. Then the transaction
 * bridge: its durability follower subscribes to the node's `StorageRepo`, and cadre-core keeps a
 * strand's node across a database rebuild, so a bridge never disposed stays subscribed once per
 * rebuild. Then the collection factory: a node the composition created is stopped with it; an
 * injected node is left running, because it belongs to the caller — cadre-core keeps a strand's
 * node up across a failed database build and retries the build on it.
 *
 * Disposes the queue and bridge itself rather than calling the plugin's `dispose()`, which would
 * release the factory a second time on the created-node path (`shutdown()` ends with the same
 * `dispose()`).
 */
async function releaseOptimysticPlugin(plugin: OptimysticPluginResult, createdNode: Libp2p | null): Promise<void> {
	await plugin.offline.dispose();
	// NOTE: the bridge's follower re-subscribes at the start of any transaction, so a write begun on
	// this `Database` after release (before its owner closes it) subscribes again and nothing
	// releases it. cadre-core stops its own writers before releasing; if an app write in flight at
	// close ever shows up as a leaked subscription, close the `Database` before releasing.
	plugin.txnBridge.dispose();
	const { collectionFactory } = plugin;
	if (!createdNode) {
		await collectionFactory.dispose();
		return;
	}
	await collectionFactory.shutdown();
	// Stopped again for a node created but not yet registered (a missing `coordinatedRepo`);
	// a second stop of a registered one is a no-op.
	await createdNode.stop();
}

/**
 * Result of registering the optimystic plugin. The published plugin signature
 * does not surface `collectionFactory` / `hydrate`, so this is the local shim
 * over what `@optimystic/quereus-plugin-optimystic/plugin` actually returns
 * (see its `plugin.ts` — `hydrate` delegates to `optimysticModule.hydrateCatalog`).
 */
interface OptimysticPluginResult {
	collectionFactory: CollectionFactory;
	vtables: VTablePluginInfo[];
	functions: FunctionPluginInfo[];
	collations?: CollationPluginInfo[];
	/**
	 * Hydrate Quereus's in-memory catalog from persisted optimystic vtab schemas.
	 * Must run BEFORE `apply schema App;` on a warm restart so the declarative
	 * diff sees the existing tables and skips re-emitting CREATE TABLE / CREATE
	 * INDEX for each persisted object. Idempotent; `{ tables: 0, indexes: 0 }`
	 * on cold start.
	 */
	hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>;
	onCommitDurability: (listener: SqlCommitDurabilityListener) => () => void;
	onCommitFullyHeld: (listener: CommitFullyHeldListener) => () => void;
	/**
	 * Holds the durability follower's subscription to the node's `StorageRepo` (see
	 * {@link releaseOptimysticPlugin}) and the registry of every collection a table opened (see
	 * {@link createEmptyCollections}).
	 */
	txnBridge: { dispose(): void } & CollectionRegistrySource;
	/** The offline queue, constructed on every registration; idle until something is queued. */
	offline: OfflineMode;
	[key: string]: unknown;
}

/** Registration shape shared by the crypto and optimystic plugin results. */
interface PluginRegistrations {
	vtables?: VTablePluginInfo[];
	functions?: FunctionPluginInfo[];
	collations?: CollationPluginInfo[];
}

/**
 * Inline equivalent of `@quereus/quereus`'s `registerPlugin` for plugins that
 * only return functions/vtables/collations. Used directly for the optimystic
 * result (so the composition can read `collectionFactory` off the same object),
 * and by the browser crypto strategy to keep the browser bundle from pulling a
 * duplicate `@quereus/quereus` next to the host's instance.
 */
export function applyRegistrations(db: Database, result: PluginRegistrations): void {
	for (const vtable of result.vtables ?? []) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of result.functions ?? []) {
		db.registerFunction(func.schema);
	}
	for (const collation of result.collations ?? []) {
		db.registerCollation(collation.name, collation.func, collation.normalizer);
	}
}

/** Context passed to the platform's node-creation strategy. */
export interface CreateNodeContext {
	networkName: string;
	bootstrapNodes: string[];
	fretProfile: 'edge' | 'core';
	/** libp2p listening port (Node TCP). Browser transports ignore it. */
	port: number;
	/**
	 * Resolved replication cluster size. Already defaulted — pass it to
	 * `createLibp2pNode` verbatim; omitting it falls back to Optimystic's own
	 * default of 10, which gates writes on any smaller party.
	 */
	clusterSize: number;
	/**
	 * The strand cluster policy, resolved here so no platform has to remember it.
	 * Pass it to `createLibp2pNode` verbatim.
	 *
	 * Omitting it does NOT fall back to something equivalent: Optimystic then computes
	 * its read-repair corroboration floor against `clusterSize` instead of against
	 * {@link STRAND_CLUSTER_POLICY}'s `assumedClusterSize`, which is a stricter demand
	 * than a two-machine strand can meet — so repair of a damaged block gives up where
	 * it would otherwise succeed. That is the same defect class that took the *control*
	 * network's e2e suite down before `42cd12c`; see `cluster-size.ts` for the reasoning
	 * written out in full.
	 */
	clusterPolicy: NonNullable<NodeOptions['clusterPolicy']>;
	/** Resolved persistent storage to back the node, if any. */
	storage?: IRawStorage;
}

/** Context passed to the platform's storage-resolution strategy. */
export interface ResolveStorageContext {
	strandId: string;
	resolvedTransactor: StrandTransactor;
	/** The storage the caller passed in `options.storage`, if any. */
	requestedStorage?: IRawStorage;
}

/**
 * Platform-specific seams the shared composition delegates to. Everything else
 * (transactor resolution, plugin config, registration, default vtab, hydrate,
 * schema apply, cleanup/shutdown) is identical across Node and browser and lives
 * in {@link composeStrand}.
 */
export interface StrandPlatform {
	/**
	 * Register the crypto plugin against `db`. Node uses `@quereus/quereus`'s
	 * `registerPlugin`; the browser inlines `applyRegistrations` to avoid bundling
	 * a second `@quereus/quereus`.
	 */
	registerCrypto(db: Database): void | Promise<void>;
	/**
	 * Resolve the persistent storage to use. Optional — when omitted the caller's
	 * `options.storage` is used verbatim (Node). The browser supplies this to
	 * default to IndexedDB so a reload survives.
	 */
	resolveStorage?(ctx: ResolveStorageContext): Promise<IRawStorage | undefined> | IRawStorage | undefined;
	/**
	 * The store to journal offline transactions in when `options.offline` names no `journal`.
	 * Called after {@link resolveStorage}, only when `options.offline` is given. Optional — when
	 * omitted, or when it answers `undefined`, the queue lives in memory (Node). The browser answers
	 * a store over the IndexedDB database it defaulted the strand's storage to.
	 */
	defaultOfflineJournal?(): IKVStore | undefined;
	/**
	 * Create a libp2p node. Called only when no node is injected and the
	 * transactor needs one. Node creates a TCP node via `@optimystic/db-p2p`;
	 * the browser creates a WebSockets + circuit-relay node via the `/rn` entry.
	 * Returns the created node (its `coordinatedRepo` is read by the composition).
	 */
	createNode(ctx: CreateNodeContext): Promise<Libp2p>;
}

/**
 * Connect a Quereus `Database` to a Sereus strand. This is the single shared
 * SQL-surface composition: `connectToStrand` (Node), `connectToStrandBrowser`
 * (browser), and `cadre-core`'s `StrandDatabase` all flow through here, so the
 * hydrate-before-apply fix and any future schema wiring land in one place.
 *
 * Steps: resolve transactor + storage, register crypto + optimystic plugins,
 * acquire (inject or create) the libp2p node, set optimystic as the default
 * vtab, hydrate the catalog, then apply the sApp schema.
 */
export async function composeStrand(
	db: Database,
	options: StrandConnectionOptions,
	platform: StrandPlatform,
): Promise<SereusPluginResult> {
	const {
		strandId,
		bootstrapNodes = [],
		schema,
		port = 0,
		enableCache = true,
		fretProfile = 'edge',
		transactor = 'network',
	} = options;

	// Resolve (and validate) up front so a nonsense value fails before any plugin
	// registration or node creation has happened.
	const clusterSize = resolveStrandClusterSize(options.clusterSize);

	// The storage engine every write and read below goes through — see
	// `StrandConnectionOptions.transactor`. Named separately from the option so
	// the default is applied exactly once and reported on the result.
	const resolvedTransactor: StrandTransactor = transactor;

	const networkName = `strand-${strandId}`;
	log('Connecting to strand %s (network: %s, transactor=%s)',
		strandId, networkName, resolvedTransactor);

	// Resolve storage. Node passes `options.storage` through; the browser
	// defaults to IndexedDB. The resolved instance feeds BOTH the local
	// transactor's `rawStorageFactory` and node creation, so it must be decided
	// up front (before pluginConfig is built). Wrapped in the write-through
	// raw-storage cache (cached-storage.ts) — idempotent, so a caller that
	// already wrapped (cadre-core's seams) passes through unchanged, with this
	// composition counted as one more holder of that same cache.
	const resolvedStorage = platform.resolveStorage
		? await platform.resolveStorage({ strandId, resolvedTransactor, requestedStorage: options.storage })
		: options.storage;
	const storage = resolvedStorage ? wrapStorageWithCache(resolvedStorage, strandId) : resolvedStorage;

	/**
	 * Release THIS composition's claim on the storage cache — the matching half of the
	 * wrap above, which took one. `wrapStorageWithCache` counts holders, so this is
	 * unconditionally correct whoever created the wrapper: the cache stays live while
	 * cadre-core (or any other seam over the same store) still holds a claim, and is
	 * emptied and unregistered from the shared cache pool when the last one goes. Holding
	 * a claim past the strand's life is not free — the registration claims the backing
	 * store in the pool, and a claim outliving its strand makes the next connect over that
	 * same directory throw.
	 *
	 * Latched, so a caller that calls `shutdown()` twice releases one claim, not two — a
	 * second release would consume another scope's claim.
	 */
	let storageCacheReleased = false;
	const releaseStorageCache = async (): Promise<void> => {
		if (storageCacheReleased || !storage) {
			return;
		}
		storageCacheReleased = true;
		await disposeStorageCache(storage);
	};

	// 1-2. Register the crypto and optimystic plugins. Guarded on its own, because the
	// wrap above has ALREADY taken a holder claim: a registration that throws must release
	// it, or the claim — and the backing store's registration in the shared cache pool —
	// outlives the failed connect for the process lifetime, and no other scope can retire
	// the cache. Separate from the larger try below, which has a collection factory and
	// possibly a node to tear down as well; neither exists yet here.
	let pluginResult: OptimysticPluginResult;
	try {
		pluginResult = await registerStrandPlugins(db, platform, {
			resolvedTransactor,
			networkName,
			enableCache,
			storage,
			offline: options.offline && strandOfflineConfig(strandId, options.offline, platform),
		});
	} catch (err) {
		await releaseStorageCache();
		throw err;
	}

	const { collectionFactory } = pluginResult;
	const offline: StrandOfflineController | undefined = options.offline && pluginResult.offline;
	if (offline) {
		offlineControllers.set(db, offline);
	}
	// Aborted by `shutdown`, so a deferred sApp schema apply still waiting settles `cancelled`.
	const released = new AbortController();
	let appSchemaApply: AppSchemaApply | undefined;

	let createdNode: Libp2p | null = null;
	let hydrated: { tables: number; indexes: number } | undefined;

	try {
		// 3. Acquire the libp2p node. Skip only when this is the unit-test fake
		// transactor with no injected node — every real path needs a node.
		if (resolvedTransactor !== 'test' || options.libp2pNode) {
			let node: Libp2p;
			let coordinatedRepo: IRepo;

			if (options.libp2pNode) {
				node = options.libp2pNode;
				if (!options.coordinatedRepo) {
					throw new Error('coordinatedRepo is required when libp2pNode is provided');
				}
				coordinatedRepo = options.coordinatedRepo;
				log('Using injected libp2p node');
			} else {
				// NOTE: this path takes the frozen policy whole, so it takes COHORT_READ_DEADLINE_MS
				// with no way to override it — `StrandConnectionOptions` has no counterpart to
				// cadre-core's `NetworkConfig.cohortQueryTimeoutMs` or `linkRoundTripMs`. Fine
				// today: every production strand comes up through cadre-core, which does thread
				// both, and this path is the plugin's own connect/e2e route, where the constant —
				// two link round trips at cadre's default declared link — is the right answer
				// anyway. If a plugin embedder ever needs a different deadline,
				// `strandClusterPolicy(clusterSize, { cohortQueryTimeoutMs: <ms> })` is the call to
				// reach for here.
				const created = await platform.createNode({ networkName, bootstrapNodes, fretProfile, port, clusterSize, clusterPolicy: STRAND_CLUSTER_POLICY, storage });
				createdNode = created;
				node = created;
				const repo = (created as Libp2pNodeWithRepo).coordinatedRepo;
				if (!repo) {
					throw new Error('coordinatedRepo not available on created libp2p node');
				}
				coordinatedRepo = repo;
				log('Created libp2p node (port: %d, fretProfile: %s, storage=%s)', port, fretProfile, !!storage);
			}

			collectionFactory.registerLibp2pNode(networkName, node, coordinatedRepo);
			log('Registered libp2p node with collection factory');
		}

		// 4. Set optimystic as default vtab so `declare schema` tables use it.
		db.setDefaultVtabName('optimystic');
		db.setDefaultVtabArgs({
			networkName,
			transactor: resolvedTransactor,
			keyNetwork: 'libp2p',
		});
		log('Set default vtab to optimystic (networkName=%s, transactor=%s)', networkName, resolvedTransactor);

		// 5. Hydrate Quereus's catalog from persisted optimystic vtab schemas
		// BEFORE applying the sApp schema. Without this, a warm restart diffs the
		// wrapped DDL against an empty catalog and re-emits CREATE TABLE / CREATE
		// INDEX for every persisted object — each round-tripping through optimystic
		// storage (the measured ~160s warm-start regression). No-op on first launch.
		const t0 = performance.now();
		hydrated = await pluginResult.hydrate(db);
		timing('[strand:%s] hydrate: %dms (tables=%d, indexes=%d)',
			strandId, Math.round(performance.now() - t0), hydrated.tables, hydrated.indexes);
		log('Hydrated catalog for strand %s (tables=%d, indexes=%d)', strandId, hydrated.tables, hydrated.indexes);

		// 6. Apply the strand membership/RBAC schema (`schemas/strand.qsql`,
		// embedded as STRAND_SCHEMA) UNCONDITIONALLY — every strand has membership
		// semantics whether or not an sApp schema is supplied. There are no
		// cross-schema references between `Strand` and `App`, so order is
		// irrelevant; apply `Strand` first for clarity. Because this runs AFTER
		// hydrate, a warm restart diffs the membership DDL against the already-
		// hydrated catalog and re-emits nothing (same fix as the sApp apply).
		//
		// This ticket only makes the tables present and their constraints active;
		// nothing here writes membership rows. Founder bootstrap (Header, founding
		// Manager/Member, invite/peer flows) is owned by the lifecycle ticket
		// `strand-membership-lifecycle-population`.
		//
		// NOTE: unlike step 7, this apply is not deferred behind the offline queue. Every `Strand`
		// table is tagged `"optimystic.offline" = 'network'`, so the only queued transactions that
		// write one are network-acknowledged commits waiting behind app transactions, and the only
		// change this schema has made since is a tag, which the queue does not refuse. If a
		// later strand schema changes how a table's rows are stored (an index, a column), this apply
		// can be refused by `QueuedEntriesBlockSchemaChangeError` the same way and needs step 7's path.
		log('Applying Strand membership schema for strand %s', strandId);
		await db.exec(`
			declare schema Strand {
				${STRAND_SCHEMA}
			}
			apply schema Strand;
		`);
		log('Strand membership schema applied');

		// 7. Apply the sApp schema, if provided.
		//
		// SEAM: this and the Strand apply above are the single composition point
		// where strand-level declarative DDL is applied. Keep new schema wiring
		// here so it stays a one-location edit across Node, browser, and cadre-core.
		//
		// NOTE: neither apply is retried here — a failure releases this composition and throws,
		// and a later connect builds a fresh `Database` and re-hydrates from storage. A
		// failed apply is normally taken back whole (Quereus unwinds its migration steps
		// and verifies the catalog against a pre-apply fingerprint), so the next connect
		// diffs against the state the apply started from. The sApp schema is the one
		// supplied by the EMBEDDER, and the steps that DISCARD data — dropping a table,
		// dropping a column, narrowing a column's type — are irreversible to Quereus's
		// differ: once one has run, any later step that fails leaves the schema partially
		// migrated instead of restored. No schema in this repo evolves that way, so this
		// is a note for whoever first ships a migration that does.
		//
		// The one exception: an apply refused by queued offline transactions does not fail the
		// connect. The strand comes up on the `App` schema it had, and the apply is retried as the
		// queue drains (see `applyAppSchemaAfterQueue`).
		if (schema) {
			log('Applying sApp schema for strand %s', strandId);
			appSchemaApply = await applyAppSchemaAfterQueue(db, schema, pluginResult.offline, released.signal);
		}
	} catch (err) {
		// Clean up resources if setup fails after partial initialization.
		offlineControllers.delete(db);
		await releaseOptimysticPlugin(pluginResult, createdNode);
		await releaseStorageCache();
		throw err;
	}

	// 8. Return result with hydrate counts, the commit-durability listeners, the founder's
	// empty-collection step + shutdown handler.
	// `shutdown` releases the plugin and stops the node only if this composition created it.
	return {
		vtables: [],
		functions: [],
		collations: [],
		hydrated,
		transactor: resolvedTransactor,
		onCommitDurability: listener => pluginResult.onCommitDurability(listener),
		onCommitFullyHeld: listener => pluginResult.onCommitFullyHeld(listener),
		createEmptyCollections: except => createEmptyCollections(db, pluginResult.txnBridge, FOUNDED_SCHEMAS, except),
		...(offline && { offline }),
		...appSchemaApply,
		async shutdown() {
			log('Shutting down strand connection %s', strandId);
			// NOTE: a deferred sApp schema apply already running is not awaited: it runs on against the
			// released plugin, Quereus unwinds it when it fails, and `appSchema` settles `cancelled`. If
			// that ever leaves a catalog write landing after close, await `appSchema` here first.
			released.abort();
			offlineControllers.delete(db);
			await releaseOptimysticPlugin(pluginResult, createdNode);
			await releaseStorageCache();
			log('Strand connection %s shut down', strandId);
		},
	};
}

/**
 * The Optimystic plugin's `offline` block for this strand: the caller's options, the platform's
 * journal when the caller named none, and the journal label, which the plugin refuses without one.
 */
function strandOfflineConfig(strandId: string, offline: StrandOfflineOptions, platform: StrandPlatform): OfflineConfig {
	const journal = offline.journal ?? platform.defaultOfflineJournal?.();
	return journal === undefined
		? { ...offline }
		: { ...offline, journal, journalLabel: strandJournalLabel(strandId) };
}

/**
 * The offline journal label for a strand. A label is `[a-z0-9_-]` and a strand id `[a-z0-9._-]`, so
 * `_` becomes `__` and `.` becomes `_d`: no two strand ids share a label, and two strands journaling
 * into one store keep their records apart.
 */
function strandJournalLabel(strandId: string): string {
	return `strand-${strandId.replaceAll('_', '__').replaceAll('.', '_d')}`;
}

/**
 * Steps 1-2 of {@link composeStrand}: register the crypto plugin, then the optimystic
 * plugin carrying this strand's transactor defaults. Split out so the composition can
 * guard the pair against the storage-cache claim it has already taken.
 */
async function registerStrandPlugins(
	db: Database,
	platform: StrandPlatform,
	strand: {
		resolvedTransactor: StrandTransactor;
		networkName: string;
		enableCache: boolean;
		storage: IRawStorage | undefined;
		offline: OfflineConfig | undefined;
	},
): Promise<OptimysticPluginResult> {
	await platform.registerCrypto(db);
	log('Registered crypto plugin');

	// On the local transactor with persistent storage, hand the same instance to the
	// plugin so DML persists on the host backend (not in-memory).
	const pluginConfig: Record<string, unknown> = {
		default_transactor: strand.resolvedTransactor,
		default_key_network: 'libp2p',
		default_network_name: strand.networkName,
		enable_cache: strand.enableCache,
	};
	if (strand.resolvedTransactor === 'local' && strand.storage) {
		const storage = strand.storage;
		pluginConfig.rawStorageFactory = () => storage;
	}
	// NOTE: `networkCommitTimeoutMs` is left at upstream's default (five minutes); nothing was
	// measured to choose another. A network-acknowledged commit made while transactions are queued
	// (any `Strand` write, all of them tagged 'network') waits that long behind them holding
	// Quereus's execution lock. If that ever shows up as a frozen app, lower it for strands here.
	if (strand.offline) {
		pluginConfig.offline = strand.offline;
	}
	// The plugin's published signature is `Record<string, SqlValue>` but it also reads
	// `rawStorageFactory` (a function reference) and `offline` (an object) from the same
	// map. Cast through unknown rather than widen the public type.
	const pluginResult = optimysticPlugin(
		db,
		pluginConfig as unknown as Parameters<typeof optimysticPlugin>[1],
	) as unknown as OptimysticPluginResult;
	applyRegistrations(db, pluginResult);
	log('Registered optimystic vtables and functions');
	return pluginResult;
}
