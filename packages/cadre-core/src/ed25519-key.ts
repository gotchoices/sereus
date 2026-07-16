import { toString as uint8ArrayToString } from 'uint8arrays';
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
