import debug from 'debug';
import type { Database} from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandConnectionOptions, SereusPluginResult, Libp2pNodeWithRepo } from './types.js';

const log = debug('sereus:plugin:strand');

/**
 * Minimal interface for the CollectionFactory returned by the optimystic plugin.
 */
interface CollectionFactory {
	registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void;
	shutdown(): Promise<void>;
}

/** Result of the optimystic plugin registration */
interface OptimysticPluginResult {
	collectionFactory: CollectionFactory;
	vtables: Array<{ name: string; module: unknown; auxData: unknown }>;
	functions: Array<{ schema: unknown }>;
	[key: string]: unknown;
}

/**
 * Connect a Quereus Database to a Sereus strand.
 *
 * Composes the crypto and optimystic plugins, creates or uses a libp2p node,
 * and optionally applies a sApp schema.
 */
export async function connectToStrand(
	db: Database,
	options: StrandConnectionOptions,
): Promise<SereusPluginResult> {
	const {
		strandId,
		bootstrapNodes = [],
		schema,
		sAppId: _sAppId = 'unknown',
		sAppVersion: _sAppVersion = '1.0.0',
		port = 0,
		enableCache = true,
		fretProfile = 'edge',
		mode,
		storage,
	} = options;

	// Resolve the transactor. `mode` is the public knob: bootstrap -> local,
	// networked -> network. The legacy `transactor` override (used by unit
	// tests with `'test'`) only applies when `mode` is unspecified.
	let resolvedTransactor: string;
	if (mode !== undefined) {
		resolvedTransactor = mode === 'bootstrap' ? 'local' : 'network';
	} else if (options.transactor !== undefined) {
		resolvedTransactor = options.transactor;
	} else {
		resolvedTransactor = 'network';
	}

	const networkName = `strand-${strandId}`;
	log('Connecting to strand %s (network: %s, mode=%s, transactor=%s)',
		strandId, networkName, mode ?? '(default)', resolvedTransactor);

	// 1. Register crypto plugin (digest, sign, verify, etc.)
	await registerPlugin(db, cryptoPlugin);
	log('Registered crypto plugin');

	// 2. Register optimystic plugin with transactor defaults. In bootstrap mode
	// with persistent storage, hand the same instance to the plugin so the local
	// transactor persists DML on the host backend (not in-memory).
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
	) as OptimysticPluginResult;

	// 3. Register vtables and functions from the optimystic result
	for (const vtable of pluginResult.vtables) {
		db.registerModule(vtable.name, vtable.module as any, vtable.auxData);
	}
	for (const func of pluginResult.functions) {
		db.registerFunction(func.schema as any);
	}
	log('Registered optimystic vtables and functions');

	const { collectionFactory } = pluginResult;

	// 4. Create or use injected libp2p node. Skip only when this is the unit-test
	// fake transactor — every real path (network, local bootstrap) needs a node.
	let createdNode: Libp2p | null = null;

	try {
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
				// Dynamically import to keep the module cross-platform friendly
				const { createLibp2pNode } = await import('@optimystic/db-p2p');
				const created = await createLibp2pNode({
					port,
					bootstrapNodes,
					networkName,
					fretProfile,
					...(storage && { storage }),
				});
				createdNode = created;
				node = created;
				coordinatedRepo = (created as Libp2pNodeWithRepo).coordinatedRepo;
				if (!coordinatedRepo) {
					throw new Error('coordinatedRepo not available on created libp2p node');
				}
				log('Created libp2p node (port: %d, fretProfile: %s, storage=%s)',
					port, fretProfile, !!storage);
			}

			// 5. Register the node with the collection factory
			collectionFactory.registerLibp2pNode(networkName, node, coordinatedRepo);
			log('Registered libp2p node with collection factory');
		}

		// 6. Set optimystic as default vtab so `declare schema` tables use it
		db.setDefaultVtabName('optimystic');
		db.setDefaultVtabArgs({
			networkName,
			transactor: resolvedTransactor,
			keyNetwork: 'libp2p',
		});
		log('Set default vtab to optimystic (networkName=%s, transactor=%s)', networkName, resolvedTransactor);

		// 7. Apply sApp schema if provided
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
		// Clean up resources if setup fails after partial initialization
		await collectionFactory.shutdown();
		if (createdNode) {
			await createdNode.stop();
		}
		throw err;
	}

	// 8. Return result with shutdown handler
	return {
		vtables: [],
		functions: [],
		collations: [],
		async shutdown() {
			log('Shutting down strand connection %s', strandId);
			await collectionFactory.shutdown();
			if (createdNode) {
				await createdNode.stop();
			}
			log('Strand connection %s shut down', strandId);
		},
	};
}
