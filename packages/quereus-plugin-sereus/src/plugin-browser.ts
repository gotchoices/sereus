/**
 * Quereus plugin entry point for Sereus strand connections (browser/worker).
 *
 * This is the ESM-bundled counterpart to `./plugin`. Load via Quoomb-web's
 * plugin URL field or `plugins[].source` in `quoomb.config.json`. Defaults
 * storage to IndexedDB and uses WebSockets + circuit-relay transports.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { connectToStrandBrowser } from './connect-browser.js';
import { parseConfig } from './parse-config.js';
import type { SereusPluginResult } from './types.js';

export { parseConfig };

/**
 * Default export: Quereus plugin registration function (browser).
 *
 * Note: the `storage_path` setting is Node-only (it resolves to a filesystem
 * `FileRawStorage` in `./plugin`). The browser entry ignores it and defaults
 * storage to IndexedDB via `connectToStrandBrowser`.
 */
export default async function register(
	db: Database,
	config: Record<string, SqlValue> = {},
): Promise<SereusPluginResult> {
	const options = parseConfig(config);
	return connectToStrandBrowser(db, options);
}
