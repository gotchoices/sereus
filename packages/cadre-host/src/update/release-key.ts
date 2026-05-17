/**
 * Production Ed25519 public key used to verify the update manifest.
 *
 * The signing key lives offline with the release operator; only the public
 * half ever ships in the binary.
 *
 * **Provisional key.** The placeholder below is regenerated whenever the
 * release tooling is rotated — the key in this file is replaced atomically
 * by the release build. CI keys differ from prod keys; for dev/CI overrides
 * see `CADRE_HOST_UPDATE_DEV_KEY`.
 */

import { createPublicKey, KeyObject } from 'node:crypto';

/**
 * Raw 32-byte Ed25519 public key, base64-encoded. Placeholder pending key
 * generation by the release op. Mismatch with the real signer will surface
 * as `signature_invalid`, which the UI treats as "update available but
 * unverifiable" rather than auto-applying.
 *
 * The real key generation/publication procedure is tracked in the
 * release-tooling backlog; until then, the dev override below is the only
 * supported path for CI + local manifest testing.
 */
const PROD_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/**
 * Public key (32 raw bytes, base64) — env override beats the embedded one.
 * Used by both production and CI smoke tests.
 */
export function getReleasePublicKeyBase64(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CADRE_HOST_UPDATE_DEV_KEY?.trim();
  if (override && override.length > 0) return override;
  return PROD_KEY_BASE64;
}

/** Lazily build the KeyObject used by `crypto.verify`. */
export function getReleasePublicKey(env: NodeJS.ProcessEnv = process.env): KeyObject {
  return ed25519FromRaw(getReleasePublicKeyBase64(env));
}

/**
 * Build an Ed25519 KeyObject from a raw 32-byte base64 public key by wrapping
 * it in the SubjectPublicKeyInfo DER prefix Node expects.
 */
export function ed25519FromRaw(base64Raw: string): KeyObject {
  const raw = Buffer.from(base64Raw, 'base64');
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  // SPKI DER prefix for Ed25519: 0x302a300506032b6570032100
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const spki = Buffer.concat([prefix, raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}
