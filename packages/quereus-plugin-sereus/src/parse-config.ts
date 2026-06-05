import type { SqlValue } from '@quereus/quereus';
import type { StrandConnectionOptions } from './types.js';

/**
 * Parse the plugin-loader SqlValue config into typed StrandConnectionOptions.
 * Shared by the Node (`plugin.ts`) and browser (`plugin-browser.ts`) entries.
 */
export function parseConfig(config: Record<string, SqlValue>): StrandConnectionOptions {
	const strandId = config.strand_id;
	if (typeof strandId !== 'string' || !strandId) {
		throw new Error('quereus-plugin-sereus: strand_id is required');
	}

	const bootstrapNodesRaw = config.bootstrap_nodes;
	const bootstrapNodes = typeof bootstrapNodesRaw === 'string' && bootstrapNodesRaw
		? bootstrapNodesRaw.split(',').map(s => s.trim()).filter(Boolean)
		: [];

	const schema = typeof config.schema === 'string' ? config.schema : undefined;
	const sAppId = typeof config.sapp_id === 'string' ? config.sapp_id : 'unknown';
	const sAppVersion = typeof config.sapp_version === 'string' ? config.sapp_version : '1.0.0';
	const port = typeof config.port === 'number' ? config.port : 0;
	const enableCache = config.enable_cache !== false && config.enable_cache !== 0;
	const fretProfile = config.fret_profile === 'core' ? 'core' as const : 'edge' as const;

	// Lifecycle mode: selects bootstrap (local transactor) vs networked. Only the
	// two known values are honored; anything else falls through to the default.
	const mode = config.mode === 'bootstrap' || config.mode === 'networked'
		? config.mode
		: undefined;

	// Internal transactor override (e.g. `'test'`). Applies only when `mode` is
	// unset — see `StrandConnectionOptions.transactor`.
	const transactor = typeof config.transactor === 'string' && config.transactor
		? config.transactor
		: undefined;

	// NOTE: persistent storage cannot ride a `Record<string, SqlValue>` — an
	// `IRawStorage` is not an `SqlValue`. The Node loader (`plugin.ts`) reads the
	// platform-only `storage_path` key directly and resolves it to a concrete
	// `FileRawStorage`; it is intentionally NOT parsed into the typed options here.

	return {
		strandId,
		bootstrapNodes,
		schema,
		sAppId,
		sAppVersion,
		port,
		enableCache,
		fretProfile,
		...(mode && { mode }),
		...(transactor && { transactor }),
	};
}
