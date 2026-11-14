import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { signSchema } from '../src/schema-verification.js';
import type { SAppConfig } from '../src/types.js';

/** The one-table sApp schema the strand specs launch with. */
const NOTE_SCHEMA = 'table Note (Id text primary key);';
const VERSION = '1.0.0';
const SCHEMA_VERSION = 1;

/**
 * A self-consistent signed sApp config: a throwaway ed25519 key signs the schema and doubles
 * as the sApp id, so the config passes `requireSignedSchemas` if a caller turns it on. Every
 * call mints a fresh key, so no two configs share an id.
 *
 * `latencyHint: 'realtime'` turns hibernation off, for a spec that must never see an idle
 * timer fire mid-measurement. `schema` replaces the one-table default, signed the same way.
 */
export function signedSApp(opts: Pick<SAppConfig, 'latencyHint'> & { schema?: string } = {}): SAppConfig {
	const { schema = NOTE_SCHEMA, ...rest } = opts;
	const priv = generatePrivateKey('ed25519', 'base64url') as string;
	const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
	const signed = { version: VERSION, schemaVersion: SCHEMA_VERSION, schema };
	return { id: pub, ...signed, signature: signSchema(signed, priv), ...rest };
}
