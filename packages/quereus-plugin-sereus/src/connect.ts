import type { Database } from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import type { Libp2p } from '@libp2p/interface';
import type { StrandConnectionOptions, SereusPluginResult } from './types.js';
import { composeStrand } from './compose-strand.js';

/**
 * Connect a Quereus Database to a Sereus strand (Node).
 *
 * Thin adapter over the shared {@link composeStrand} composition, supplying the
 * Node platform seams: crypto via `@quereus/quereus`'s `registerPlugin`, and a
 * TCP libp2p node created (only when not injected) via `@optimystic/db-p2p`.
 */
export async function connectToStrand(
	db: Database,
	options: StrandConnectionOptions,
): Promise<SereusPluginResult> {
	return composeStrand(db, options, {
		async registerCrypto(database) {
			await registerPlugin(database, cryptoPlugin);
		},
		async createNode({ networkName, bootstrapNodes, fretProfile, port, storage }) {
			// Dynamically import to keep the module cross-platform friendly: this
			// pulls the Node-only `@optimystic/db-p2p` (TCP) entry, and is only
			// reached when actually creating a node (never for injected nodes).
			const { createLibp2pNode } = await import('@optimystic/db-p2p');
			return createLibp2pNode({
				port,
				bootstrapNodes,
				networkName,
				fretProfile,
				...(storage && { storage }),
			}) as Promise<Libp2p>;
		},
	});
}
