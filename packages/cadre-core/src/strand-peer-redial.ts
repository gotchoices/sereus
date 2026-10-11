/**
 * A running strand node redialing the strand's other members itself, when it holds a
 * connection to none of them, with the dial budget the host's declared link gives a
 * relayed connection.
 *
 * Why. Below cadre-core the only thing that redials a strand peer is FRET's maintenance:
 * its pings and neighbour announcements open the connection themselves (`dial: true`) under
 * a fixed 2 000 ms limit on the whole call (`MAINTENANCE_RPC_TIMEOUT_MS` in `p2p-fret`'s
 * `fret-service.ts`). Opening a relayed connection takes longer than that on a slow link:
 * about 9 s on a 20 ms per-frame cap with a 70%-busy event loop
 * (`joiner-first-commit-over-slow-relay`, whose slow-restart arm reproduces this), where
 * {@link relayedDialBudgetMs} allows 21.5 s at the default declaration. Each such redial is
 * cut off part-way through the handshake, from both sides, for as long as the link stays that
 * slow. And after a restart nothing else dials a strand peer: a cross-party strand's launch
 * seed is empty, and cadre-core's address passes only fill the address book. Two phones that
 * restarted then never reconnect, and a write either made alone never reaches the other.
 *
 * What it does. One loop per strand runtime, started in `StrandInstanceManager`'s runtime
 * build and stopped with the runtime (stop, quiesce, failed build), so a hibernating strand
 * never dials. Each look at the node:
 * - a member connected: nothing to do; look again in {@link STRAND_REDIAL_CHECK_MS}, or as
 *   soon as a peer disconnects.
 * - no member connected and none known: likewise nothing (a founder alone, a storage replica
 *   before anyone arrives).
 * - no member connected and some known: dial every known member at once
 *   ({@link dialPeerAddrs}, direct addresses before relayed ones), each address with the
 *   relayed-dial budget. A round that connects to one goes back to watching; one that does
 *   not waits a backoff starting at that budget and doubling to
 *   {@link STRAND_REDIAL_MAX_BACKOFF_MS}.
 *
 * Who is known: every peer the node's FRET table holds a verified signed address record for
 * (`strand-fret-addrs.ts`), plus the launch seed (sibling strand addresses and a formation's
 * carried addresses). Who counts as connected: a peer FRET labels `'member'` (it has seen it
 * speak this strand's protocols), or a seed peer. Neither ever includes a configured relay, a
 * peer FRET labels `'foreign'`, or a peer the revocation gate refuses. The relay matters most:
 * the strand node is connected to it throughout and FRET files it with a record like any
 * peer, so counting it would leave this loop idle exactly when it is needed.
 *
 * NOTE: this compensates for FRET's 2 000 ms maintenance dial limit, which cannot open a
 * relayed connection on a slow link (upstream half:
 * `blocked/fret-maintenance-ping-dial-budget-below-a-relayed-dial`). If FRET's maintenance
 * dial ever takes a limit derived from the declared link, this loop becomes a backstop and
 * may be deleted, as `peer-join-backfill.ts` says of itself.
 */

import debug from 'debug';
import type { Multiaddr } from '@multiformats/multiaddr';
import { relayedDialBudgetMs } from './link-budget.js';
import { CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS, SelfRelayOnlyError, dialPeerAddrs, type AddrDialer, type PeerDialBudget } from './peer-dial.js';
import { groupAddrsByPeerId } from './peer-addr-book.js';
import { strandFretMembership, strandFretPeerAddrs, type FretAddrHost, type FretMembership } from './strand-fret-addrs.js';
import { defaultTimeoutScheduler, type TimeoutScheduler } from './timeout-scheduler.js';

const log = debug('sereus:cadre:strand-redial');

/**
 * Gap between looks while a member is connected or none is known. While a member is
 * connected a look reads FRET's labels and the connection list and checks no signature
 * ({@link strandFretMembership}); a disconnect also triggers a look at once.
 */
export const STRAND_REDIAL_CHECK_MS = 5_000;

/**
 * Ceiling on the wait between failed rounds. A member that is gone for good is dialed this
 * often for as long as FRET keeps its record (up to 14 days after it was last confirmed).
 */
export const STRAND_REDIAL_MAX_BACKOFF_MS = 5 * 60_000;

/** The loop's dial budget and cadence. */
export interface StrandRedialTimings {
  /** Limit on one address's dial, and on one member's addresses together. */
  budget: PeerDialBudget;
  /** Wait after the first failed round; doubled after each further one. */
  minBackoffMs: number;
  /** Ceiling the backoff doubles up to. */
  maxBackoffMs: number;
  /** Gap between looks while nothing needs dialing. */
  checkMs: number;
}

/**
 * The timings at a declared link round trip: {@link relayedDialBudgetMs} per address, the
 * same whole-budget count per member as the control cohort's dials (dead direct addresses
 * a record lists ahead of the relayed one that works), and a first backoff of one per-address
 * budget.
 */
export function strandRedialTimings(linkRoundTripMs?: number): StrandRedialTimings {
  const perAddressMs = relayedDialBudgetMs(linkRoundTripMs);
  return {
    budget: { perAddressMs, totalMs: CONTROL_COHORT_DIAL_ADDRESS_ATTEMPTS * perAddressMs },
    minBackoffMs: perAddressMs,
    maxBackoffMs: STRAND_REDIAL_MAX_BACKOFF_MS,
    checkMs: STRAND_REDIAL_CHECK_MS
  };
}

/** The slice of a strand's libp2p node the loop uses. Structurally satisfied by db-p2p's node. */
export interface RedialNode extends AddrDialer {
  services?: FretAddrHost['services'];
  getConnections(): ReadonlyArray<{ remotePeer: { toString(): string } }>;
  addEventListener(type: 'peer:disconnect', listener: () => void): void;
  removeEventListener(type: 'peer:disconnect', listener: () => void): void;
}

export interface StrandRedialDeps {
  /** Names the strand in logs. */
  label: string;
  node: RedialNode;
  /**
   * The launch seed: multiaddr strings, each naming its peer in a trailing `/p2p/`.
   *
   * NOTE: read once, at runtime build. Addresses a re-formation carries while the strand runs
   * reach the peerStore (`recordFormationStrandAddrs`) but not this loop until the runtime is
   * rebuilt; if a re-formed strand is seen not reconnecting until relaunch, read the seed per round.
   */
  seed: readonly string[];
  /** Peer ids never dialed nor counted as members: the relays the node reserves on. */
  excluded: ReadonlySet<string>;
  /** The revocation gate's current verdict, asked of peers and of this node itself; absent for an open strand. */
  isRevoked?: (peerId: string) => boolean;
  /** Omit for real (unref'd) timers. */
  scheduler?: TimeoutScheduler;
}

/** A running redial loop; its only imperative is {@link stop}. */
export interface StrandPeerRedial {
  /** Idempotent. No look or round starts after it; dials in flight run out on their own deadlines, and their result is discarded. */
  stop(): void;
}

/** How a look ended: nothing needed dialing or a round connected (`'watch'`), or a round reached no member (`'retry'`). */
type LookOutcome = 'watch' | 'retry';

/** Start the loop; its first look runs at once. */
export function superviseStrandPeerRedial(deps: StrandRedialDeps, timings: StrandRedialTimings): StrandPeerRedial {
  return new StrandPeerRedialLoop(deps, timings);
}

class StrandPeerRedialLoop implements StrandPeerRedial {
  private readonly scheduler: TimeoutScheduler;
  private readonly seed: Map<string, Multiaddr[]>;
  private readonly selfId: string;
  private backoffMs: number;
  private timer: unknown = null;
  /**
   * Whether the pending wait is a plain gap between looks, which a disconnect cuts short. A
   * backoff after a failed round is not cut short, or a flapping relay connection would turn
   * the backoff into a dial on every flap; and while a look or round runs there is no wait.
   */
  private watching = false;
  private stopped = false;
  private readonly onDisconnect = (): void => {
    if (this.watching && !this.stopped) {
      this.cancelTimer();
      void this.tick();
    }
  };

  constructor(private readonly deps: StrandRedialDeps, private readonly timings: StrandRedialTimings) {
    this.scheduler = deps.scheduler ?? defaultTimeoutScheduler;
    this.seed = groupAddrsByPeerId([...deps.seed]);
    this.selfId = deps.node.peerId.toString();
    this.backoffMs = timings.minBackoffMs;
    deps.node.addEventListener('peer:disconnect', this.onDisconnect);
    void this.tick();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.cancelTimer();
    this.deps.node.removeEventListener('peer:disconnect', this.onDisconnect);
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.watching = false;
    let outcome: LookOutcome = 'watch';
    try {
      outcome = await this.lookAndDial();
    } catch (error) {
      // A node torn down under the look throws from its table export or connection list.
      log('strand %s: redial look failed (looking again in %dms): %o', this.deps.label, this.timings.checkMs, error);
    }
    if (this.stopped) {
      return;
    }
    this.watching = outcome === 'watch';
    const waitMs = outcome === 'watch' ? this.resetBackoff() : this.nextBackoff();
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, waitMs);
  }

  /**
   * One look, and a round of dials when it finds no member connected but some known. A node
   * whose own party was removed dials nobody: the strand keeps running for the session, but a
   * removed party must not keep dialing the strand's peers (`CadreNode.forgetRevokedJoin`).
   */
  private async lookAndDial(): Promise<LookOutcome> {
    if (this.deps.isRevoked?.(this.selfId) === true) {
      return 'watch';
    }
    const membership = strandFretMembership(this.deps.node);
    if (this.memberConnected(membership)) {
      return 'watch';
    }
    const known = await this.knownMembers(membership);
    if (known.size === 0 || this.stopped) {
      return 'watch';
    }
    log('strand %s: no member connected; dialing %d known member(s)', this.deps.label, known.size);
    if (await this.dialAny(known)) {
      log('strand %s: reconnected to a member', this.deps.label);
      return 'watch';
    }
    log('strand %s: no known member answered; next round in %dms', this.deps.label, this.backoffMs);
    return 'retry';
  }

  /** The gap between looks, with the backoff started over. */
  private resetBackoff(): number {
    this.backoffMs = this.timings.minBackoffMs;
    return this.timings.checkMs;
  }

  /**
   * The wait after a round that reached no member, doubling the next one up to the cap.
   *
   * NOTE: a round whose dials failed within milliseconds (a relay connection that is still
   * closing, the member's relay reservation not back yet) waits as long as one whose dials ran
   * out their budget. In `joiner-first-commit-over-slow-relay`'s third arm that first wait is what
   * leaves the joiner writable with no member connected. If reconnecting within seconds of a cut
   * ever matters, retry a round that failed that fast after a short delay instead.
   */
  private nextBackoff(): number {
    const waitMs = this.backoffMs;
    this.backoffMs = Math.min(waitMs * 2, this.timings.maxBackoffMs);
    return waitMs;
  }

  private eligible(peerId: string): boolean {
    return peerId !== this.selfId && !this.deps.excluded.has(peerId) && this.deps.isRevoked?.(peerId) !== true;
  }

  /** Whether an open connection reaches a peer FRET has seen speak this strand's protocols, or a seed peer. */
  private memberConnected(membership: ReadonlyMap<string, FretMembership>): boolean {
    return this.deps.node.getConnections().some((connection) => {
      const peerId = connection.remotePeer.toString();
      return this.eligible(peerId) && (membership.get(peerId) === 'member' || this.seed.has(peerId));
    });
  }

  /** The members to dial, each with its candidate addresses: verified FRET records first, then the seed's. */
  private async knownMembers(membership: ReadonlyMap<string, FretMembership>): Promise<Map<string, Multiaddr[]>> {
    const { peers } = await strandFretPeerAddrs(this.deps.node);
    const known = new Map<string, Multiaddr[]>();
    for (const [peerId, addrs] of [...peers, ...this.seed]) {
      if (!this.eligible(peerId) || membership.get(peerId) === 'foreign') {
        continue;
      }
      known.set(peerId, unionAddrs(known.get(peerId) ?? [], addrs));
    }
    return known;
  }

  /** Dial every member in `known` at once; resolves to whether any connected. */
  private async dialAny(known: ReadonlyMap<string, Multiaddr[]>): Promise<boolean> {
    const members = [...known];
    const outcomes = await Promise.allSettled(members.map(([peerId, addrs]) =>
      dialPeerAddrs(this.deps.node, addrs, this.timings.budget, `strand ${this.deps.label} redial of ${peerId}`)
    ));
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        const reason = outcome.reason instanceof SelfRelayOnlyError ? 'reachable only by relaying through this node' : outcome.reason;
        log('strand %s: redial of %s failed: %o', this.deps.label, members[i][0], reason);
      }
    });
    return outcomes.some((outcome) => outcome.status === 'fulfilled');
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/** `primary` then the entries of `extra` it lacks, compared as strings. */
function unionAddrs(primary: readonly Multiaddr[], extra: readonly Multiaddr[]): Multiaddr[] {
  const seen = new Set(primary.map((addr) => addr.toString()));
  return [...primary, ...extra.filter((addr) => !seen.has(addr.toString()))];
}
