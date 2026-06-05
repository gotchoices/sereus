/**
 * Quereus plugin entry point for Sereus strand connections (Node).
 *
 * Loaded via Quoomb's `.plugin install` or config file, or via `registerPlugin()`.
 * Parses SqlValue config and delegates to `connectToStrand`.
 *
 * Browser/Worker consumers should load `./plugin-browser` instead, which uses
 * the TCP-free libp2p entry and IndexedDB-backed default storage.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { connectToStrand } from './connect.js';
import { parseConfig } from './parse-config.js';
import type { SereusPluginResult } from './types.js';

export { parseConfig };

/**
 * Default export: Quereus plugin registration function.
 */
export default async function register(
	db: Database,
	config: Record<string, SqlValue> = {},
): Promise<SereusPluginResult> {
	const options = parseConfig(config);

	// `storage_path` is a Node-only loader convenience: a `Record<string, SqlValue>`
	// cannot carry an `IRawStorage`, so the path is resolved to a concrete
	// `FileRawStorage` here (not in the platform-agnostic `parseConfig`). The
	// dynamic import keeps `@optimystic/db-p2p-storage-fs` (and its `node:fs`
	// dependency) out of the browser/RN module graph.
	const storagePath = config.storage_path;
	if (typeof storagePath === 'string' && storagePath) {
		const { FileRawStorage } = await import('@optimystic/db-p2p-storage-fs');
		options.storage = new FileRawStorage(storagePath);
	}

	return connectToStrand(db, options);
}
