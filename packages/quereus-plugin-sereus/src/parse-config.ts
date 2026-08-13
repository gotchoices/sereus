import type { SqlValue } from '@quereus/quereus';
import type { StrandConnectionOptions, StrandTransactor } from './types.js';

const STRAND_TRANSACTORS: readonly StrandTransactor[] = ['local', 'network', 'test'];

/**
 * Read the optional `transactor` key. Unlike `fret_profile` (whose unknown
 * values fall back to the default), an unrecognised transactor throws: silently
 * running on the network when the caller asked for local storage is the kind of
 * mistake that only surfaces as a mysterious hang on a machine with no peers.
 */
function parseTransactor(raw: SqlValue): StrandTransactor | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw !== 'string' || !STRAND_TRANSACTORS.includes(raw as StrandTransactor)) {
		throw new Error(
			`quereus-plugin-sereus: transactor must be one of ${STRAND_TRANSACTORS.join(', ')} (got ${JSON.stringify(raw)})`,
		);
	}
	return raw as StrandTransactor;
}

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

	// Storage engine — see `StrandConnectionOptions.transactor`. Left out entirely
	// when unset so `composeStrand` applies its own default.
	const transactor = parseTransactor(config.transactor);

	// NOTE: `parseConfig` reads the keys it knows and ignores every other key in
	// the map — there is no allowlist, so a misspelled or retired setting (e.g.
	// the `mode` this package used to carry) is silently dropped rather than
	// rejected. Deliberate: the plugin loader hands through whatever the host's
	// settings file holds.

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
		...(transactor && { transactor }),
	};
}
