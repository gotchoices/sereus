import debug from 'debug';
import { digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import type { SAppConfig } from './types.js';

const log = debug('sereus:cadre:schema-verify');

/**
 * Error thrown when sApp schema signature verification fails.
 */
export class SchemaVerificationError extends Error {
  constructor(
    public readonly sAppId: string,
    public readonly version: string,
    reason: string
  ) {
    super(`sApp schema verification failed for ${sAppId} v${version}: ${reason}`);
    this.name = 'SchemaVerificationError';
  }
}

/**
 * Compute the canonical digest of a schema + version for signing/verification.
 * The payload is deterministic JSON: `{"schema":"...","version":"..."}`.
 */
function schemaDigest(schema: string, version: string): string {
  const payload = JSON.stringify({ schema, version });
  return digest(payload, 'sha256', 'utf8', 'base64url') as string;
}

/**
 * Sign an sApp schema with the author's ed25519 private key.
 * Used by sApp authors when publishing their schema.
 *
 * @param schema - The declarative schema DDL
 * @param version - Schema version string
 * @param authorPrivateKey - Author's ed25519 private key (base64url)
 * @returns Signature (base64url)
 */
export function signSchema(schema: string, version: string, authorPrivateKey: string): string {
  const d = schemaDigest(schema, version);
  return sign(d, authorPrivateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
}

/**
 * Verify an sApp schema signature against the author's ed25519 public key.
 *
 * @param schema - The declarative schema DDL
 * @param version - Schema version string
 * @param signature - Signature to verify (base64url)
 * @param authorPublicKey - Author's ed25519 public key (base64url)
 * @returns true if the signature is valid
 */
export function verifySchema(schema: string, version: string, signature: string, authorPublicKey: string): boolean {
  try {
    const d = schemaDigest(schema, version);
    return verify(d, signature, authorPublicKey, 'ed25519', 'base64url', 'base64url', 'base64url');
  } catch (error) {
    log('Schema verification error: %o', error);
    return false;
  }
}

/**
 * Assert that an SAppConfig has a valid schema signature.
 * Throws SchemaVerificationError on failure.
 *
 * Fail-closed by default: when `options.requireSignature` is not explicitly
 * `false`, an absent signature is rejected with reason `'missing signature'`,
 * distinct from the `'invalid signature'` (tampered/wrong-key) case. The
 * relaxation (`requireSignature: false`) only excuses *absence* of a signature;
 * a present-but-bad signature still throws.
 *
 * @param sAppConfig - The sApp configuration to verify
 * @param options - Verification policy; `requireSignature` defaults to `true`
 * @throws SchemaVerificationError if the signature is missing (when required) or invalid
 */
export function assertSchemaSignature(
  sAppConfig: SAppConfig,
  options?: { requireSignature?: boolean }
): void {
  const { id, version, schema, signature } = sAppConfig;
  const requireSignature = options?.requireSignature ?? true;

  if (!signature) {
    if (requireSignature) {
      throw new SchemaVerificationError(id ?? '', version, 'missing signature');
    }
    log('No signature provided for %s v%s — skipping verification (policy relaxed)', id, version);
    return;
  }

  if (!id) {
    throw new SchemaVerificationError(id ?? '', version, 'missing author public key');
  }

  if (!verifySchema(schema, version, signature, id)) {
    throw new SchemaVerificationError(id, version, 'invalid signature');
  }
}
