/**
 * Identity persistence for cadre-host.
 *
 * The host's libp2p peer identity is an Ed25519 keypair generated at
 * install time. The protobuf-encoded private key is written to
 * `<dataDir>/identity.key` with mode 0600 on POSIX. `cadre-host start`
 * later loads it with `privateKeyFromProtobuf`.
 *
 * We persist the protobuf form (not raw bytes) because that's the format
 * libp2p's `privateKeyFromProtobuf` consumes directly and it preserves the
 * key type tag — future migrations to a different key algorithm don't
 * require a schema change here.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';

export interface IdentityRecord {
  privateKey: PrivateKey;
  /** Stringified libp2p peer ID (`12D3Koo…`). */
  peerId: string;
}

/** Generate a fresh Ed25519 identity and persist it. Returns the in-memory record. */
export async function generateIdentity(filePath: string): Promise<IdentityRecord> {
  const privateKey = await generateKeyPair('Ed25519');
  const bytes = privateKeyToProtobuf(privateKey);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, bytes);
  // 0600 — owner read/write only. No-op on Windows.
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey).toString() };
}

/** Load an existing identity file. Throws if it doesn't decode. */
export function loadIdentity(filePath: string): IdentityRecord {
  const bytes = readFileSync(filePath);
  const privateKey = privateKeyFromProtobuf(new Uint8Array(bytes));
  return { privateKey, peerId: peerIdFromPrivateKey(privateKey).toString() };
}
