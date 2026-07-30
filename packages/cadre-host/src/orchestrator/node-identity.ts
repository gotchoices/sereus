/**
 * Per-node identity keys for orchestrator-managed children.
 *
 * A donated node joins a *foreign* cadre: the requester approves its peer id
 * and its seed nominates dial addresses keyed to that peer id. Both bind to the
 * identity, so a node that generated a fresh libp2p keypair per process would
 * become a stranger to the cadre that admitted it on every restart. It also
 * needs a stable on-disk home for its node-local stores — `cadre-cli start`
 * opens `FileBootstrapPeerStore` / `FileTrustedOwnerStore` only when a protobuf
 * identity key file is configured.
 *
 * So every managed node gets its own `identity.key` inside its workdir, written
 * once and reused thereafter. The workdir is removed when the loan is
 * terminated (`removeContainer`), so nothing the node persisted outlives it.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { generateIdentity, loadIdentity, type IdentityRecord } from '../installer/identity.js';

const IDENTITY_FILE = 'identity.key';

/** Path to a managed node's own protobuf identity key inside its workdir. */
export function nodeIdentityPath(workdir: string): string {
  return join(workdir, IDENTITY_FILE);
}

/**
 * Ensure `<workdir>/identity.key` exists, generating an Ed25519 protobuf key on
 * first call and REUSING it on every later call. Reuse is the load-bearing
 * property: a re-spawn of the same container must land on the same peer id.
 */
export async function ensureNodeIdentity(workdir: string): Promise<{ path: string; peerId: string }> {
  const path = nodeIdentityPath(workdir);
  const record: IdentityRecord = existsSync(path)
    ? loadIdentity(path)
    : await generateIdentity(path);
  return { path, peerId: record.peerId };
}
