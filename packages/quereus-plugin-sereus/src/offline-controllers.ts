import type { Database } from '@quereus/quereus';
import type { StrandOfflineController } from './types.js';

/** The offline controller of each live strand composition composed with `offline`, by its `Database`. */
export const offlineControllers = new WeakMap<Database, StrandOfflineController>();

/**
 * The offline controller of the live strand composition over `db`, or `undefined` when it was
 * composed without `offline`, has shut down, or `db` is no strand composition. For Sereus's own
 * writers, which are handed a bare `Database` and must see whether its queue holds transactions.
 */
export function offlineControllerOf(db: Database): StrandOfflineController | undefined {
	return offlineControllers.get(db);
}
