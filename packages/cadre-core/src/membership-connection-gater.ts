/**
 * Control-network inbound admission gates: the encrypted-connection checkpoint
 * and the circuit-relay reservation checkpoint.
 *
 * The fail-closed layer of the membership enforcement chain is per-stream: the
 * control node's protocol guard (`control-protocol-guard.ts`) refuses a peer that
 * is not an authorized member on every protocol not declared open to strangers,
 * before its handler runs, and the replicated rows an outsider *can* still write
 * are disbelieved at read time. This module is NOT a stranger boundary on an
 * enrolled node — outside the bring-up quiet period it admits every inbound
 * connection. Its jobs are:
 *
 *  - the bring-up quiet period (below), the one state in which it denies;
 *  - deciding which admitted peers carry a deadline: a peer the policy cannot
 *    place is admitted PROVISIONALLY, and its connection is closed at the
 *    deadline unless the policy admits it by then (see "Provisional admission");
 *  - handing circuit-relay reservations to the reservation policy (see "The
 *    relay-reservation seam").
 *
 * Why a stranger's connection is admitted at all: the gate sees only a peer id,
 * after the encrypted handshake and before any protocol, so it cannot tell an
 * outsider from a device carrying a cadre invitation this node has not received
 * yet, or from a sibling whose membership row is still replicating. Refusing
 * would fail those at the connection; admitting costs a mute connection for a
 * bounded time, because the protocol guard refuses it every members-only protocol.
 *
 * ## Admitted outright
 *
 * A peer the policy CAN place gets no deadline. Besides members, configured
 * infrastructure and an un-enrolled node's whole world (empty anchor or empty
 * authorized set), that covers the stranger windows: states in which this node
 * expects a stranger on one of the `stranger-open` protocols declared in
 * `controlProtocolClasses` (`control-protocol-guard.ts`):
 *
 *  - `/sereus/seed/1.0.0` — enrollment seed delivery.
 *    An owner dials a brand-new node to seed it (the new node has no members
 *    yet, so it admits everyone outright). The handler's own trust decision is the
 *    anchored seed-trust policy — or, on a node started with a claim secret
 *    (`CadreNodeConfig.claim`), the claim-secret policy. Such a node is the one
 *    stranger-facing state that is NOT "admit the connection and let the
 *    per-stream gates sort it out": while it waits to be claimed
 *    (`CadreNode.isAwaitingClaim`) its connection is admitted, because the claim
 *    seed has to ride one, but its control-DB streams and relay reservations are
 *    refused ahead of every admission below, the empty-anchor one included. An
 *    unclaimed node has no siblings to replicate from, and one on a public
 *    address must not relay for anyone. The claim anchors the owner, after which
 *    the ordinary rules apply.
 *  - `/sereus/formation/1.0.0` — cross-party
 *    strand formation via open invitations. Stranger-facing BY DESIGN: the
 *    initiator is another party, and its token is only checkable inside the
 *    protocol. The window is keyed on EXPECTATION of a stranger, not capability
 *    to serve one: it is open only while this node has at least one UNEXPIRED,
 *    NOT-FULLY-CONSUMED open invitation outstanding
 *    (`StrandSolicitationService.hasOutstandingInvitation` — the tokens this
 *    process minted or published, plus any still-redeemable `FormationInvite`
 *    row the usage recorder can see). Registering the responder does NOT open
 *    it, so on every node — each registers one at `CadreNode.start` — a stranger
 *    with no invitation in play stays on the provisional deadline. The
 *    handler's own trust decision remains the per-token check, which is
 *    strictly finer than this one: a peer admitted here can still be rejected
 *    in-protocol for a bogus or spent token.
 *  - `/sereus/cadre-invite/1.0.0` — redemption
 *    of a cadre invitation at any member machine. Stranger-facing BY DESIGN:
 *    the device is not a member until the redemption writes its row, and its
 *    proof of possession (a signature with the invitation's private key) is
 *    only checkable inside the protocol. Keyed on expectation, as formation's
 *    is: open only while this node holds at least one LIVE `CadreInvite` row
 *    (`ControlDatabase.hasLiveCadreInvite`: not withdrawn, unexpired, uses left,
 *    issuer still an owner). A member that has not yet received the device's
 *    row by replication admits the device provisionally instead, seats the row
 *    from the invitation bundle during the redemption, and so admits it at the
 *    deadline's re-check.
 *
 * There is one further connection-level carve-out, which is NOT a protocol
 * window:
 *
 *  - **Announced delegate peers** (`delegate-admission.ts`). A member's strand
 *    node runs as a separate libp2p identity whose peerId no sibling can
 *    recompute. Before starting a strand node, a member's control node
 *    announces that peerId over the already-authenticated strand-addr RPC, and
 *    the receiver holds a short-lived grant for it
 *    (`CadreNode.grantDelegateAdmission`). The grant admits the CONNECTION
 *    outright, admits the peer's RESERVATION at the seam below (without
 *    spending the unauthorized budget), and nothing else — it is deliberately
 *    invisible to the protocol guard, so a delegate still gets refused on every
 *    members-only protocol.
 *
 * ## Provisional admission
 *
 * A peer the policy cannot place (`'admit-provisionally'`) gets its connection
 * and a deadline — {@link PROVISIONAL_ADMISSION_DEADLINE_MS} at the default
 * declaration; `CadreNode` passes the one derived from its OWN declared link,
 * because the member is the machine that decides. At the deadline the gate asks
 * the policy again:
 *
 *  - `'admit'` — the peer has since become a member, holds a delegate grant, or
 *    this node now holds a live invitation (a redeeming device's row was
 *    seated): the connection stays, and nothing is re-armed;
 *  - `'admit-provisionally'` — the connection is closed (a bounded graceful
 *    close, with an abort only as the escalation);
 *  - the question throws or outlasts the decision deadline — the connection
 *    stays (see "Fail-open, deliberately").
 *
 * A connection that is already gone by then costs no question. One peer may hold
 * several provisional connections; each deadline re-asks on its own.
 *
 * NOTE: the gate does not stop a provisionally admitted stranger from being
 * counted into this node's FRET ring and control-database cohort by opening or
 * advertising the party's protocols — FRET and Optimystic decide that from the
 * protocols libp2p records the peer as serving. Ticket
 * `stranger-joins-the-control-cohort-by-advertising-protocols` (blocked).
 *
 * ## The relay-reservation seam
 *
 * A circuit-relay reservation is established by the reserving peer DIALING the
 * relay, so at the relay it rides an inbound connection — and closing that
 * connection kills the reservation. For a genuine member whose `CadrePeer` row
 * has not yet replicated to this node that would NOT be self-healing the way a
 * data connection's close is: an outbound reconcile dial re-establishes a data
 * link, but no outbound dial can grant the REMOTE peer a reservation, and a
 * relay-only peer has no address of its own to dial back — the reservation IS
 * its address. Boot ordering makes the window ordinary (a node reserves at the
 * end of its own `start()`, before its row could have replicated anywhere), and
 * a stalled replication makes it unbounded. So the reservation is decided on its
 * own terms, not by the connection's:
 *
 *  - It is decided at libp2p's `denyInboundRelayReservation` hook (the
 *    circuit-relay server consults it per RESERVE request): the policy admits
 *    members, delegates and configured infra outright, and admits peers it
 *    cannot place only within a bounded budget
 *    ({@link UnauthorizedReservationBudget}) — a member whose row is in flight
 *    always finds a slot under any sane cap, while outsiders cannot annex the
 *    party's relay capacity. COUNT and lifetime are the only bounds on such a
 *    peer: a party-run relay forwards without libp2p's per-connection data and
 *    duration limit by default (`relay-server.ts`), so what a granted slot
 *    carries is not capped.
 *  - An ADMITTED reservation disarms every provisional deadline the peer holds
 *    here, so its connection outlives the deadline even while the peer is still
 *    unplaced. A refused one disarms nothing.
 *
 * The deadline clears on reservation ADMISSION, not on the reservation's own
 * success: this gate cannot observe the server-side `reserve()` outcome, so a
 * peer whose admitted reservation is then refused for server capacity keeps its
 * connection until either side closes it — bounded and mute, so harmless.
 *
 * Everything else a control node serves is either libp2p plumbing open to any
 * connection (identify, ping, hole punching, AutoNAT, the relay protocols) or
 * members-only — wake, strand-addr, the Optimystic control-DB protocols and FRET —
 * and the fail-closed layer for all of it is the protocol guard
 * (`control-protocol-guard.ts`), one seam that wraps every handler at dispatch,
 * with a protocol nobody classed treated as members-only. The two layers
 * complement, not duplicate: this connection gate is fail-open over a live DB
 * read and decides only how long a connection lasts, the protocol guard is
 * fail-closed and has NO stranger carve-outs — a live invitation admits a
 * stranger's connection outright for redemption, yet its repo and FRET streams
 * are still refused.
 *
 * ## The bring-up quiet period
 *
 * One state is decided BEFORE any of the above, and is not about the remote peer
 * at all: while this node's control-database bring-up is in flight
 * (`InboundAdmissionPolicy.bringUpInFlight`), the gate denies BOTH directions —
 * `denyDialPeer` and `denyInboundEncryptedConnection` — and then opens.
 *
 * The invariant it protects is "`ControlDatabase.initialize()` runs while this
 * node holds ZERO control connections". Building that database is a long chain
 * of cohort-consulting block probes, and every connected same-party sibling is in
 * the cohort those probes consult. A sibling that has not yet replicated this
 * node's `CadrePeer` row correctly refuses them at its own fail-closed per-stream
 * gate, so ONE connection in this window turns bring-up into
 * `BlockUnavailableError` and `start()` rejects. Retrying cannot converge: the
 * condition that would clear the refusal is this node's own row reaching the
 * sibling, and writing that row needs the database the retry is building. So the
 * only fix is to not be in the conversation yet — which is what this window is.
 *
 * The ordering is arranged so nothing SHOULD open a connection here anyway:
 * `network.relayAddrs` resolves to a listener that dials nothing and reserves
 * after bring-up (`relay-addrs.ts`), `controlNetwork.bootstrapNodes` is dialed
 * after bring-up (`CadreNode.dialControlBootstrapPeers`), and the control-cohort
 * reconcile pass is scheduled post-start. This window is what makes that a property
 * rather than an accident of ordering — the live cases it catches are peers the node
 * remembers from a previous run, which the connection manager auto-dials, and
 * inbound dials.
 *
 * A denial here costs a retry, not a partition: libp2p's connection manager
 * re-dials on its auto-dial cadence, the reservation supervisor re-drives, and a
 * denied inbound peer reconnects. The window opens on bring-up FAILURE too (via
 * `CadreNode.cleanup`), so teardown is never gated.
 *
 * ## Fail-open, deliberately
 *
 * Outside that window this layer never denies, and it closes a provisional
 * connection only on a positive answer that the peer is still unplaced. Any
 * error, missing dependency, timeout or ambiguous state admits the connection
 * outright (and the reservation), or keeps a provisional connection at its
 * deadline, and defers to the fail-closed stream gates — a DB hiccup must not
 * partition a legitimate cadre.
 */

import debug from 'debug';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import { withDeadline } from './control-stream.js';
import { PARTY_RELAY_RESERVATION_TTL_MS } from './relay-server.js';
import { ADMISSION_DECISION_TIMEOUT_MS, relayedRequestBudgetMs } from './link-budget.js';

const log = debug('sereus:cadre:connection-gater');

/**
 * How long a provisionally admitted connection lasts before the gate re-asks the
 * policy and closes it unless the peer is admissible by then (see the module
 * doc's "Provisional admission").
 *
 * {@link relayedRequestBudgetMs}: 28 500 ms at the default declaration. The
 * longest exchange a stranger legitimately starts on a fresh connection is a
 * cadre invitation redemption, and the device abandons each member address after
 * that same budget of its own declared link (`redeemAtMembers`): it covers the
 * dial, the request, the member's catch-up push, the seat and the redemption. So
 * a member never cuts an exchange the device is still waiting on, and a
 * reservation request lands well inside it. This is the value at the default
 * declaration; `CadreNode` passes the one derived from its OWN declaration.
 *
 * NOTE: accepted tradeoff — any stranger can hold a mute connection to any
 * enrolled member for this long, weighed against letting a device redeem an
 * invitation at a member that has not yet received its row (maintainer,
 * 2026-10-07, plan `cadre-invite-redeemable-before-the-row-replicates`). It can
 * open only stranger-open and transport streams (the protocol guard), and
 * libp2p's connection-manager limits bound how many it holds. Revisit if stranger
 * connections show up as load on a member.
 */
export const PROVISIONAL_ADMISSION_DEADLINE_MS = relayedRequestBudgetMs();

/**
 * Bound on the graceful close of an expired provisional connection. It exists
 * because `AbstractMultiaddrConnection.close()` awaits an `idle`/`drain` event
 * when the connection still has unsent bytes, and that wait has no timeout of
 * its own — an unsignalled one never ends. This gate writes nothing to a
 * stranger, so the wait is not reachable from here; the bound is here so a timer
 * callback can never hold an unending await.
 *
 * Applied through {@link withDeadline}, not `AbortSignal.timeout`: the latter is
 * not reliably present on React Native/Hermes, which loads this same module.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: bounds a local connection close inside a timer callback, and expiry aborts the connection instead
export const PROVISIONAL_ADMISSION_CLOSE_TIMEOUT_MS = 2_000;

/**
 * Default cap on concurrent relay reservations held by peers the membership
 * check could not place (see {@link UnauthorizedReservationBudget}). Small on
 * purpose: it exists for the handful of genuine members whose rows are still
 * in flight, not as public relay capacity. Overridable per node via
 * `network.unauthorizedRelayReservationCap` (0 refuses every unauthorized
 * reservation — the strict pre-seam posture).
 *
 * NOTE: this cap shares the relay server's own reservation store, whose
 * party-run default size is `PARTY_RELAY_MAX_RESERVATIONS` (128,
 * `relay-server.ts`); unplaced peers may therefore occupy up to this many of
 * those slots, and the rest are what members and delegates compete for. The two
 * are kept apart by hand — if this is raised, or an embedder shrinks the store
 * through `network.relayServerInit.reservations.maxReservations`, keep this one
 * well under the store's, or a fleet of unplaceable peers can crowd genuine
 * members out of the server's own store (which the gate cannot override).
 */
export const MAX_UNAUTHORIZED_RELAY_RESERVATIONS = 8;

/**
 * The connection-level outcome of the admission policy:
 *  - `'admit'` — a peer with a legitimate claim on the connection (member,
 *    delegate, infra, open stranger window, or any fail-open state); no deadline.
 *  - `'admit-provisionally'` — a peer the policy cannot place (an outsider, a
 *    device whose invitation row this node does not hold yet, or a member whose
 *    row is still replicating — indistinguishable here): admit the connection,
 *    and at the deadline ask again and close it unless the answer is `'admit'`.
 *
 * There is no deny: the gate's only denial is the bring-up quiet period, which
 * is not a judgement of the peer.
 */
export type InboundConnectionVerdict = 'admit' | 'admit-provisionally';

/**
 * The admission decisions the gate defers to — implemented by
 * `CadreNode.admitInboundControlConnection` /
 * `CadreNode.admitControlRelayReservation` (enrollment windows, anchor state,
 * bootstrap infra, delegate grants, the authorized-member set, the
 * unauthorized-reservation budget). Kept injectable so the gater's
 * composition/fail-open behavior is unit-testable without a full node.
 */
export interface InboundAdmissionPolicy {
  /**
   * Verdict on an inbound encrypted connection from this peer. Asked again at a
   * provisional connection's deadline, so it must answer from current state.
   */
  admitInbound(remotePeerId: string): Promise<InboundConnectionVerdict> | InboundConnectionVerdict;
  /** Should this peer be granted a circuit-relay reservation slot? */
  admitRelayReservation(remotePeerId: string): Promise<boolean> | boolean;
  /**
   * True while this node's control-database bring-up is in flight — the
   * {@link createMembershipConnectionGater} quiet period (see the module doc).
   * Peer-independent, unlike the two decisions above, and SYNCHRONOUS: it is
   * read on the outbound-dial path, where an await would be a new stall.
   *
   * Optional — a policy that omits it is never quiet, which is the right default
   * for every caller that is not a booting `CadreNode`.
   */
  bringUpInFlight?(): boolean;
}

/**
 * Bounded budget of concurrent relay reservations for peers the membership
 * check could not place. `tryAdmit` is the whole surface: an already-admitted
 * peer refreshes its entry (a reservation refresh never double-counts), a new
 * peer takes a free slot or is refused. Entries expire after `ttlMs`, which
 * `CadreNode` passes as the relay server's own resolved `reservationTtl`
 * (`relay-server.ts`): the server holds an unrefreshed reservation exactly that
 * long, and a live reserver re-requests (re-hitting the admission hook,
 * refreshing its entry) well before expiry — so the live entry count tracks the
 * server's own occupancy without this module reaching into the server's
 * reservation store. Injectable `now` keeps expiry testable without fake
 * timers. Authorized members and delegates are never run through this — the
 * policy admits them before consulting the budget, and `release`s the slot such
 * a peer took while it was still unplaceable, so the boot-ordering window a
 * member passes through costs the budget nothing once its row lands.
 */
export class UnauthorizedReservationBudget {
  private readonly admitted = new Map<string, number>();

  constructor(
    /** Most peers admitted at once — `network.unauthorizedRelayReservationCap`, resolved. */
    readonly cap: number = MAX_UNAUTHORIZED_RELAY_RESERVATIONS,
    private readonly ttlMs: number = PARTY_RELAY_RESERVATION_TTL_MS
  ) {}

  /** Number of live (unexpired at last prune) entries — test/diagnostic surface. */
  get size(): number {
    return this.admitted.size;
  }

  /** Admit (or refresh) `remotePeerId` if a slot is free; false when the cap is spent. */
  tryAdmit(remotePeerId: string, now: number = Date.now()): boolean {
    this.prune(now);
    if (!this.admitted.has(remotePeerId) && this.admitted.size >= this.cap) {
      log('Unauthorized-reservation budget spent (%d/%d) — refusing %s', this.admitted.size, this.cap, remotePeerId);
      return false;
    }
    this.admitted.set(remotePeerId, now + this.ttlMs);
    return true;
  }

  /**
   * Give back the slot `remotePeerId` holds, if any — called when the peer has
   * become admissible on its own merits (its membership row replicated, or a
   * delegate grant landed), so the slot it took during the boot-ordering window
   * does not stay spent for the remaining TTL on a peer that no longer needs it.
   */
  release(remotePeerId: string): void {
    this.admitted.delete(remotePeerId);
  }

  private prune(now: number): void {
    for (const [peerId, expiresAt] of this.admitted) {
      if (expiresAt <= now) {
        this.admitted.delete(peerId);
      }
    }
  }
}

/**
 * Build the control node's connection gater: the caller-supplied gater (if any)
 * with membership admission composed onto `denyInboundEncryptedConnection` —
 * the earliest checkpoint where the remote's authenticated PeerId is known —
 * and reservation admission composed onto `denyInboundRelayReservation` — the
 * hook the circuit-relay server consults per RESERVE request (inert on a node
 * whose relay server is off; libp2p never calls it there).
 *
 * `denyDialPeer` is composed too, but ONLY for the bring-up quiet period (see
 * the module doc): outside that window outbound dials are never gated by
 * membership — this node decides for itself who to talk to.
 *
 * Composition semantics: every hook of `base` is preserved as-is; on the three
 * composed hooks a deny from the base gater denies, and so does the quiet
 * period. The admission policy never denies a connection. A policy error — or a
 * decision slower than `decisionTimeoutMs` — takes the fail-open outcome
 * (connection admitted outright / reservation admitted, see module doc); the
 * base gater's verdict is still honored first.
 *
 * An `'admit-provisionally'` verdict admits the connection and arms a
 * `provisionalDeadlineMs` timer against it. When the timer fires the policy is
 * asked again, and the underlying `MultiaddrConnection` is closed unless it now
 * answers `'admit'`; a reservation for that peer ADMITTED at the reservation
 * hook disarms the timer first.
 *
 * NOTE: `base` is spread, so a gater passed as a CLASS INSTANCE would lose its
 * prototype methods; every caller in this repo (and libp2p's own default)
 * supplies a plain object. If a class-based gater ever shows up, delegate
 * per-hook instead of spreading.
 *
 * Deny timing, as observed by the denied dialer (a quiet-period or base-gater
 * deny): noise negotiates the muxer in the security handshake's early data, so
 * the DIALER's upgrade may complete (its `dial()` resolves) before this
 * receiver-side hook runs. The deny then aborts the receiver's upgrade — the
 * receiver never registers the connection and never creates its muxer, so no
 * protocol can ever be negotiated — and the dialer sees its "open" connection
 * close moments later.
 *
 * Control node only: strand cohort nodes legitimately connect cross-party
 * peers, so cadre membership never gates them. An OPEN strand's node receives
 * the raw configured gater unchanged; a CLOSED strand's node composes its own
 * revoked-peer denial onto it instead — a deny-list on positive revocation
 * evidence, not this module's membership admission — see
 * `strand-revocation-enforcer.ts`.
 */
export function createMembershipConnectionGater(
  policy: InboundAdmissionPolicy,
  base?: ConnectionGater,
  decisionTimeoutMs: number = ADMISSION_DECISION_TIMEOUT_MS,
  provisionalDeadlineMs: number = PROVISIONAL_ADMISSION_DEADLINE_MS
): ConnectionGater {
  const decideInbound = (remotePeerId: string): Promise<InboundConnectionVerdict> => decideWithinDeadline(
    () => policy.admitInbound(remotePeerId), 'admit', decisionTimeoutMs, `admitInbound(${remotePeerId})`
  );
  const provisional = new ProvisionalAdmissions(provisionalDeadlineMs, decideInbound);
  const quiet = (): boolean => policy.bringUpInFlight?.() ?? false;
  return {
    ...base,
    denyDialPeer: async (peerId: PeerId): Promise<boolean> => {
      if (await base?.denyDialPeer?.(peerId)) {
        return true;
      }
      if (quiet()) {
        log('Control-database bring-up in flight — refusing the outbound dial to %s', peerId.toString());
        return true;
      }
      return false;
    },
    denyInboundEncryptedConnection: async (peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> => {
      if (await base?.denyInboundEncryptedConnection?.(peerId, maConn)) {
        return true;
      }
      if (quiet()) {
        log('Control-database bring-up in flight — refusing the inbound connection from %s', peerId.toString());
        return true;
      }
      const remotePeerId = peerId.toString();
      let verdict: InboundConnectionVerdict;
      try {
        verdict = await decideInbound(remotePeerId);
      } catch (error) {
        log('admitInbound threw for %s — admitting (fail-open; stream gates decide): %o', remotePeerId, error);
        return false;
      }
      if (verdict === 'admit-provisionally') {
        provisional.arm(remotePeerId, maConn);
      }
      return false;
    },
    denyInboundRelayReservation: async (peerId: PeerId): Promise<boolean> => {
      if (await base?.denyInboundRelayReservation?.(peerId)) {
        return true;
      }
      const remotePeerId = peerId.toString();
      let admitted: boolean;
      try {
        admitted = await decideWithinDeadline(
          () => policy.admitRelayReservation(remotePeerId), true, decisionTimeoutMs, `admitRelayReservation(${remotePeerId})`
        );
      } catch (error) {
        log('admitRelayReservation threw for %s — admitting (fail-open): %o', remotePeerId, error);
        admitted = true;
      }
      if (admitted) {
        provisional.disarm(remotePeerId);
      }
      return !admitted;
    }
  };
}

/**
 * Run one admission decision under `timeoutMs`, resolving to `fallback` (the
 * fail-open outcome) if it has not settled in time — see
 * {@link ADMISSION_DECISION_TIMEOUT_MS} for why an unbounded await is not safe
 * on the connection hook. The timer is always cleared so a decided call never
 * holds the event loop open. Exported for the strand revoked-peer gate
 * (`strand-revocation-enforcer.ts`), which bounds its connection hooks with the
 * same fail-open contract.
 */
export async function decideWithinDeadline<T>(
  decide: () => Promise<T> | T,
  fallback: T,
  timeoutMs: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(decide),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          log('%s exceeded %dms — taking the fail-open outcome (stream gates decide)', what, timeoutMs);
          resolve(fallback);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One armed provisional deadline: the connection it may close, and its timer. */
interface ProvisionalAdmission {
  maConn: MultiaddrConnection;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The deadlines of `'admit-provisionally'` connections, keyed by remote peerId
 * (a Set per peer — one peer can hold several in-flight connections). `arm`
 * starts a timer that re-asks the policy and closes the connection unless it now
 * admits; `disarm` (called when a reservation for that peer is admitted) cancels
 * every pending deadline for the peer, one whose question is already out
 * included. Timers are unref'd so an armed deadline never holds a process open.
 *
 * Disarming is final for the connections it cancelled: a peer that reserved
 * once and then lets its reservation lapse keeps a mute connection (the
 * fail-closed stream gates refuse it every members-only protocol) until either
 * side closes it. Bounded — only a peer the reservation policy already admitted
 * can reach that state, so unplaceable peers are bounded by the budget cap.
 */
class ProvisionalAdmissions {
  private readonly byPeer = new Map<string, Set<ProvisionalAdmission>>();

  constructor(
    private readonly deadlineMs: number,
    private readonly decide: (remotePeerId: string) => Promise<InboundConnectionVerdict>
  ) {}

  arm(remotePeerId: string, maConn: MultiaddrConnection): void {
    const entry: ProvisionalAdmission = {
      maConn,
      timer: setTimeout(() => void this.expire(remotePeerId, entry), this.deadlineMs)
    };
    (entry.timer as { unref?: () => void }).unref?.();
    let entries = this.byPeer.get(remotePeerId);
    if (!entries) {
      entries = new Set();
      this.byPeer.set(remotePeerId, entries);
    }
    entries.add(entry);
    log('Admitted %s provisionally — closing the connection in %dms unless it is admissible by then', remotePeerId, this.deadlineMs);
  }

  disarm(remotePeerId: string): void {
    const entries = this.byPeer.get(remotePeerId);
    if (!entries) {
      return;
    }
    this.byPeer.delete(remotePeerId);
    for (const entry of entries) {
      clearTimeout(entry.timer);
    }
  }

  private async expire(remotePeerId: string, entry: ProvisionalAdmission): Promise<void> {
    if (entry.maConn.status !== 'open') {
      this.release(remotePeerId, entry);
      return;
    }
    const verdict = await this.recheck(remotePeerId);
    // False when a reservation admitted while the question was out disarmed this deadline.
    if (!this.release(remotePeerId, entry)) {
      return;
    }
    if (verdict === 'admit') {
      log('%s is admissible at its provisional deadline — keeping the connection', remotePeerId);
      return;
    }
    log('Provisional admission expired for %s — still unplaced after %dms, closing the connection', remotePeerId, this.deadlineMs);
    await this.drop(remotePeerId, entry.maConn);
  }

  /** The policy's answer at the deadline; a throw keeps the connection (fail-open). */
  private async recheck(remotePeerId: string): Promise<InboundConnectionVerdict> {
    try {
      return await this.decide(remotePeerId);
    } catch (error) {
      log('admitInbound threw for %s at its provisional deadline — keeping the connection (fail-open): %o', remotePeerId, error);
      return 'admit';
    }
  }

  /** Forget `entry`; false when a `disarm` already took it. */
  private release(remotePeerId: string, entry: ProvisionalAdmission): boolean {
    const entries = this.byPeer.get(remotePeerId);
    if (!entries?.delete(entry)) {
      return false;
    }
    if (entries.size === 0) {
      this.byPeer.delete(remotePeerId);
    }
    return true;
  }

  /**
   * End an expired provisional connection: a bounded graceful close, with
   * `abort()` only as the escalation. The order cannot be reversed — `abort()`
   * marks the connection `aborted`, and `close()` returns immediately on any
   * status that is not `open`, so aborting first would make the close a silent
   * no-op. Closing a connection the peer already dropped returns at once
   * without throwing, so the fallback stays unreached in the ordinary case.
   */
  private async drop(remotePeerId: string, maConn: MultiaddrConnection): Promise<void> {
    try {
      await withDeadline(
        PROVISIONAL_ADMISSION_CLOSE_TIMEOUT_MS,
        `provisional close for ${remotePeerId}`,
        (signal) => maConn.close({ signal })
      );
      return;
    } catch (error) {
      log('Closing the expired provisional connection from %s failed — aborting: %o', remotePeerId, error);
    }
    // NOTE: this fallback cannot actually free a WebSocket. `@libp2p/websockets`'
    // `sendReset()` calls `websocket.close(1006)`, and 1006 is a reserved code
    // RFC 6455 forbids an endpoint from sending, so `ws` throws and
    // `AbstractMessageStream.abort()` swallows it — the local end flips to
    // `aborted` while the socket stays up. Measured against
    // @libp2p/websockets@10.1.3 (see tickets/blocked/report-libp2p-websockets-abort-close-code.md).
    // `MultiaddrConnection` exposes no way down to the raw socket, so this is as
    // far as this layer can go. Revisit — drop the fallback, or go back to a
    // plain `abort()` — once that transport sends a legal reset code.
    try {
      maConn.abort(new Error(`provisional admission expired: still unplaced after ${this.deadlineMs}ms`));
    } catch (error) {
      log('Aborting the expired provisional connection from %s threw: %o', remotePeerId, error);
    }
  }
}
