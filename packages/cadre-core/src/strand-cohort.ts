import type { StrandMode } from './types.js';

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
 * Cohort-derived discovery seed for a strand's libp2p node. `bootstrapNodes`
 * here are **strand-network** addresses resolved on demand from co-cadre
 * siblings (see `collectStrandAddrs` / `STRAND_ADDR_PROTOCOL`), NOT the control
 * addresses stored in `CadrePeer.Multiaddr`.
 */
export interface CohortSeed {
  /** Dialable strand-network multiaddr strings for cohort peers other than self (deduplicated). */
  bootstrapNodes: string[];
  /** True when at least one CadrePeer row other than self exists (even if it has no resolvable strand addr). */
  hasOtherPeers: boolean;
}

/**
 * Membership-only view of a strand's cohort, derived from the control network's
 * CadrePeer rows. The bootstrap addresses themselves are resolved separately
 * (over the strand-addr RPC) from these peerIds, never from the rows' addr field.
 */
export interface CohortMembers {
  /** PeerIds of cohort members other than self — the strand-addr RPC fan-out targets (deduplicated, in row order). */
  otherPeerIds: string[];
  /** True when at least one CadrePeer row other than self exists (even if it has no resolvable strand addr). */
  hasOtherPeers: boolean;
}

/**
 * Derive the membership view of a strand's cohort from the control network's
 * CadrePeer rows: the peerIds of members other than `selfPeerId` (the strand-addr
 * RPC fan-out targets) and whether any other member exists at all.
 *
 * Deliberately does NOT read `CadrePeer.Multiaddr` — that field carries each
 * node's *control*-network address, which must not seed the *strand* mesh
 * (dialing it reaches the remote's control instance, not its strand instance).
 * The strand-network bootstrap addresses are resolved on demand over the control
 * mesh from these peerIds. `hasOtherPeers` reflects membership presence, NOT
 * dialability, so a cohort whose strand addrs are not yet resolvable still
 * selects `networked` mode.
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

  return { otherPeerIds, hasOtherPeers: otherPeerIds.length > 0 };
}

/**
 * Choose the strand mode. An explicit mode (from `addStrand`) always wins. When
 * omitted (the `handleStrandAdded` discovery path, or an `addStrand` caller that
 * leaves it unset), infer: `bootstrap` for a solo/first node (no other peers),
 * `networked` once the cohort has other members.
 */
export function selectStrandMode(explicitMode: StrandMode | undefined, hasOtherPeers: boolean): StrandMode {
  return explicitMode ?? (hasOtherPeers ? 'networked' : 'bootstrap');
}
