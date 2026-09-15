import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { signSchema } from '../src/schema-verification.js';
import type { SAppConfig } from '../src/types.js';

/** The one-table sApp schema the strand specs launch with. */
const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

/**
 * A self-consistent signed sApp config: a throwaway ed25519 key signs the schema and doubles
 * as the sApp id, so the config passes `requireSignedSchemas` if a caller turns it on. Every
 * call mints a fresh key, so no two configs share an id.
 *
 * `latencyHint: 'realtime'` turns hibernation off, for a spec that must never see an idle
 * timer fire mid-measurement.
 */
export function signedSApp(opts: Pick<SAppConfig, 'latencyHint'> = {}): SAppConfig {
	const priv = generatePrivateKey('ed25519', 'base64url') as string;
	const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
	return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv), ...opts };
}
