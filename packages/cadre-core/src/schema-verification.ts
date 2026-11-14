import debug from 'debug';
import { digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import type { SAppConfig } from './types.js';

const log = debug('sereus:cadre:schema-verify');

/** The `SAppConfig` fields the author's signature covers. */
export type SignedSAppFields = Pick<SAppConfig, 'schema' | 'version' | 'schemaVersion'>;

/**
 * Error thrown when sApp schema signature verification fails.
 */
export class SchemaVerificationError extends Error {
  constructor(
    public readonly sAppId: string,
    public readonly version: string,
    schemaVersion: number,
    reason: string
  ) {
    super(`sApp schema verification failed for ${sAppId} v${version} (schema version ${String(schemaVersion)}): ${reason}`);
    this.name = 'SchemaVerificationError';
  }
}

/**
 * Compute the canonical digest of the signed sApp fields for signing/verification.
 * The payload is deterministic JSON, keys in this order:
 * `{"schema":"...","schemaVersion":N,"version":"..."}`.
 */
function schemaDigest({ schema, schemaVersion, version }: SignedSAppFields): string {
  const payload = JSON.stringify({ schema, schemaVersion, version });
  return digest([payload], 'sha256', 'base64url') as string;
}

/**
 * Sign an sApp schema, its release version and its schema version with the author's ed25519
 * private key. Used by sApp authors when publishing their schema.
 *
 * @param sApp - The declarative schema DDL, the release version string and the schema version
 * @param authorPrivateKey - Author's ed25519 private key (base64url)
 * @returns Signature (base64url)
 */
export function signSchema(sApp: SignedSAppFields, authorPrivateKey: string): string {
  return sign(schemaDigest(sApp), authorPrivateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
}

/**
 * Verify an sApp schema signature against the author's ed25519 public key.
 *
 * @param sApp - The declarative schema DDL, the release version string and the schema version
 * @param signature - Signature to verify (base64url)
 * @param authorPublicKey - Author's ed25519 public key (base64url)
 * @returns true if the signature is valid
 */
export function verifySchema(sApp: SignedSAppFields, signature: string, authorPublicKey: string): boolean {
  try {
    return verify(schemaDigest(sApp), signature, authorPublicKey, 'ed25519', 'base64url', 'base64url', 'base64url');
  } catch (error) {
    log('Schema verification error: %o', error);
    return false;
  }
}

/** A schema version is a positive safe integer; anything else could not be compared against a strand's. */
function isValidSchemaVersion(schemaVersion: unknown): boolean {
  return Number.isSafeInteger(schemaVersion) && (schemaVersion as number) >= 1;
}

/**
 * Assert that an SAppConfig has a valid schema signature.
 * Throws SchemaVerificationError on failure.
 *
 * A `schemaVersion` that is not a positive safe integer is refused with reason
 * `'invalid schemaVersion'` under either policy.
 *
 * Fail-closed by default: when `options.requireSignature` is not explicitly
 * `false`, an absent signature is rejected with reason `'missing signature'`,
 * distinct from the `'invalid signature'` (tampered/wrong-key) case. The
 * relaxation (`requireSignature: false`) only excuses *absence* of a signature;
 * a present-but-bad signature still throws.
 *
 * @param sAppConfig - The sApp configuration to verify
 * @param options - Verification policy; `requireSignature` defaults to `true`
 * @throws SchemaVerificationError if the schema version is malformed, or the signature is missing (when required) or invalid
 */
export function assertSchemaSignature(
  sAppConfig: SAppConfig,
  options?: { requireSignature?: boolean }
): void {
  const { id, version, schemaVersion, signature } = sAppConfig;
  const requireSignature = options?.requireSignature ?? true;
  const refuse = (reason: string): SchemaVerificationError =>
    new SchemaVerificationError(id ?? '', version, schemaVersion, reason);

  if (!isValidSchemaVersion(schemaVersion)) {
    throw refuse('invalid schemaVersion');
  }

  if (!signature) {
    if (requireSignature) {
      throw refuse('missing signature');
    }
    log('No signature provided for %s v%s — skipping verification (policy relaxed)', id, version);
    return;
  }

  if (!id) {
    throw refuse('missing author public key');
  }

  if (!verifySchema(sAppConfig, signature, id)) {
    throw refuse('invalid signature');
  }
}
