/**
 * Delegate-peer admission grants for a party control node that also runs the
 * circuit-relay server.
 *
 * A strand node runs as its own libp2p instance with its own transport peerId,
 * derived from the cadre identity key + strandId (`strand-transport-key.ts`).
 * That derivation uses the member's PRIVATE seed by design, so no third party —
 * including a co-cadre relay — can recompute it. When a NAT'd member's strand
 * node tries to reserve a circuit-relay slot on a sibling's control node, the
 * relay's membership connection gater sees an unknown peerId and denies the
 * connection, which kills the reservation and fails the strand's
 * `libp2p.start()` outright.
 *
 * The resolution (docs/strands.md → "Relays and admission"): a party control
 * node running a relay is party-private infrastructure — it relays for its own
 * party's nodes, including the extra transport identities its members' strand
 * nodes run as, and for nobody else. The mechanism is a **member-announced
 * delegate grant**: before a member's control node starts a strand node, it
 * tells its siblings (over the already-authenticated `/sereus/strand-addr/1.0.0`
 * RPC) the derived peerId that strand node will use, and the receiver holds a
 * short-lived, in-memory admission grant for exactly that peerId. The grant is
 * consulted ONLY by the connection-level gate
 * (`CadreNode.admitInboundControlConnection`); the fail-closed per-stream gate
 * (`authorizeInboundControlStream`) never honors it, so a delegate gets the
 * connection (all a circuit-relay `hop` reservation needs) and nothing more.
 *
 * A grant is a delegation of trust to an already-trusted member: the receiver
 * cannot verify that the announced peerId really is the member's strand node,
 * so an authorized member can hand CONNECTION-level access to a peerId of its
 * choosing for up to {@link DELEGATE_GRANT_TTL_MS}. The caps below bound how
 * far a buggy or compromised member can stretch that.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';

const log = debug('sereus:cadre:delegate-admission');

/**
 * How long one announced delegate grant stays valid without a re-announce.
 * Announcers refresh at half this (`CadreNode`'s reconcile pass), so a live
 * strand's grant never lapses while its control node can still reach the relay.
 */
export const DELEGATE_GRANT_TTL_MS = 30 * 60 * 1000;

/** Cap on live grants per announcing member (soonest-expiry evicted first). */
export const MAX_DELEGATE_GRANTS_PER_MEMBER = 32;

/** Cap on live grants in total (soonest-expiry evicted first). */
export const MAX_DELEGATE_GRANTS = 256;

/** One recorded delegate admission grant. */
interface DelegateGrant {
  /** The authorized member whose control node announced this delegate. */
  announcerPeerId: string;
  /** The strand the delegate serves — diagnostics + per-strand replace semantics. */
  strandId: string;
  /** The delegate transport peerId the grant admits. */
  delegatePeerId: string;
  /** Epoch ms after which the grant is inert. */
  expiresAt: number;
}

/** Map key for the replace-per-(announcer, strand) semantics. */
function grantKey(announcerPeerId: string, strandId: string): string {
  return `${announcerPeerId}\n${strandId}`;
}

/**
 * In-memory store of delegate admission grants, keyed by (announcer, strandId)
 * so a re-announce REPLACES the previous delegate peerId rather than
 * accumulating — a restarted strand cannot leak grants. Expired entries are
 * pruned lazily on every read/write. Injectable `now` keeps expiry testable
 * without fake timers.
 */
export class DelegateAdmissionStore {
  private readonly grants = new Map<string, DelegateGrant>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DELEGATE_GRANT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Number of live (unexpired at last prune) grants — test/diagnostic surface. */
  get size(): number {
    return this.grants.size;
  }

  /**
   * Record (or refresh) a grant: `delegatePeerId` acts on behalf of
   * `announcerPeerId` for `strandId`, valid for the store's TTL from `now`.
   * Enforces {@link MAX_DELEGATE_GRANTS_PER_MEMBER} and
   * {@link MAX_DELEGATE_GRANTS}, evicting the soonest-expiry grant first —
   * biased against the stalest delegation, never against the fresh announce.
   */
  grant(announcerPeerId: string, strandId: string, delegatePeerId: string, now: number = Date.now()): void {
    this.prune(now);
    const key = grantKey(announcerPeerId, strandId);
    if (!this.grants.has(key)) {
      this.evictAtCap(
        MAX_DELEGATE_GRANTS_PER_MEMBER,
        (g) => g.announcerPeerId === announcerPeerId
      );
      this.evictAtCap(MAX_DELEGATE_GRANTS, () => true);
    }
    this.grants.set(key, { announcerPeerId, strandId, delegatePeerId, expiresAt: now + this.ttlMs });
    log('Delegate grant recorded: %s → %s (strand %s, %d live)', announcerPeerId, delegatePeerId, strandId, this.grants.size);
  }

  /** Is `remotePeerId` covered by a live grant? Prunes expired entries as it goes. */
  has(remotePeerId: string, now: number = Date.now()): boolean {
    this.prune(now);
    for (const grant of this.grants.values()) {
      if (grant.delegatePeerId === remotePeerId) {
        return true;
      }
    }
    return false;
  }

  /** Drop every grant whose expiry has passed. */
  private prune(now: number): void {
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(key);
      }
    }
  }

  /**
   * If the grants matching `filter` are at `cap`, evict the soonest-expiry one
   * among them to make room for the insert the caller is about to do.
   */
  private evictAtCap(cap: number, filter: (grant: DelegateGrant) => boolean): void {
    let count = 0;
    let victimKey: string | undefined;
    let victimExpiry = Number.POSITIVE_INFINITY;
    for (const [key, grant] of this.grants) {
      if (!filter(grant)) {
        continue;
      }
      count++;
      if (grant.expiresAt < victimExpiry) {
        victimExpiry = grant.expiresAt;
        victimKey = key;
      }
    }
    if (count >= cap && victimKey !== undefined) {
      const victim = this.grants.get(victimKey)!;
      this.grants.delete(victimKey);
      log('Delegate grant cap %d hit — evicted soonest-expiry grant %s → %s (strand %s)',
        cap, victim.announcerPeerId, victim.delegatePeerId, victim.strandId);
    }
  }
}

/** A circuit relay named by a multiaddr, as an announce target. */
export interface CircuitRelayTarget {
  /** The relay's peerId — the `<relay>` in `…/p2p/<relay>/p2p-circuit…`. */
  relayPeerId: string;
  /**
   * The relay's DIRECT dial multiaddr (the prefix before `/p2p-circuit`),
   * usable as a dial fallback when no connection to the relay is open yet.
   */
  relayAddr: string;
}

/**
 * Extract the circuit relays named by a multiaddr list — for each
 * `…/p2p/<relay>/p2p-circuit…` entry, the relay's peerId and its direct dial
 * prefix. A bare `/p2p-circuit` (no relay named), a non-circuit addr, an
 * unparsable addr, and an unparsable relay peerId are all skipped. A trailing
 * `/p2p/<dst>` after the circuit component names the DESTINATION, never the
 * relay, and is ignored. Deduplicated by relay peerId (first addr wins).
 */
export function extractCircuitRelayTargets(addrs: string[]): CircuitRelayTarget[] {
  const byRelay = new Map<string, CircuitRelayTarget>();
  for (const addr of addrs) {
    const target = circuitRelayTarget(addr);
    if (target && !byRelay.has(target.relayPeerId)) {
      byRelay.set(target.relayPeerId, target);
    }
  }
  return [...byRelay.values()];
}

/** One-addr body of {@link extractCircuitRelayTargets}; null when `addr` names no relay. */
function circuitRelayTarget(addr: string): CircuitRelayTarget | null {
  try {
    const ma = multiaddr(addr);
    const components = ma.getComponents();
    const circuitIdx = components.findIndex((c) => c.name === 'p2p-circuit');
    if (circuitIdx < 1) {
      return null;
    }
    const relay = components[circuitIdx - 1];
    if (relay.name !== 'p2p' || !relay.value) {
      return null;
    }
    peerIdFromString(relay.value); // validate; throws on garbage
    return {
      relayPeerId: relay.value,
      relayAddr: ma.decapsulate('/p2p-circuit').toString()
    };
  } catch (err) {
    log('Skipping unparsable relay addr %s: %o', addr, err);
    return null;
  }
}
