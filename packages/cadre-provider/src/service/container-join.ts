/**
 * How a container joins its cadre, as the record carries it: the credential a create
 * request earns (`joinFor`), the join state a node's `/status` report folds to
 * (`joinStateFrom`), and what `ContainerService.nodeCode` answers. Pure functions over the
 * record and the report; the service decides when to read and what to write.
 */

import { randomBytes } from 'node:crypto';
import {
  type ContainerJoin,
  type ContainerJoinRequest,
  type ContainerJoinState,
  UNCLAIMED_PARTY_ID,
} from '../types.js';
import type { ContainerHealthStatus } from './container-health.js';

/**
 * 32 random bytes, base64url: exactly what cadre-core's `parseClaimSecret` accepts and what
 * cadre-host mints. The one minting site, in the service, so both orchestrators only
 * inject what they are handed; the seed token is still minted in the orchestrators until
 * the seed path is retired.
 */
function mintClaimSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The join a record carries for a request: the claim gets its secret here, the invitation is kept as submitted. */
export function joinFor(request: ContainerJoinRequest | undefined): ContainerJoin | undefined {
  if (!request) return undefined;
  return request.kind === 'claim'
    ? { kind: 'claim', secret: mintClaimSecret() }
    : { kind: 'invitation', invitation: request.invitation };
}

/**
 * The join state a `/status` payload reports for a container, or undefined when it
 * reports none: a seed-path container, or a node that is not answering with the join
 * fields yet.
 *
 * A claim is `claimed` only once the node also reports the claimed party. `claim` flips
 * the moment the node writes its record, but the node then restarts in-process into that
 * party, and until the restart finishes `partyId` is still the placeholder (or empty while
 * the node object is rebuilt); folding on the flag alone would record the placeholder as
 * the container's cadre. Same rule as cadre-host's `reportsClaim`. `none` on a claim
 * container means the node was started without the secret, which this provider never does;
 * it is left unfolded rather than invented.
 */
export function joinStateFrom(join: ContainerJoin | undefined, health: ContainerHealthStatus): ContainerJoinState | undefined {
  const node = health.node;
  if (!join || !node) return undefined;
  if (join.kind === 'claim') {
    if (node.claim === 'claimed' && node.claimedBy && node.partyId && node.partyId !== UNCLAIMED_PARTY_ID) {
      return { kind: 'claim', state: 'claimed', ownerKey: node.claimedBy, partyId: node.partyId };
    }
    return node.claim === 'awaiting' || node.claim === 'claimed' ? { kind: 'claim', state: 'awaiting' } : undefined;
  }
  const invitation = node.invitation;
  if (!invitation) return undefined;
  switch (invitation.state) {
    case 'pending':
      return { kind: 'invitation', state: 'pending' };
    case 'accepted':
      return { kind: 'invitation', state: 'accepted', ...(invitation.memberPeerId ? { memberPeerId: invitation.memberPeerId } : {}) };
    case 'failed':
      // NOTE: a spent or expired invitation reports `failed` with `invite-spent` and
      // `retryable: false`, and the container keeps running with nothing to do. The app's
      // remedy is to delete it and rent again, so there is no retry route; add one here
      // and at the service if a retryable failure (no member reachable) ever needs more
      // than the node's own restart.
      return {
        kind: 'invitation',
        state: 'failed',
        error: invitation.error ?? 'the invitation could not be redeemed',
        retryable: invitation.retryable === true,
      };
  }
}

/** Both states are built field-by-field in one order (`joinStateFrom`), so their JSON compares. */
export function sameJoinState(a: ContainerJoinState | undefined, b: ContainerJoinState): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** Why `ContainerService.nodeCode` has no code to give; the route maps each to a status. */
export type NodeCodeRefusal =
  /** A seed-path or invitation container: nothing to claim. */
  | 'not-claimable'
  /** A live read says the node has an owner. */
  | 'already-claimed'
  /** The container is `stopped` or `error`. */
  | 'gone'
  /** No `/status`, no peer id, or no announced WebSocket address yet; callers poll. */
  | 'not-ready';

/** What `GET /containers/:id/code` returns: the code the owner's phone scans or pastes, and its parts. */
export interface NodeCode {
  /** `sereus-join:1.…` (`encodeNodeCode`), what `CadreNode.claimNode` takes after `decodeNodeClaimPayload`. */
  code: string;
  peerId: string;
  /** The addresses in the code, each ending in `/p2p/<peerId>`. */
  multiaddrs: string[];
}
