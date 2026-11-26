import type { Database, VTablePluginInfo, FunctionPluginInfo, CollationPluginInfo } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import { createLibp2pNode } from '@optimystic/db-p2p/rn';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { indexedDbNodeStorage, openOptimysticWebDb } from '@optimystic/db-p2p-storage-web';
import type { OpenNodeStorage } from '@optimystic/db-p2p';
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
 *  - storage defaulting to `indexedDbNodeStorage` over a database keyed by `sereus-strand-<id>`,
 *  - with `offline` given and no `journal`, the offline queue journaled into that storage's own
 *    key-value store when the storage was defaulted,
 *  - a node created via the TCP-free `@optimystic/db-p2p/rn` entry with explicit
 *    `webSockets()` + `circuitRelayTransport()` transports.
 */
export async function connectToStrandBrowser(
	db: Database,
	options: StrandConnectionOptions,
): Promise<SereusPluginResult> {
	// The storage this entry point opened itself, if it did; the offline journal shares its `kv`.
	let defaulted: OpenNodeStorage | undefined;
	return composeStrand(db, options, {
		registerCrypto(database) {
			applyRegistrations(database, cryptoPlugin(database, {}) as unknown as CryptoPluginResult);
		},
		async resolveStorage({ strandId, resolvedTransactor, requestedStorage }) {
			if (requestedStorage) return requestedStorage;
			// Browsers always default to IndexedDB so a reload survives; the
			// unit-test fake transactor needs no storage.
			if (resolvedTransactor === 'test') return undefined;
			// NOTE: neither this storage nor the IndexedDB handle under it is ever closed, because
			// `StrandPlatform` has no shutdown seam to close them through — exactly as before this entry
			// point opened all three stores rather than one, and with the same consequence: a store that
			// holds writes in memory until its idle flush is never asked to commit what it still holds,
			// so an abrupt tab close can lose the most recent ones. If a browser host ever needs that
			// flush, or reports a database it cannot delete while the tab lives, give `StrandPlatform` a
			// release hook and call it from `composeStrand`'s `shutdown`.
			const handle = await openOptimysticWebDb(`sereus-strand-${strandId}`);
			defaulted = indexedDbNodeStorage(handle);
			return defaulted;
		},
		/**
		 * The node's own key-value store, not a second one over the same handle. Upstream declares the
		 * journal's key prefix (`OFFLINE_JOURNAL_KEY_PREFIX`) in `NODE_KV_NAMESPACES` precisely so one
		 * store can serve both, and two stores over one handle would not see each other's unflushed
		 * writes.
		 */
		defaultOfflineJournal() {
			return defaulted?.kv;
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
