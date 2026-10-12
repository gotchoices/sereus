/**
 * Helpers for reaching a cadre container's live health server.
 *
 * The container's health server (see @serfab/cadre-cli `HealthServer`) exposes
 * `/health` (liveness) and `/status` (detailed JSON). The provider only stores
 * the `/health` URL on a container, so the `/status` URL is derived from it.
 * Keeping that derivation in one place avoids the duplicated string surgery
 * that previously lived inline in ContainerService.
 */

import type { Container } from '../types.js';

/** Strand counts as reported by a container's `/status` endpoint. */
export interface ContainerStrandCounts {
  total: number;
  active: number;
  idle: number;
  hibernating: number;
}

/**
 * How the node's start-up invitation stands, as `/status` reports it (`node.invitation`,
 * cadre-cli's `InvitationStatus`): present only on a node started with one.
 */
export interface ContainerInvitationStatus {
  state: 'pending' | 'accepted' | 'failed';
  /** `accepted` only: the member that admitted the node, when known. */
  memberPeerId?: string;
  /** `failed` only: what went wrong; a member's refusal code ends it in parentheses (`invite-spent`). */
  error?: string;
  /** `failed` only: whether starting again with the same invitation may succeed (no member was reachable). */
  retryable?: boolean;
}

/**
 * Subset of the cadre-cli `/status` (`HealthStatus`) payload the provider
 * consumes. Strands live under `node.strands` in the real payload — NOT at the
 * top level. `peerId`/`multiaddrs` are top-level and may be absent (`peerId`
 * is `null` while the node is still acquiring a libp2p identity). Typed locally
 * because cadre-provider does not depend on cadre-cli.
 *
 * The join fields under `node` are what `ContainerService.readStatus` folds into
 * the record: `claim` / `claimedBy` / `partyId` for a node started with a claim
 * secret (`partyId` is the placeholder until the node has restarted into the
 * claimed party), `invitation` for one started with a cadre invitation.
 */
export interface ContainerHealthStatus {
  status: 'healthy' | 'unhealthy' | 'starting';
  uptime: number;
  peerId?: string | null;
  multiaddrs?: string[];
  node?: {
    strands?: ContainerStrandCounts;
    /** The party the node serves; the claimed party once a claim's restart has finished. */
    partyId?: string;
    /** `awaiting` with a claim secret and no claim on record, `claimed` once there is one, `none` without a secret. */
    claim?: 'awaiting' | 'claimed' | 'none';
    /** The owner key (base64url) the claim on record anchored; present iff `claim` is `claimed`. */
    claimedBy?: string;
    invitation?: ContainerInvitationStatus;
  };
}

/** Derive the `/status` URL from a container's `/health` endpoint URL. */
export function statusUrlFromHealthEndpoint(healthEndpoint: string): string {
  return healthEndpoint.replace('/health', '/status');
}

/**
 * Fetch a container's live `/status` payload.
 *
 * Resolves to `undefined` (never throws) when the container has no health
 * endpoint, the fetch fails, or the response is not OK — so callers can degrade
 * gracefully rather than aborting a wider collection loop.
 */
export async function fetchContainerHealthStatus(
  container: Container
): Promise<ContainerHealthStatus | undefined> {
  if (!container.healthEndpoint) return undefined;

  try {
    const res = await fetch(statusUrlFromHealthEndpoint(container.healthEndpoint));
    if (!res.ok) return undefined;
    return await res.json() as ContainerHealthStatus;
  } catch {
    // Container unreachable / status server down — caller falls back to defaults.
    return undefined;
  }
}
