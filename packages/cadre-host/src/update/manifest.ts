/**
 * Fetch + verify the signed update manifest.
 *
 * The manifest is a JSON envelope `{ manifest, sig }` where `sig` is a
 * detached Ed25519 signature of `canonicalJson(manifest)`. cadre-host only
 * trusts manifests whose signature matches the embedded release public key.
 *
 * Canonical serialization is a tiny local impl — depending on
 * `json-canonicalize` (or similar) for a single call site is overkill, and
 * the shape is fixed (`UpdateManifest`).
 */

import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import { ed25519FromRaw, getReleasePublicKey, getReleasePublicKeyBase64 } from './release-key.js';
import {
  UpdateErrorException,
  type SignedManifest,
  type UpdateManifest,
} from './types.js';

/** Default release-manifest URL. Overridable via env var on the caller. */
export const DEFAULT_MANIFEST_URL = 'https://releases.serfab.io/cadre-host/latest.json';

export interface FetchManifestOptions {
  url: string;
  fetcher?: typeof fetch;
  /** Per-attempt connect timeout in ms (default 5000). */
  connectTimeoutMs?: number;
  /** Total read timeout in ms (default 10000). */
  readTimeoutMs?: number;
}

/**
 * Fetch the manifest endpoint and validate the signature against the embedded
 * release public key (or `CADRE_HOST_UPDATE_DEV_KEY` if set).
 *
 * Throws `UpdateErrorException` on any failure (bad JSON, bad signature,
 * etc.). Network errors are *thrown* — the caller decides whether to log
 * them at debug (the cadence path) or surface them (the apply path).
 */
export async function fetchManifest(opts: FetchManifestOptions): Promise<UpdateManifest> {
  const fetcher = opts.fetcher ?? fetch;
  const readTimeout = opts.readTimeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readTimeout);
  let response: Response;
  try {
    response = await fetcher(opts.url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`manifest endpoint returned ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new UpdateErrorException(
      'manifest_invalid',
      `manifest is not valid JSON: ${(err as Error).message}`,
    );
  }
  return verifyManifest(body);
}

/**
 * Verify a parsed signed-manifest body. Pure (no network), so unit tests
 * exercise this directly.
 */
export function verifyManifest(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): UpdateManifest {
  if (!isSignedManifest(body)) {
    throw new UpdateErrorException('manifest_invalid', 'manifest envelope is malformed');
  }
  if (!isUpdateManifest(body.manifest)) {
    throw new UpdateErrorException('manifest_invalid', 'manifest payload is missing required fields');
  }

  const sig = parseSignature(body.sig);
  const canonical = Buffer.from(canonicalJson(body.manifest), 'utf8');
  const key = getReleasePublicKey(env);

  let ok: boolean;
  try {
    ok = cryptoVerify(null, canonical, key, sig);
  } catch (err) {
    throw new UpdateErrorException(
      'signature_invalid',
      `signature verification threw: ${(err as Error).message}`,
    );
  }
  if (!ok) {
    throw new UpdateErrorException('signature_invalid', 'manifest signature did not verify');
  }
  return body.manifest;
}

/** Exposed for test signers. */
export function signManifestForTesting(manifest: UpdateManifest, privateKey: KeyObject): SignedManifest {
  const canonical = Buffer.from(canonicalJson(manifest), 'utf8');
  const sig = cryptoSign(null, canonical, privateKey).toString('base64');
  return { manifest, sig: `ed25519:${sig}` };
}

/** Used by `apply.ts` to detect which key the signer matches. */
export function publicKeyMatchesEmbedded(rawBase64: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return rawBase64 === getReleasePublicKeyBase64(env);
}

/** Wrapper for `getReleasePublicKey`, re-exported for parity with `ed25519FromRaw`. */
export { ed25519FromRaw };

/** ---- internals ---- */

function parseSignature(sig: string): Buffer {
  const match = /^ed25519:(.+)$/.exec(sig);
  if (!match) {
    throw new UpdateErrorException('signature_invalid', `unsupported signature scheme: ${sig.slice(0, 16)}…`);
  }
  const decoded = Buffer.from(match[1]!, 'base64');
  if (decoded.length !== 64) {
    throw new UpdateErrorException('signature_invalid', `Ed25519 signature must be 64 bytes, got ${decoded.length}`);
  }
  return decoded;
}

function isSignedManifest(v: unknown): v is SignedManifest {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.sig === 'string' && obj.manifest !== undefined && typeof obj.manifest === 'object';
}

function isUpdateManifest(v: unknown): v is UpdateManifest {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (typeof o.version !== 'string' || o.version.length === 0) return false;
  if (typeof o.publishedAt !== 'string') return false;
  if (!o.channels || typeof o.channels !== 'object') return false;
  const npm = (o.channels as Record<string, unknown>).npm as Record<string, unknown> | undefined;
  if (!npm || typeof npm.package !== 'string' || typeof npm.tag !== 'string') return false;
  if (o.releaseNotesUrl !== undefined && typeof o.releaseNotesUrl !== 'string') return false;
  if (o.minPreviousVersion !== undefined && typeof o.minPreviousVersion !== 'string') return false;
  return true;
}

/**
 * Canonical JSON: recursively sort object keys, no whitespace, no trailing
 * newline. Matches a typical RFC 8785 subset for the fixed shape we sign.
 * Arrays preserve order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cannot serialize non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  throw new Error(`cannot serialize value of type ${typeof value}`);
}
