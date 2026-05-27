import { toString as uint8ArrayToString } from 'uint8arrays';
import type { PrivateKey } from '@libp2p/interface';

/**
 * A household authority keypair expressed in the base64url Ed25519 form that
 * `@optimystic/quereus-plugin-crypto` (`sign`/`verify`/`getPublicKey`) consumes.
 */
export interface AuthorityKeyPair {
  /** 32-byte Ed25519 seed, base64url-encoded — the crypto-plugin private key. */
  privateKeyB64: string;
  /** 32-byte Ed25519 public key, base64url-encoded. */
  publicKeyB64: string;
}

/**
 * Bridge a libp2p Ed25519 private key into the base64url keypair used by the
 * control-database authority constraints.
 *
 * libp2p stores an Ed25519 private key as 64 raw bytes: the first 32 are the
 * seed (the actual scalar source), the last 32 are the public key — see
 * `@libp2p/crypto`'s `Ed25519PrivateKey`. `@optimystic/quereus-plugin-crypto`
 * (via `@noble/curves`) treats the 32-byte seed *as* the private key and
 * derives the public key from it with standard Ed25519. The two derivations
 * agree, so the node's peer identity and its authority key are one keypair:
 * `getPublicKey(privateKeyB64)` === `publicKeyB64`.
 *
 * @param privateKey - The node's libp2p Ed25519 private key.
 * @returns The base64url seed/public-key pair for authority operations.
 * @throws If the key is not Ed25519 or the raw bytes aren't the expected length.
 */
export function authorityKeyFromLibp2p(privateKey: PrivateKey): AuthorityKeyPair {
  if (privateKey.type !== 'Ed25519') {
    throw new Error(`authorityKeyFromLibp2p requires an Ed25519 key, got ${privateKey.type}`);
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
