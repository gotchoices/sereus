import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { PrivateKey } from '@libp2p/interface';

/**
 * An Ed25519 keypair expressed in the base64url form that
 * `@optimystic/quereus-plugin-crypto` (`sign`/`verify`/`getPublicKey`) consumes.
 * Generic bridge type — reused for owner keys, member keys, and any other
 * seed→public keypair the control/strand databases sign with.
 */
export interface Ed25519KeyPair {
  /** 32-byte Ed25519 seed, base64url-encoded — the crypto-plugin private key. */
  privateKeyB64: string;
  /** 32-byte Ed25519 public key, base64url-encoded. */
  publicKeyB64: string;
}

/**
 * Bridge a libp2p Ed25519 private key into the base64url keypair used by the
 * control- and strand-database signing constraints.
 *
 * libp2p stores an Ed25519 private key as 64 raw bytes: the first 32 are the
 * seed (the actual scalar source), the last 32 are the public key — see
 * `@libp2p/crypto`'s `Ed25519PrivateKey`. `@optimystic/quereus-plugin-crypto`
 * (via `@noble/curves`) treats the 32-byte seed *as* the private key and
 * derives the public key from it with standard Ed25519. The two derivations
 * agree, so the node's peer identity and its signing key are one keypair:
 * `getPublicKey(privateKeyB64)` === `publicKeyB64`.
 *
 * @param privateKey - The node's libp2p Ed25519 private key.
 * @returns The base64url seed/public-key pair for signing operations.
 * @throws If the key is not Ed25519 or the raw bytes aren't the expected length.
 */
export function ed25519KeyPairFromLibp2p(privateKey: PrivateKey): Ed25519KeyPair {
  if (privateKey.type !== 'Ed25519') {
    throw new Error(`ed25519KeyPairFromLibp2p requires an Ed25519 key, got ${privateKey.type}`);
  }

  const raw = privateKey.raw;
  if (raw.length !== 64) {
    throw new Error(`Expected a 64-byte Ed25519 raw private key (seed||public), got ${raw.length} bytes`);
  }

  const seed = raw.subarray(0, 32);
  const publicKeyRaw = privateKey.publicKey.raw;
  if (publicKeyRaw.length !== 32) {
    throw new Error(`Expected a 32-byte Ed25519 public key, got ${publicKeyRaw.length} bytes`);
  }

  return {
    privateKeyB64: uint8ArrayToString(seed, 'base64url'),
    publicKeyB64: uint8ArrayToString(publicKeyRaw, 'base64url'),
  };
}

/**
 * Derive the base64url Ed25519 public key from a base64url 32-byte private seed
 * — the same derivation the seed-bootstrap signer uses internally
 * (`SeedBootstrapService` constructor). Use this to enroll a standalone
 * (non-libp2p) key into the control DB before minting an invite, when the
 * key is *not* the node's peer identity (so `ed25519KeyPairFromLibp2p`,
 * which needs a libp2p key object, does not apply).
 *
 * @param privateKeyB64 - The base64url-encoded 32-byte Ed25519 seed.
 * @returns The base64url-encoded Ed25519 public key.
 */
export function ed25519PublicKeyFromPrivate(privateKeyB64: string): string {
  return getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
}

/** Longest rejected key value echoed back in an error — a real key is 43 base64url chars. */
const REJECTED_VALUE_ECHO_LIMIT = 64;

/**
 * Render a rejected value for an error message, capped: owner keys now reach this check
 * from remote-supplied fields (a `CadreInvite`'s `ownerKeys`, a donation request's
 * `ownerKeys`), so an unbounded echo would let a peer turn one junk string into a
 * megabyte of log line.
 */
function describeRejected(value: string): string {
  return value.length <= REJECTED_VALUE_ECHO_LIMIT
    ? value
    : `${value.slice(0, REJECTED_VALUE_ECHO_LIMIT)}… (${value.length} chars)`;
}

/**
 * Reject a value that isn't shaped like a base64url-encoded 32-byte Ed25519 public key
 * before it reaches the control database, where a malformed key would otherwise sit
 * indistinguishable from a real one until some later, unrelated signature check fails.
 *
 * Trims first, reusing the blank-value message for an empty result so that case keeps its
 * existing wording instead of a confusing base64url error. Every rejection names the offending
 * value (capped, see {@link describeRejected}) — with several keys in one batch, the message is
 * the only thing that says WHICH one. Does not check the decoded bytes
 * are a valid point on the Ed25519 curve — a well-formed-but-off-curve key still fails
 * signature verification later exactly like any other wrong key.
 *
 * **This rule is restated once outside this package**, in `validateOwnerKey`
 * (`packages/cadre-provider/src/server/routes.ts`): cadre-provider declares no
 * `workspace:` dependencies and validates `POST /containers` pins over `uint8arrays`
 * directly. Change the rule here and change it there. `create-container-owner-keys.test.ts`
 * asserts the same accept/reject table as `test/ed25519-key.spec.ts`, so a divergence
 * fails a test rather than passing silently.
 *
 * @param value - Candidate base64url-encoded Ed25519 public key.
 * @param label - Human-readable name of the field, used in error messages.
 * @returns The trimmed value, so callers write the same bytes they validated.
 */
export function requireEd25519PublicKeyB64(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`A ${label} is required (received an empty or whitespace-only value)`);
  }

  let decoded: Uint8Array;
  try {
    decoded = uint8ArrayFromString(trimmed, 'base64url');
  } catch (error) {
    throw new Error(
      `A ${label} must be a base64url-encoded Ed25519 public key (could not decode "${describeRejected(trimmed)}" as base64url)`,
      { cause: error },
    );
  }

  if (decoded.length !== 32) {
    throw new Error(
      `A ${label} must be a base64url-encoded 32-byte Ed25519 public key ("${describeRejected(trimmed)}" decoded to ${decoded.length} bytes)`,
    );
  }

  return trimmed;
}
