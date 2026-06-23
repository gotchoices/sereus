/**
 * Production Ed25519 public key used to verify the update manifest.
 *
 * The signing key lives offline with the release operator; only the public
 * half ever ships in the binary. The release operator generates the keypair
 * and embeds the public half with `scripts/release-keygen.mjs --write-source`;
 * see the "Release signing & key management" runbook in `docs/cadre-host.md`.
 * For dev/CI/staging overrides see `CADRE_HOST_UPDATE_DEV_KEY`.
 */

import type { KeyObject } from 'node:crypto';
import { createPublicKey } from 'node:crypto';

/**
 * Raw 32-byte Ed25519 public key, base64-encoded. The all-zeros value below is
 * the placeholder that ships in source until the release operator embeds a real
 * key (`isPlaceholderReleaseKey` reports it; the publish guard refuses to ship
 * it). Mismatch with the real signer surfaces as `signature_invalid`, which the
 * UI treats as "update available but unverifiable" rather than auto-applying.
 */
const PROD_KEY_BASE64 = 'XyRVnOY9DVgU6xdMgJIguOsc9B2L1o2KoU9626Nk+OE=';

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
 * True when the *effective* release key (after the `CADRE_HOST_UPDATE_DEV_KEY`
 * override) decodes to 32 zero bytes — i.e. the all-zeros placeholder that
 * ships in source until the release operator embeds a real public key.
 *
 * Consumers:
 *  - the publish guard (`scripts/publish-package.js`) refuses to ship a build
 *    whose embedded key is still the placeholder, so a real release can never
 *    silently ship the dead key;
 *  - `UpdateService.check()` logs a diagnostic breadcrumb so a misbuilt binary
 *    is recognizable from logs rather than only as opaque `signature_invalid`.
 */
export function isPlaceholderReleaseKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = Buffer.from(getReleasePublicKeyBase64(env), 'base64');
  if (raw.length !== 32) return false;
  return raw.every((b) => b === 0);
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
