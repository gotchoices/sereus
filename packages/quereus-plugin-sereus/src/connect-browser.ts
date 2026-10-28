import type { Database, VTablePluginInfo, FunctionPluginInfo, CollationPluginInfo } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { IndexedDBKVStore, IndexedDBRawStorage, openOptimysticWebDb, type OptimysticWebDBHandle } from '@optimystic/db-p2p-storage-web';
import type { Libp2p } from '@libp2p/interface';
import type { StrandConnectionOptions, SereusPluginResult } from './types.js';
import { composeStrand, applyRegistrations } from './compose-strand.js';

/** The subset of the crypto plugin result we register inline in the browser. */
interface CryptoPluginResult {
	vtables: VTablePluginInfo[];
	functions: FunctionPluginInfo[];
	collations: CollationPluginInfo[];
}

/**
 * Connect a Quereus Database to a Sereus strand from a browser/worker.
 *
 * Thin adapter over the shared {@link composeStrand} composition, supplying the
 * browser platform seams:
 *  - crypto registered inline (no runtime `@quereus/quereus` import, so the
 *    bundle does not duplicate the host's instance),
 *  - storage defaulting to `IndexedDBRawStorage` keyed by `sereus-strand-<id>`,
 *  - with `offline` given and no `journal`, the offline queue journaled into that same
 *    IndexedDB database (its `kv` object store) when the storage was defaulted,
 *  - a node created via the TCP-free `@optimystic/db-p2p/rn` entry with explicit
 *    `webSockets()` + `circuitRelayTransport()` transports.
 */
export async function connectToStrandBrowser(
	db: Database,
	options: StrandConnectionOptions,
): Promise<SereusPluginResult> {
	// The IndexedDB database the storage was defaulted to, if it was; the offline journal shares it.
	let defaultedDb: OptimysticWebDBHandle | undefined;
	return composeStrand(db, options, {
		registerCrypto(database) {
			applyRegistrations(database, cryptoPlugin(database, {}) as unknown as CryptoPluginResult);
		},
		async resolveStorage({ strandId, resolvedTransactor, requestedStorage }) {
			if (requestedStorage) return requestedStorage;
			// Browsers always default to IndexedDB so a reload survives; the
			// unit-test fake transactor needs no storage.
			if (resolvedTransactor === 'test') return undefined;
			defaultedDb = await openOptimysticWebDb(`sereus-strand-${strandId}`);
			return new IndexedDBRawStorage(defaultedDb);
		},
		defaultOfflineJournal() {
			return defaultedDb && new IndexedDBKVStore(defaultedDb);
		},
		async createNode({ networkName, bootstrapNodes, fretProfile, clusterSize, clusterPolicy, storage }) {
			return createLibp2pNode({
				transports: [webSockets(), circuitRelayTransport()],
				listenAddrs: [],
				bootstrapNodes,
				networkName,
				fretProfile,
				clusterSize,
				clusterPolicy,
				...(storage && { storage }),
			}) as Promise<Libp2p>;
		},
	});
}
