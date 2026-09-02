import debug from 'debug';
import type { Database, VTablePluginInfo, FunctionPluginInfo, CollationPluginInfo } from '@quereus/quereus';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage, NodeOptions } from '@optimystic/db-p2p';
import type { StrandConnectionOptions, SereusPluginResult, StrandTransactor, Libp2pNodeWithRepo } from './types.js';
import { STRAND_SCHEMA } from './strand-schema.js';
import { resolveStrandClusterSize, STRAND_CLUSTER_POLICY } from './cluster-size.js';
import { wrapStorageWithCache, disposeStorageCache } from './cached-storage.js';

const log = debug('sereus:plugin:strand');
const timing = debug('sereus:plugin:strand:timing');

/**
 * Minimal interface for the CollectionFactory returned by the optimystic plugin.
 * We only need the methods this composition actually uses.
 */
interface CollectionFactory {
	registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void;
	shutdown(): Promise<void>;
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
	// already wrapped (cadre-core's seams) passes through unchanged.
	const resolvedStorage = platform.resolveStorage
		? await platform.resolveStorage({ strandId, resolvedTransactor, requestedStorage: options.storage })
		: options.storage;
	const storage = resolvedStorage ? wrapStorageWithCache(resolvedStorage, strandId) : resolvedStorage;
	// This composition OWNS the cache when the wrap it just made is a new object: the
	// embedder handed over a bare store, so nothing upstream holds the wrapper to release
	// it. (cadre-core's seams wrap first and pass the wrapper down, which comes back
	// unchanged and stays theirs to dispose.) Owned means `shutdown` must dispose it —
	// the wrapper's registration claims the backing store in the shared cache pool, and a
	// claim outliving its strand makes the next connect over that same directory throw.
	const ownedStorageCache = storage !== undefined && storage !== resolvedStorage ? storage : undefined;

	/** Release the owned cache registration, if any. Idempotent — dispose is. */
	const releaseStorageCache = async (): Promise<void> => {
		if (ownedStorageCache) {
			await disposeStorageCache(ownedStorageCache);
		}
	};

	// 1. Register crypto plugin (digest, sign, verify, etc.)
	await platform.registerCrypto(db);
	log('Registered crypto plugin');

	// 2. Register optimystic plugin with transactor defaults. On the local
	// transactor with persistent storage, hand the same instance to the plugin so
	// DML persists on the host backend (not in-memory).
	const pluginConfig: Record<string, unknown> = {
		default_transactor: resolvedTransactor,
		default_key_network: 'libp2p',
		default_network_name: networkName,
		enable_cache: enableCache,
	};
	if (resolvedTransactor === 'local' && storage) {
		pluginConfig.rawStorageFactory = () => storage;
	}
	// The plugin's published signature is `Record<string, SqlValue>` but it
	// also reads `rawStorageFactory` (a function reference) from the same map.
	// Cast through unknown rather than widen the public type.
	const pluginResult = optimysticPlugin(
		db,
		pluginConfig as unknown as Parameters<typeof optimysticPlugin>[1],
	) as unknown as OptimysticPluginResult;
	applyRegistrations(db, pluginResult);
	log('Registered optimystic vtables and functions');

	const { collectionFactory } = pluginResult;

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
		if (schema) {
			log('Applying sApp schema for strand %s', strandId);
			await db.exec(`
				declare schema App {
					${schema}
				}
				apply schema App;
			`);
			log('sApp schema applied');
		}
	} catch (err) {
		// Clean up resources if setup fails after partial initialization.
		await collectionFactory.shutdown();
		if (createdNode) {
			await createdNode.stop();
		}
		await releaseStorageCache();
		throw err;
	}

	// 8. Return result with hydrate counts + shutdown handler. `shutdown` tears
	// down the collection factory, and `collectionFactory.shutdown()` stops EVERY
	// node registered with it — including an injected one (registered via
	// `registerLibp2pNode`). So an injected node IS stopped on `shutdown`; the
	// `createdNode` guard below only avoids a redundant second `stop()` on a node
	// we created ourselves, it is not what spares an injected node. A caller that
	// needs an injected node to outlive `shutdown` must re-create it (cadre-core's
	// `StrandInstanceManager` instead re-stops it, which is idempotent).
	return {
		vtables: [],
		functions: [],
		collations: [],
		hydrated,
		transactor: resolvedTransactor,
		async shutdown() {
			log('Shutting down strand connection %s', strandId);
			await collectionFactory.shutdown();
			if (createdNode) {
				await createdNode.stop();
			}
			await releaseStorageCache();
			log('Strand connection %s shut down', strandId);
		},
	};
}
