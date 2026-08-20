/**
 * Control-network inbound admission gates (defense-in-depth): the
 * encrypted-connection checkpoint and the circuit-relay reservation checkpoint.
 *
 * Layer 2 of the membership enforcement chain: the PRIMARY gates are per-stream
 * — every sensitive sereus control protocol rejects a peer that fails the
 * voucher-anchored membership check (wake and strand-addr via
 * `CadreNode.isAuthorizedMember`; the Optimystic control-DB protocols via the
 * materialized-snapshot gate `CadreNode.authorizeInboundControlStream`), and
 * the replicated rows an outsider *can* still write are disbelieved at read
 * time. This module adds the opportunistic connection-level layer on top: a
 * peer this node can positively determine is NOT authorized is refused at the
 * encrypted-connection checkpoint, before any protocol negotiation, so a
 * known-nothing outsider is never even in the conversation — EXCEPT on a node
 * that runs the circuit-relay server, where the refusal moves to the
 * relay-reservation checkpoint instead (see "The relay-reservation seam").
 *
 * ## The stranger allowlist (the ONE place it is defined)
 *
 * A libp2p connection gater decides per CONNECTION, before protocols are
 * negotiated, so "allow seed, deny repo" cannot be expressed here — instead the
 * policy admits a connection whenever a legitimate stranger interaction could be
 * riding it, and the per-stream gates take over. The complete set of protocols a
 * NOT-yet-authorized peer may legitimately speak on a control node is:
 *
 *  - `/sereus/seed/1.0.0` ({@link SEED_PROTOCOL}) — enrollment seed delivery.
 *    An owner dials a brand-new node to seed it (the new node has no members
 *    yet, so its gate is inert), and an invited phone dials the owner before it
 *    is authorized (admitted via the enrollment window `CadreNode.createInvite`
 *    opens). The handler's own trust decision is the anchored seed-trust policy.
 *  - `/sereus/formation/1.0.0` ({@link FORMATION_PROTOCOL}) — cross-party
 *    strand formation via open invitations. Stranger-facing BY DESIGN: the
 *    initiator is another party, and its token is only checkable inside the
 *    protocol. The exemption is therefore keyed on EXPECTATION of a stranger,
 *    not capability to serve one: stranger denial is suspended only while this
 *    node has at least one UNEXPIRED, NOT-FULLY-CONSUMED open invitation
 *    outstanding (`StrandSolicitationService.hasOutstandingInvitation` — the
 *    tokens this process minted or published, plus any still-redeemable
 *    `FormationInvite` row the usage recorder can see). Merely registering the
 *    responder (`CadreNode.initializeStrandSolicitation`) does NOT suspend it,
 *    so an app that registers eagerly at node bring-up keeps a live gate. The
 *    handler's own trust decision remains the per-token check, which is
 *    strictly finer than this one: a peer admitted here can still be rejected
 *    in-protocol for a bogus or spent token.
 *
 * There is one further connection-level carve-out, which is NOT a protocol
 * exemption and needs no stranger window:
 *
 *  - **Announced delegate peers** (`delegate-admission.ts`). A member's strand
 *    node runs as a separate libp2p identity whose peerId no sibling can
 *    recompute. Before starting a strand node, a member's control node
 *    announces that peerId over the already-authenticated strand-addr RPC, and
 *    the receiver holds a short-lived grant for it
 *    (`CadreNode.grantDelegateAdmission`). The grant admits the CONNECTION,
 *    admits the peer's RESERVATION at the seam below (without spending the
 *    unauthorized budget), and nothing else — it is deliberately invisible to
 *    the per-stream gate, so a delegate still gets refused on every
 *    members-only protocol.
 *
 * ## The relay-reservation seam
 *
 * A circuit-relay reservation is established by the reserving peer DIALING the
 * relay, so at the relay it is an inbound connection — and killing that
 * connection kills the reservation. For a genuine member whose `CadrePeer` row
 * has not yet replicated to this node, a connection-level deny here is NOT
 * self-healing the way a data connection's is: an outbound reconcile dial
 * re-establishes a data link, but no outbound dial can grant the REMOTE peer a
 * reservation, and a relay-only peer has no address of its own to dial back —
 * the reservation IS its address. Boot ordering makes the window ordinary (a
 * node's circuit listener runs inside `libp2p.start()`, before its own row
 * could have replicated anywhere), and a stalled replication makes it
 * unbounded. So the relay would be answering a RELAY question ("may this peer
 * use my forwarding capacity?") with a MEMBERSHIP answer, at a checkpoint where
 * a wrong answer is unrecoverable.
 *
 * On a node whose relay server is enabled the two questions are separated:
 *
 *  - The policy returns `'admit-for-relay'` instead of `'deny'`, and the
 *    connection is ADMITTED. The fail-closed per-stream gates still refuse such
 *    a peer every members-only protocol, so it gains identify/ping and the
 *    relay hop protocol, nothing else.
 *  - The reservation itself is decided at libp2p's
 *    `denyInboundRelayReservation` hook (the circuit-relay server consults it
 *    per RESERVE request): the policy admits members, delegates and configured
 *    infra outright, and admits peers it cannot place only within a bounded
 *    budget ({@link UnauthorizedReservationBudget}) — a member whose row is in
 *    flight always finds a slot under any sane cap, while outsiders cannot
 *    annex the party's relay capacity.
 *  - An `'admit-for-relay'` connection that is NOT reserving is dropped: it has
 *    {@link RELAY_ADMISSION_RESERVE_DEADLINE_MS} to get a reservation ADMITTED
 *    at that hook, after which the underlying connection is aborted. The
 *    guarantee above thus weakens on relay-enabled nodes from "never in the
 *    conversation" to "in it briefly, and can speak nothing".
 *
 * The deadline clears on reservation ADMISSION, not on the reservation's own
 * success: this gate cannot observe the server-side `reserve()` outcome, so a
 * peer whose admitted reservation is then refused for server capacity keeps its
 * connection until either side closes it — bounded and mute, so harmless.
 *
 * Everything else a control node handles — the Optimystic control-DB protocols
 * (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}/…`), wake
 * (`/sereus/strand-wake/1.0.0`), and strand-addr (`/sereus/strand-addr/1.0.0`)
 * — is members-only, and every one of them enforces that per-stream. Wake and
 * strand-addr check `isAuthorizedMember` inside their handlers; the four
 * control-DB protocols are gated by the fail-closed
 * `CadreNode.authorizeInboundControlStream` (wired as libp2p's
 * `authorizeInboundStream` upstream hook), which judges each inbound stream
 * against the MATERIALIZED authorized-peer snapshot — synchronous and
 * in-memory, because a live DB read from inside the gate would deadlock into
 * mutual denial. The two layers complement, not duplicate: this connection
 * gate is fail-open over a live DB read (deny only on positive proof of an
 * outsider), the stream gate is fail-closed over the snapshot and has NO
 * stranger carve-outs — an enrollment window admits a stranger's connection
 * for seed delivery, yet its repo streams are still refused.
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
 * after bring-up (`relay-addrs.ts`), and the control-cohort reconcile pass is
 * scheduled post-start. This window is what makes that a property rather than an
 * accident of ordering — the live case it actually catches is
 * `controlNetwork.bootstrapNodes`, where `@libp2p/bootstrap` emits its discovery
 * events ~1 s after `libp2p.start()` and the connection manager auto-dials from
 * there, which is a race bring-up wins only while raw-storage latency stays low.
 *
 * A denial here costs a retry, not a partition: libp2p's connection manager
 * re-dials on its auto-dial cadence, the reservation supervisor re-drives, and a
 * denied inbound peer reconnects. The window opens on bring-up FAILURE too (via
 * `CadreNode.cleanup`), so teardown is never gated.
 *
 * ## Fail-open, deliberately
 *
 * Outside that window this layer only ever denies on a POSITIVE determination of
 * "unauthorized outsider while no stranger path is open". Any error, missing
 * dependency, or ambiguous state admits the connection (and the reservation) and
 * defers to the fail-closed stream gates — a DB hiccup must not partition a
 * legitimate cadre.
 */

import debug from 'debug';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import { SEED_PROTOCOL } from './seed-bootstrap.js';
import { FORMATION_PROTOCOL } from './strand-formation-protocol.js';

const log = debug('sereus:cadre:connection-gater');

/**
 * The protocols a not-yet-authorized peer may legitimately speak on a control
 * node (see the module doc above for why each is open and where its own trust
 * decision lives). Exported as the single reference point so the allowlist
 * cannot silently drift across modules.
 */
export const STRANGER_OPEN_PROTOCOLS: readonly string[] = [SEED_PROTOCOL, FORMATION_PROTOCOL];

/**
 * How long `CadreNode.createInvite` holds the inbound gate open for strangers
 * when the invite carries no explicit expiry: the invitee must dial in before
 * it is authorized, and an expiry-less invite gives the gate no bound of its
 * own. Redeeming after this window still works once the owner re-mints (or the
 * caller re-opens the window via `CadreNode.openEnrollmentWindow`).
 */
export const DEFAULT_ENROLLMENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Deadline for one admission decision, after which the fail-open outcome is
 * used (connection admitted / reservation admitted).
 *
 * libp2p awaits `denyInboundEncryptedConnection` inside the inbound upgrade
 * WITHOUT racing its inbound-upgrade timeout signal (unlike the pre-encryption
 * `denyInboundConnection` hook), so a decision that never settles wedges that
 * upgrade forever — the connection-manager's inbound-upgrade slot is taken by
 * `acceptIncomingConnection` and released in the `finally` that never runs. The
 * real policy reads the control DB (`listAuthorizedMembers`), which can pull
 * over the network, so "never settles" is reachable. Bounding it here keeps the
 * fail-open contract honest: a slow decision admits rather than silently
 * failing closed (or not at all).
 */
export const ADMISSION_DECISION_TIMEOUT_MS = 2_000;

/**
 * How long an `'admit-for-relay'` connection may exist without a relay
 * reservation being ADMITTED at the `denyInboundRelayReservation` hook, after
 * which the gate aborts the underlying connection. A reserving client asks for
 * its slot immediately after the connection upgrades (`relay-reservation.ts`
 * dials and requests in one drive; a strand node's configured circuit listener
 * does the same from inside its own `listen()`), so a connection idle past this
 * deadline is not reserving.
 */
export const RELAY_ADMISSION_RESERVE_DEADLINE_MS = 5_000;

/**
 * Default cap on concurrent relay reservations held by peers the membership
 * check could not place (see {@link UnauthorizedReservationBudget}). Small on
 * purpose: it exists for the handful of genuine members whose rows are still
 * in flight, not as public relay capacity. Overridable per node via
 * `network.unauthorizedRelayReservationCap` (0 refuses every unauthorized
 * reservation — the strict pre-seam posture).
 *
 * NOTE: this cap shares the relay server's own reservation store, whose default
 * size is 15 (`@libp2p/circuit-relay-v2`'s `DEFAULT_MAX_RESERVATION_STORE_SIZE`);
 * unplaced peers may therefore occupy up to this many of those slots, and the
 * rest are what members and delegates compete for. This module cannot read the
 * server's size, so the two are kept apart by hand — if either is raised, keep
 * this one well under the store's, or a fleet of unplaceable peers can crowd
 * genuine members out of the server's own store (which the gate cannot override).
 */
export const MAX_UNAUTHORIZED_RELAY_RESERVATIONS = 8;

/**
 * How long one {@link UnauthorizedReservationBudget} entry occupies a slot
 * without a refresh. Mirrors the relay server's own default reservation TTL
 * (`@libp2p/circuit-relay-v2`'s `DEFAULT_MAX_RESERVATION_TTL`, 2 h): the server
 * holds an unrefreshed reservation exactly that long, and a live reserver
 * re-requests (re-hitting the admission hook, refreshing its entry) well before
 * expiry — so the live entry count tracks the server's own occupancy without
 * this module reaching into the server's reservation store.
 *
 * NOTE: a mirror, not a live coupling — if the relay server is ever configured
 * with a non-default `reservationTtl` (db-p2p's `relayServerInit`), update this
 * constant alongside it or the budget's occupancy drifts from the server's.
 */
export const UNAUTHORIZED_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The connection-level outcome of the admission policy:
 *  - `'admit'` — a peer with a legitimate claim on the connection (member,
 *    delegate, infra, open stranger window, or any fail-open state).
 *  - `'deny'` — positively an outsider, and this node runs no relay server, so
 *    the connection can carry nothing legitimate.
 *  - `'admit-for-relay'` — positively an outsider (or an unreplicated member —
 *    indistinguishable), but this node runs the relay server: admit the
 *    connection so a reservation can be asked for, decide at the reservation
 *    seam, and drop the connection if no reservation is admitted in time.
 */
export type InboundConnectionVerdict = 'admit' | 'deny' | 'admit-for-relay';

/**
 * The admission decisions the gate defers to — implemented by
 * `CadreNode.admitInboundControlConnection` /
 * `CadreNode.admitControlRelayReservation` (enrollment windows, anchor state,
 * bootstrap infra, delegate grants, the authorized-member set, the
 * unauthorized-reservation budget). Kept injectable so the gater's
 * composition/fail-open behavior is unit-testable without a full node.
 */
export interface InboundAdmissionPolicy {
  /** Verdict on an inbound encrypted connection from this peer. */
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
 * peer takes a free slot or is refused. Entries expire after `ttlMs` (see
 * {@link UNAUTHORIZED_RESERVATION_TTL_MS} for why that mirrors the relay
 * server's own hold). Injectable `now` keeps expiry testable without fake
 * timers. Authorized members and delegates are never run through this — the
 * policy admits them before consulting the budget, and `release`s the slot such
 * a peer took while it was still unplaceable, so the boot-ordering window a
 * member passes through costs the budget nothing once its row lands.
 */
export class UnauthorizedReservationBudget {
  private readonly admitted = new Map<string, number>();

  constructor(
    private readonly cap: number = MAX_UNAUTHORIZED_RELAY_RESERVATIONS,
    private readonly ttlMs: number = UNAUTHORIZED_RESERVATION_TTL_MS
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
 * composed hooks a deny from EITHER the base gater or the admission policy
 * denies. A policy error — or a decision slower than `decisionTimeoutMs` —
 * takes the fail-open outcome (connection admitted / reservation admitted, see
 * module doc); the base gater's verdict is still honored first.
 *
 * An `'admit-for-relay'` verdict admits the connection and arms a
 * `reserveDeadlineMs` timer against it; the timer is disarmed when a
 * reservation for that peer is ADMITTED at the reservation hook, and aborts the
 * underlying `MultiaddrConnection` when it fires first.
 *
 * NOTE: `base` is spread, so a gater passed as a CLASS INSTANCE would lose its
 * prototype methods; every caller in this repo (and libp2p's own default)
 * supplies a plain object. If a class-based gater ever shows up, delegate
 * per-hook instead of spreading.
 *
 * Deny timing, as observed by the denied dialer: noise negotiates the muxer in
 * the security handshake's early data, so the DIALER's upgrade may complete
 * (its `dial()` resolves) before this receiver-side hook runs. The deny then
 * aborts the receiver's upgrade — the receiver never registers the connection
 * and never creates its muxer, so no protocol can ever be negotiated — and the
 * dialer sees its "open" connection close moments later.
 *
 * Control node only: strand cohort nodes legitimately connect cross-party
 * peers, so `CadreNode` threads the raw configured gater to them unchanged.
 */
export function createMembershipConnectionGater(
  policy: InboundAdmissionPolicy,
  base?: ConnectionGater,
  decisionTimeoutMs: number = ADMISSION_DECISION_TIMEOUT_MS,
  reserveDeadlineMs: number = RELAY_ADMISSION_RESERVE_DEADLINE_MS
): ConnectionGater {
  const pendingReservations = new PendingReserveDeadlines(reserveDeadlineMs);
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
        verdict = await decideWithinDeadline(
          () => policy.admitInbound(remotePeerId), 'admit', decisionTimeoutMs, `admitInbound(${remotePeerId})`
        );
      } catch (error) {
        log('admitInbound threw for %s — admitting (fail-open; stream gates decide): %o', remotePeerId, error);
        return false;
      }
      if (verdict === 'admit-for-relay') {
        pendingReservations.arm(remotePeerId, maConn);
        return false;
      }
      return verdict === 'deny';
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
        pendingReservations.disarm(remotePeerId);
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
 * holds the event loop open.
 */
async function decideWithinDeadline<T>(
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

/** One armed not-reserving deadline: the connection it will abort, and its timer. */
interface PendingReserveDeadline {
  maConn: MultiaddrConnection;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The not-reserving deadlines for `'admit-for-relay'` connections, keyed by
 * remote peerId (a Set per peer — one peer can hold several in-flight
 * connections). `arm` starts a timer that aborts the connection; `disarm`
 * (called when a reservation for that peer is admitted) cancels every pending
 * timer for the peer. Timers are unref'd so an armed deadline never holds a
 * process open, and a timer that fires against an already-closed connection is
 * a swallowed no-op.
 *
 * Disarming is final for the connections it cancelled: a peer that reserved
 * once and then lets its reservation lapse keeps a mute connection (the
 * fail-closed stream gates refuse it every members-only protocol) until either
 * side closes it. Bounded — only a peer the reservation policy already admitted
 * can reach that state, so unplaceable peers are bounded by the budget cap.
 */
class PendingReserveDeadlines {
  private readonly byPeer = new Map<string, Set<PendingReserveDeadline>>();

  constructor(private readonly deadlineMs: number) {}

  arm(remotePeerId: string, maConn: MultiaddrConnection): void {
    const entry: PendingReserveDeadline = {
      maConn,
      timer: setTimeout(() => this.expire(remotePeerId, entry), this.deadlineMs)
    };
    (entry.timer as { unref?: () => void }).unref?.();
    let entries = this.byPeer.get(remotePeerId);
    if (!entries) {
      entries = new Set();
      this.byPeer.set(remotePeerId, entries);
    }
    entries.add(entry);
    log('Admitted %s for relay only — dropping the connection unless a reservation is admitted within %dms', remotePeerId, this.deadlineMs);
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

  private expire(remotePeerId: string, entry: PendingReserveDeadline): void {
    const entries = this.byPeer.get(remotePeerId);
    entries?.delete(entry);
    if (entries?.size === 0) {
      this.byPeer.delete(remotePeerId);
    }
    log('Relay-only admission expired for %s — no reservation admitted within %dms, aborting the connection', remotePeerId, this.deadlineMs);
    try {
      entry.maConn.abort(new Error(`relay-only admission expired: no relay reservation admitted within ${this.deadlineMs}ms`));
    } catch (error) {
      // Aborting a connection that already closed on its own is not a failure.
      log('Aborting the expired relay-only connection from %s threw: %o', remotePeerId, error);
    }
  }
}
