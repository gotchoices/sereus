/**
 * Typed signing core for the release-manifest pipeline.
 *
 * The offline `.mjs` CLI wrappers (`scripts/sign-manifest.mjs`) stay thin by
 * delegating manifest construction, field validation, and the sign + self-verify
 * round-trip to this module — keeping the logic typed and unit-testable instead
 * of hand-rolled in a script. None of this ships in the running binary's hot
 * path: it is only reached by the operator's offline signing tool (and tests).
 */

import { createPublicKey, type KeyObject } from 'node:crypto';

import { signManifest, validateManifestFields, verifyManifest } from './manifest.js';
import type { SignedManifest, UpdateManifest } from './types.js';

/** Flat input shape the signing CLI collects from flags or a JSON file. */
export interface ManifestFields {
  /** Released version (semver). */
  version: string;
  /** npm package the release publishes under. */
  package: string;
  /** npm dist-tag (e.g. `latest`). */
  tag: string;
  /** ISO-8601 publish timestamp (must round-trip exactly). */
  publishedAt: string;
  /** Optional human-facing release-notes URL. */
  releaseNotesUrl?: string;
  /** Optional minimum previous version that can step directly to this release. */
  minPreviousVersion?: string;
}

/**
 * Construct a well-formed `UpdateManifest` from flat fields and run the exact
 * `validateManifestFields` rules `verifyManifest` will later apply — so the
 * signing tool fails loudly on a bad semver / npm name / non-ISO timestamp
 * rather than emitting a manifest the verifier would reject as `manifest_invalid`.
 */
export function buildManifest(fields: ManifestFields): UpdateManifest {
  const manifest: UpdateManifest = {
    v: 1,
    version: fields.version,
    publishedAt: fields.publishedAt,
    channels: { npm: { package: fields.package, tag: fields.tag } },
    ...(fields.releaseNotesUrl !== undefined ? { releaseNotesUrl: fields.releaseNotesUrl } : {}),
    ...(fields.minPreviousVersion !== undefined ? { minPreviousVersion: fields.minPreviousVersion } : {}),
  };
  validateManifestFields(manifest);
  return manifest;
}

/**
 * Derive the raw 32-byte Ed25519 public key (base64) from a private key by
 * stripping the 12-byte SPKI DER header — the same form `release-key.ts`
 * embeds and `ed25519FromRaw` consumes.
 */
export function derivePublicKeyBase64(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(12)).toString('base64');
}

/**
 * Sign a manifest and immediately verify the result against the public key
 * *derived from the same private key*, independent of whatever key the running
 * environment trusts. Throws if the self-check fails, so the signing tool never
 * emits an envelope it could not itself verify.
 */
export function signAndSelfVerify(manifest: UpdateManifest, privateKey: KeyObject): SignedManifest {
  const signed = signManifest(manifest, privateKey);
  const publicRawB64 = derivePublicKeyBase64(privateKey);
  // verifyManifest honors the env override; point it at the derived key only so
  // the self-check is against this key pair, not the embedded/dev key.
  verifyManifest(signed, { CADRE_HOST_UPDATE_DEV_KEY: publicRawB64 } as NodeJS.ProcessEnv);
  return signed;
}
