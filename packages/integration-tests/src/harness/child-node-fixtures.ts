/**
 * Fixtures for scenarios that drive real `cadre-cli` CHILD PROCESSES (via
 * `HostProcessOrchestrator` / `ProviderProcessOrchestrator`) rather than
 * in-process `CadreNode`s — the installer-style identity file a child is
 * launched with, the bootstrap multiaddrs it is handed, and the node-local
 * stores it writes into its volume.
 *
 * Distinct from `node-fixtures.ts`, which builds `CadreNode` instances in this
 * process.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';

/** Write the installer-style protobuf identity.key and return the libp2p key. */
export async function writeIdentity(path: string): Promise<{ key: PrivateKey; peerId: string }> {
  const key = await generateKeyPair('Ed25519');
  writeFileSync(path, privateKeyToProtobuf(key));
  return { key, peerId: peerIdFromPrivateKey(key).toString() };
}

/** Ensure a control-bootstrap multiaddr carries the peer id needed to dial it. */
export function withPeerId(addr: string, peerId: string): string {
  return addr.includes('/p2p/') ? addr : `${addr}/p2p/${peerId}`;
}

/** A node-local store envelope as `@serfab/cadre-core` snapshot-writes it. */
export interface NodeLocalEnvelope {
  version: number;
  partyId: string;
  owners?: Record<string, unknown>;
  peers?: Record<string, unknown>;
}

/**
 * The single `<name>.<encoded party>.json` node-local store in `dir`, parsed —
 * or undefined while it has not been written yet. The party component is
 * filename-encoded by cadre-core, so match on the name prefix and check the
 * envelope's own `partyId` instead of rebuilding the encoding here.
 *
 * NOTE: takes the first prefix match; a child node serves exactly one party
 * today. If a workdir ever holds several parties' stores, select by encoded
 * party rather than by prefix.
 */
export function readNodeLocalStore(dir: string, name: string): NodeLocalEnvelope | undefined {
  const file = readdirSync(dir).find((f) => f.startsWith(`${name}.`) && f.endsWith('.json'));
  return file ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as NodeLocalEnvelope) : undefined;
}
