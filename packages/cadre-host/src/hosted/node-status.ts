/**
 * Reading a hosted child's `/status` — the one window the host has onto a node it
 * runs: its peer id and addresses before the claim, and the claim itself, the party
 * and the owner key after it. Shared by `HostedNodeService.claimDetails` and the
 * status watcher.
 */

// The child's `/status` is typed against the CLI's own answer, so a field the CLI
// renames is a compile error here rather than a watcher that never sees a claim.
import type { HealthStatus } from '@serfab/cadre-cli';

import { HostedNodeError } from './types.js';

/** The party an unclaimed child's config names; the claim replaces it. */
export const PLACEHOLDER_PARTY = 'unclaimed';

/** The `/status` URL for a spawn's `/health` URL (same server and port). */
export function statusUrlFor(healthEndpoint: string): string {
  const url = new URL(healthEndpoint);
  url.pathname = '/status';
  return url.toString();
}

/** A `/status` answer from a node that has its peer identity. */
export type NodeStatus = HealthStatus & { peerId: string };

/**
 * The child's `/status`, fresh every call. Throws `node_unavailable` while the child
 * does not answer, answers with an error, or has no peer identity yet — every one of
 * which a caller retries.
 */
export async function readNodeStatus(statusEndpoint: string): Promise<NodeStatus> {
  let res: Response;
  try {
    res = await fetch(statusEndpoint);
  } catch (err) {
    throw new HostedNodeError('node_unavailable', `Hosted node unreachable: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    throw new HostedNodeError('node_unavailable', `Hosted node /status returned ${res.status}`);
  }
  let status: HealthStatus;
  try {
    status = (await res.json()) as HealthStatus;
  } catch (err) {
    throw new HostedNodeError('node_unavailable', `Hosted node /status is not JSON: ${errorMessage(err)}`);
  }
  if (!status.peerId || !status.multiaddrs?.length) {
    throw new HostedNodeError('node_unavailable', 'Hosted node has no peer identity yet');
  }
  return status as NodeStatus;
}

/**
 * Whether `/status` reports a finished claim: a claim on record AND the party it
 * named. `claim` flips to `claimed` the moment the node records the claim, but the
 * node then restarts in-process into the claimed party, and until that restart
 * finishes `partyId` is still the placeholder (or empty while the node object is
 * being rebuilt). Writing `joined` on the flag alone would record the placeholder
 * as the node's cadre.
 */
export function reportsClaim(status: NodeStatus): status is NodeStatus & { node: { claimedBy: string } } {
  return status.node.claim === 'claimed'
    && status.node.claimedBy !== undefined
    && status.node.partyId !== ''
    && status.node.partyId !== PLACEHOLDER_PARTY;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
