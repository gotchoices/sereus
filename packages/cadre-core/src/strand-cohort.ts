/**
 * A single CadrePeer membership row, as returned by
 * `ControlDatabase.queryCadrePeers()`.
 */
export interface CohortPeerRow {
  peerId: string;
  /** Comma-joined list of multiaddr strings; `''` when no addrs were recorded. */
  multiaddr: string | null;
}

/**
 * Membership-only view of a strand's cohort, derived from the control network's
 * CadrePeer rows. The bootstrap addresses themselves are resolved separately
 * (over the strand-addr RPC) from these peerIds, never from the rows' addr field.
 */
export interface CohortMembers {
  /** PeerIds of cohort members other than self — the strand-addr RPC fan-out targets (deduplicated, in row order). */
  otherPeerIds: string[];
}

/**
 * Derive the membership view of a strand's cohort from the control network's
 * CadrePeer rows: the peerIds of members other than `selfPeerId` (the strand-addr
 * RPC fan-out targets).
 *
 * Deliberately does NOT read `CadrePeer.Multiaddr` — that field carries each
 * node's *control*-network address, which must not seed the *strand* mesh
 * (dialing it reaches the remote's control instance, not its strand instance).
 * The strand-network bootstrap addresses are resolved on demand over the control
 * mesh from these peerIds.
 */
export function deriveCohortMembers(peers: CohortPeerRow[], selfPeerId?: string): CohortMembers {
  const otherPeerIds: string[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    if (selfPeerId !== undefined && peer.peerId === selfPeerId) {
      continue;
    }
    if (seen.has(peer.peerId)) {
      continue;
    }
    seen.add(peer.peerId);
    otherPeerIds.push(peer.peerId);
  }

  return { otherPeerIds };
}
