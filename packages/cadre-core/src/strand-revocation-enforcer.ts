/**
 * Strand revoked-peer enforcement: a per-strand deny gate that refuses the
 * network nodes of a REMOVED party, so removal means "we stop talking to you"
 * rather than only deleting a row.
 *
 * ## The deny set is revocation-keyed, never membership-keyed
 *
 * A strand node maintains a materialized in-memory set of revoked peer ids:
 * every `Strand.MemberPeer.PeerId` whose `MemberKey` has no live `Strand.Member`
 * row. `MemberPeer.MemberExists` runs on insert, so an orphaned binding can only
 * mean "this member existed and was removed" — it is exactly the durable,
 * replicated record of a removed party's machines. Everything NOT in the set is
 * admitted. Deliberate consequences:
 *
 * - **Open strands are untouched.** `Member`/`MemberPeer` carry `OnlyClosed`
 *   checks, so an open strand has no rows and the set is empty — and
 *   `StrandInstanceManager` additionally skips arming this enforcer entirely for
 *   `Type !== 'c'`, so an open strand does not even poll.
 * - **A joining party mid-admission is admitted** (it has no orphaned binding).
 *   An allowlist ("only peers bound to live members") was considered and
 *   rejected: a joiner's first membership writes must travel through the very
 *   cohort an allowlist would close to it — the same mutual-denial trap the
 *   control network's gater doc describes (`membership-connection-gater.ts`),
 *   with no enrollment window to carve out. A deny-list on positive evidence
 *   has no such trap.
 * - **Stale-view failure direction: fail-open.** A remaining member that has not
 *   yet replicated the revocation keeps serving the removed party until the
 *   tombstoned state arrives — bounded by replication, consistent with
 *   "revocation is forward-looking". The opposite error (denying a legitimate
 *   member) is only reachable for a revoked-then-re-admitted party at a node
 *   that saw the revoke but not the re-add; the re-add gives the member key a
 *   live `Member` row again, which removes its peers from the deny set as the
 *   row replicates — self-healing, and the re-adding manager's own node updates
 *   first, so the heal never depends on talking to the peer being wrongly denied.
 * - **Orphaned `MemberPeer` rows are load-bearing**: they ARE the deny record —
 *   the `Strand.Revocation` tombstone keeps only the stamp, not the peer id — so
 *   nothing here (or anywhere) tombstones or auto-cleans them at revocation.
 *   The manager-cleanup path (`removeMemberPeer`'s manager branch) stays as the
 *   only way to clear a wrongly-registered binding, and clearing an orphan
 *   forgets the denial (the NOTE at that branch says so).
 *
 * ## Removal cuts LIVE sessions too — the refresh IS the teardown seam
 *
 * Refusing NEW connections only half-honors "no longer be answered to or
 * communicated with": a long-lived strand connection may never re-dial, so
 * without teardown a removed party keeps whatever session it already holds.
 * There is no push notification to hang teardown off — a REPLICATED revocation
 * arrives with no change event (the strand database has no reactive
 * subscription; `StrandWatcher` polls for the same reason), and a LOCAL
 * `revokeMember`/`leaveStrand` writes through a bare `Database` handle this
 * runtime never sees — so teardown rides the snapshot refresh itself, with
 * `refresh()` exposed for immediacy
 * (`StrandInstanceManager.refreshRevocationEnforcement` →
 * `CadreNode.refreshRevocationEnforcement`).
 *
 * The sweep is driven by MEMBERSHIP in the deny set, never by an
 * entered-the-set diff: every refresh hangs up every currently-connected
 * revoked peer, so a resume, a crashed refresh, or a connection established
 * between two refreshes cannot leave a session standing (a diff would be a
 * strict subset of this, so none is kept). A peer with no open connection is
 * simply not swept, and a failed `hangUp` is logged, never thrown — the next
 * refresh retries it. `hangUp` closes DIRECT and RELAYED connections alike, and
 * on a strand node running the relay server it also drops any reservation the
 * revoked peer holds there (a reservation dies with its connection — see the
 * relay-seam doc in `membership-connection-gater.ts`).
 *
 * Teardown is also what stops OUTBOUND traffic. The gate is one-directional —
 * `authorizeStream` judges streams the revoked peer opens to US — so nothing
 * else prevents this node from pushing over an already-open connection, which
 * `PeerJoinBackfill` does for that connection's whole life. Closing the
 * connection stops both directions at once, which is why no separate outbound
 * gate exists.
 *
 * If this node's OWN peer id is in the set, it was itself removed (or it left —
 * a voluntary departure files the same tombstone). Nothing is torn down for
 * that: the other side's gate already refuses us, and every other revoked peer
 * is still swept. Instead `onSelfRevoked` fires ONCE per entry into the set
 * (re-armed if the party is re-admitted, so a second removal signals again),
 * which `CadreNode` surfaces as `strand:revoked` so the embedding app decides
 * what to do — this module never stops or leaves a strand on its own.
 * Best-effort by nature: a removed party learns only if the tombstone
 * replicated to it before the cut.
 *
 * ## What transfers from the control gater (`membership-connection-gater.ts`)
 *
 * Transfers: the two-layer shape (fail-closed per-stream gate as PRIMARY, an
 * opportunistic connection-level deny on top), the synchronous in-memory
 * snapshot judged by the stream gate (a live DB read inside a gate deadlocks —
 * the same argument as the control node's `authorizeInboundControlStream`), the
 * fail-open-on-error/timeout posture for the connection hooks
 * (`decideWithinDeadline`, reused as-is), and the "compose over the caller's
 * gater, every base hook preserved" mechanics.
 *
 * Does NOT transfer — the relay-reservation seam (`'admit-for-relay'` + the
 * unauthorized budget). That machinery exists because the control gate denies on
 * ABSENCE of placement, where a member whose row is in flight is
 * indistinguishable from an outsider and a wrong reservation deny is
 * unrecoverable. This gate denies on POSITIVE revocation evidence, so a
 * reservation deny is never that kind of wrong answer; the one stale-wrong case
 * (a missed re-add) heals via replication as above. `denyInboundRelayReservation`
 * here is therefore a plain "deny iff revoked" — no budget, no admit-for-relay
 * verdict, no reserve deadline.
 *
 * Does NOT transfer — the bring-up quiet period. A strand node's DB bring-up
 * NEEDS its cross-party cohort connections; this enforcer simply starts with an
 * empty snapshot (admit everything) until its first successful read — the same
 * fail-open posture as everywhere else here.
 *
 * Does NOT transfer — every stranger carve-out (enrollment window, formation
 * window, delegate grants). None of those protocols exist on a strand node.
 *
 * Unlike the control stream gate, no empty-snapshot carve-out is needed: an
 * empty deny set means "nothing revoked", which correctly admits everyone — the
 * deny-list shape makes the cold-start case and the steady case the same code
 * path.
 */

import debug from 'debug';
import type { ConnectionGater, PeerId, MultiaddrConnection } from '@libp2p/interface';
import type { Database } from '@quereus/quereus';
import { ADMISSION_DECISION_TIMEOUT_MS, decideWithinDeadline } from './membership-connection-gater.js';

const log = debug('sereus:cadre:strand-revocation');

/**
 * Default cadence of the deny-set refresh. Bounded staleness is the accepted
 * failure direction (see the module doc's stale-view paragraph); 30 s keeps a
 * revoked peer's post-replication admit window in the same order as the
 * replication delay itself. Overridable via
 * {@link StrandRevocationEnforcementConfig.pollIntervalMs}.
 */
export const DEFAULT_REVOCATION_POLL_INTERVAL_MS = 30_000;

/**
 * Embedder tuning for the strand revoked-peer gate, threaded from
 * `CadreNodeConfig.strandRevocationEnforcement` to
 * `StartStrandConfig.revocationEnforcement` the way the backfill knob is.
 */
export interface StrandRevocationEnforcementConfig {
  /**
   * Default true. False disarms the gate entirely for this node's strands —
   * the pre-existing behaviour (a removed party's peers keep being served).
   */
  enabled?: boolean;
  /** Deny-set refresh cadence, ms. Default {@link DEFAULT_REVOCATION_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
}

/** One `Strand.MemberPeer` row, as the deny-set derivation consumes it. */
export interface StrandMemberPeerBinding {
  memberKey: string;
  peerId: string;
}

/** The membership rows one deny-set derivation reads. */
export interface StrandRevocationRows {
  /** Every live `Strand.Member.Key`. */
  memberKeys: ReadonlySet<string>;
  /** Every `Strand.MemberPeer` row (live-membered and orphaned alike). */
  bindings: readonly StrandMemberPeerBinding[];
}

/**
 * Timer seam so the refresh cadence is testable without fake timers — the
 * injectable-clock idiom of `UnauthorizedReservationBudget`'s `now` argument,
 * shaped for an interval-driven component. The default schedules a real
 * interval and unrefs it so an armed enforcer never holds a process open.
 */
export interface RevocationRefreshScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultScheduler: RevocationRefreshScheduler = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0])
};

/**
 * The minimum of a libp2p node the teardown sweep needs: who WE are, what is
 * open, and how to close it. Deliberately not the node itself, so the sweep
 * unit-tests against a three-property stub; `Libp2p` (hence
 * `Libp2pNodeWithRepo`) satisfies it structurally, which is what
 * `StrandInstanceManager` passes.
 */
export interface StrandRevocationNetwork {
  /** This node's own peer id — how the enforcer recognizes ITSELF in the deny set. */
  readonly peerId: PeerId;
  /** Every open connection. Only `remotePeer` is read — and reused as the hangUp target. */
  getConnections(): readonly { readonly remotePeer: PeerId }[];
  /** Close every connection to `peer`: direct, relayed, and any reservation riding one. */
  hangUp(peer: PeerId): Promise<void>;
}

export interface StrandRevocationEnforcerDeps {
  /** Log tag naming which strand this enforcer serves (the strand id). */
  label: string;
  /**
   * Read the membership rows the deny set is derived from. Injectable so the
   * enforcer unit-tests without a strand database; production wires
   * {@link readStrandRevocationRows} over the strand's live DB. A throw or
   * rejection KEEPS the previous snapshot (never clears it) — the control
   * model, `refreshAuthorizedControlPeers`.
   */
  readRows: () => Promise<StrandRevocationRows>;
  /**
   * Handle on the strand's libp2p node for the teardown sweep, read LAZILY on
   * every sweep — never captured. It has to be: the enforcer is constructed
   * BEFORE the node (the node's options embed the enforcer's predicates), and
   * the node is dropped again on quiesce. Omit it, or return undefined, and the
   * gate still refuses new connections — only teardown of OPEN ones is skipped.
   */
  getNetwork?: () => StrandRevocationNetwork | undefined;
  /**
   * Called ONCE each time this node's own peer id ENTERS the deny set — i.e.
   * this node's party was removed from the strand, or left it. Not re-fired
   * while it stays there; re-armed if the party is re-admitted, so a second
   * removal signals again. Wired by `StrandInstanceManager` through to
   * `CadreNode`'s `strand:revoked` event. A resume rebuilds the enforcer, so a
   * still-revoked strand also legitimately re-fires once per resume. A throw is
   * logged and swallowed — an embedder's handler must not derail the sweep.
   */
  onSelfRevoked?: () => void;
  /** Timer seam; omit for real (unref'd) intervals. */
  scheduler?: RevocationRefreshScheduler;
}

/** Every `Strand.MemberPeer` binding — live-membered and orphaned alike. */
async function scanBindings(db: Database): Promise<StrandMemberPeerBinding[]> {
  const bindings: StrandMemberPeerBinding[] = [];
  for await (const row of db.eval('select MemberKey, PeerId from Strand.MemberPeer')) {
    bindings.push({ memberKey: row.MemberKey as string, peerId: row.PeerId as string });
  }
  return bindings;
}

/** Every live `Strand.Member.Key`. */
async function scanMemberKeys(db: Database): Promise<Set<string>> {
  const memberKeys = new Set<string>();
  for await (const row of db.eval('select Key from Strand.Member')) {
    memberKeys.add(row.Key as string);
  }
  return memberKeys;
}

/**
 * Read the deny-set inputs from a strand database: full-scan
 * `Strand.MemberPeer` and `Strand.Member`, to be joined in JavaScript by the
 * enforcer. Scan-and-filter, never seek — the composite-PK point-lookup
 * unreliability documented at `scanMemberPeers` in `strand-membership-writer.ts`
 * applies, so correctness depends only on each scan returning a superset of the
 * live rows.
 *
 * **Scan order is load-bearing, and it is BINDINGS FIRST.** The two scans are
 * separate reads with nothing holding them to one snapshot, so a write that
 * lands between them is seen by the second scan and not the first. A member
 * joins as `Member` row then `MemberPeer` row (`MemberExists` forces that
 * order), so reading `Member` first would let a join that commits mid-read
 * produce a binding whose member key is absent from the key set — a brand-new
 * member classified as REVOKED, the one fail-CLOSED outcome this module exists
 * to avoid. Reading bindings first inverts the skew: the new binding is simply
 * not in the older bindings snapshot, so the joiner is unclassified and
 * admitted, and a revocation that lands mid-read is still seen (the key is
 * missing from the NEWER key scan). Every skew window then resolves fail-open,
 * matching the module doc.
 *
 * NOTE: two whole-table scans per refresh (default every 30 s per closed
 * strand). Fine at strand scale (a handful of members and bindings); if
 * membership churn ever makes these tables large, the fix is a reliable
 * filtered read — which needs the networked point-lookup gap closed
 * (`debt-composite-pk-point-lookup-unreliable-untracked`) — not a bigger scan.
 */
export async function readStrandRevocationRows(db: Database): Promise<StrandRevocationRows> {
  const bindings = await scanBindings(db);
  const memberKeys = await scanMemberKeys(db);
  return { memberKeys, bindings };
}

/**
 * The per-strand revoked-peer deny set and the synchronous predicates over it.
 *
 * Lifecycle mirrors `PeerJoinBackfill`: created in
 * `StrandInstanceManager.buildStrandRuntime` (closed strands only), started
 * after the strand database initializes, stopped and dropped in
 * `releaseRuntime` — so quiesce → resume rebuilds it with a fresh snapshot.
 * The snapshot starts EMPTY (admit everything) and repopulates on the first
 * successful read; a revoked peer therefore gets a short admit window per
 * resume at the connection level. Accepted: fail-open posture, and resume is
 * never blocked on a refresh.
 */
export class StrandRevocationEnforcer {
  /** The materialized deny set — peer ids with an orphaned binding and no live one. */
  private revokedPeerIds: ReadonlySet<string> = new Set();
  private readonly scheduler: RevocationRefreshScheduler;
  private readonly pollIntervalMs: number;
  /** Tail of the refresh chain — what serializes refreshes (no two reads in flight). */
  private refreshTail: Promise<void> = Promise.resolve();
  private refreshing = false;
  private intervalHandle: unknown;
  private started = false;
  private stopped = false;
  /** Latch for the one-shot self-revocation signal — see {@link StrandRevocationEnforcerDeps.onSelfRevoked}. */
  private selfRevokedSignaled = false;

  constructor(
    private readonly deps: StrandRevocationEnforcerDeps,
    config?: StrandRevocationEnforcementConfig
  ) {
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_REVOCATION_POLL_INTERVAL_MS;
  }

  /** Number of peers currently denied — test/diagnostic surface. */
  get revokedCount(): number {
    return this.revokedPeerIds.size;
  }

  /** Kick an immediate refresh (not awaited — bring-up never blocks on it) and arm the poll. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.refresh();
    this.intervalHandle = this.scheduler.setInterval(() => {
      // Skip a tick while a refresh is in flight rather than queueing behind it —
      // the interval exists to bound staleness, and a stack of queued reads
      // bounds nothing extra. Explicit refresh() calls still chain (see refresh).
      if (!this.refreshing) {
        void this.refresh();
      }
    }, this.pollIntervalMs);
    log('[%s] revocation enforcer started (poll %dms)', this.deps.label, this.pollIntervalMs);
  }

  /** Disarm the poll; a read already in flight completes but its result is discarded. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalHandle != null) {
      this.scheduler.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    log('[%s] revocation enforcer stopped', this.deps.label);
  }

  /**
   * Refresh the deny set now. Never rejects. Serialized: concurrent calls chain,
   * so no two reads overlap, and each explicit call gets a read that STARTS
   * after the call (an on-demand refresh after a revocation commit observes that
   * commit). A failed or slow read keeps the previous snapshot — never clears it.
   */
  refresh(): Promise<void> {
    const run = this.refreshTail.then(() => this.doRefresh());
    this.refreshTail = run;
    return run;
  }

  /**
   * Is `remotePeerId` positively revoked in the current snapshot? Synchronous by
   * design — this is judged inside libp2p gates where an await against the DB
   * would deadlock (the control stream gate's argument).
   */
  isRevoked(remotePeerId: string): boolean {
    return this.revokedPeerIds.has(remotePeerId);
  }

  /**
   * The fail-closed PRIMARY layer: the per-stream predicate wired as
   * `createLibp2pNode({ authorizeInboundStream })`, gating all four
   * `/optimystic/strand-<id>/{repo,cluster,sync,block-transfer}` protocols.
   * Also what catches a revoked peer arriving over a RELAYED connection, or
   * over a connection admitted before the revocation replicated here.
   */
  authorizeStream(remotePeerId: string, _protocol: string): boolean {
    return !this.isRevoked(remotePeerId);
  }

  /**
   * One serialized snapshot rebuild; contains every failure (contract: never rejects).
   *
   * NOTE: nothing here carries a deadline — a `readRows` or a `hangUp` that never
   * settles wedges the refresh chain, which freezes the deny set (the poll skips
   * while `refreshing`, and every later `refresh()` chains behind the stuck one).
   * Both are bounded in practice (Quereus reads settle; libp2p's connection close
   * has its own timeout). If a strand is ever seen with a stale deny set and no
   * refresh log line, wrap both awaits in a timeout rather than hunting further.
   */
  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    this.refreshing = true;
    try {
      const rows = await this.deps.readRows();
      if (this.stopped) return;
      this.revokedPeerIds = deriveRevokedPeerIds(rows);
      log('[%s] deny set refreshed: %d revoked peer(s)', this.deps.label, this.revokedPeerIds.size);
      // Awaited inside the refresh, so an on-demand refresh() resolves only once
      // the cut has been made — that is what makes "revoke, then refresh" an
      // immediate teardown for the caller rather than a scheduled one.
      await this.tearDownRevoked(this.revokedPeerIds);
    } catch (error) {
      log('[%s] deny-set refresh failed — keeping previous snapshot: %o', this.deps.label, error);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Close what is already OPEN to the peers of `revoked` — the teardown half of
   * enforcement (module doc: "Removal cuts LIVE sessions too"). Never rejects:
   * every failure is contained, so the refresh loop survives and simply retries
   * on the next tick.
   *
   * `revoked` is passed IN rather than read off the field, so the sweep judges
   * the exact snapshot its own refresh produced; likewise the connection list is
   * enumerated once, before any await, so a peer re-admitted mid-sweep is at
   * worst hung up once and reconnects.
   *
   * NOTE: dropping the revoked peer from the strand's Optimystic cohort needs no
   * separate action — machines quiesce strands routinely and the remaining cohort
   * keeps committing, so an unreachable cohort peer is already tolerated, and
   * `denyDialPeer` makes the exclusion fast (a local refusal, not a dial timeout).
   * Two residual facts, both accepted: the removed node keeps every block it had
   * already replicated (revocation is forward-looking), and a block whose only
   * holders were the removed party's machines can be unavailable to the rest
   * until repair.
   *
   * NOTE: post-removal commit latency is real and MEASURED, not hypothetical. On
   * the two-parties-by-two-machines fixture in
   * `integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts`
   * the remaining cohort's FIRST write after a cut failed four times with
   * `BlockUnavailableError: … (peers-unreachable)` before committing on the
   * fifth attempt, ~4.1 s in — the cohort still listed the removed party's now
   * unreachable machines and had to downsize to the live holders first. It
   * recovers on its own, so this is a latency cost, not a defect, and it is
   * stated for app authors in `docs/strands.md` → Removing Members. If it ever
   * stops recovering — a write that never commits, or `cluster-fetch:no-quorum` —
   * that is an upstream (Optimystic) conversation, not a workaround here.
   */
  private async tearDownRevoked(revoked: ReadonlySet<string>): Promise<void> {
    if (this.stopped) {
      return;
    }
    const network = this.resolveNetwork();
    if (!network) {
      return;
    }
    const selfPeerId = network.peerId.toString();
    // Judged on EVERY pass, including the empty-set one: leaving the set is what
    // re-arms the signal (see trackSelfRevoked). Being revoked ourselves tears
    // nothing down on our own behalf — the other side's gate already refuses us —
    // so the sweep below still runs for every OTHER revoked peer in the pass.
    this.trackSelfRevoked(revoked.has(selfPeerId));
    if (revoked.size === 0) {
      return;
    }
    for (const peer of connectedRevokedPeers(network, revoked, selfPeerId, this.deps.label)) {
      await this.hangUpRevoked(network, peer);
    }
  }

  /** The lazily-read network handle; an accessor that throws costs this pass only. */
  private resolveNetwork(): StrandRevocationNetwork | undefined {
    try {
      return this.deps.getNetwork?.();
    } catch (error) {
      log('[%s] network handle unavailable — teardown skipped this pass: %o', this.deps.label, error);
      return undefined;
    }
  }

  /** One hangUp, contained: a stopping node or an already-closed connection is not an error here. */
  private async hangUpRevoked(network: StrandRevocationNetwork, peer: PeerId): Promise<void> {
    try {
      await network.hangUp(peer);
      log('[%s] hung up revoked peer %s', this.deps.label, peer.toString());
    } catch (error) {
      log('[%s] hangUp of revoked peer %s failed — next refresh retries: %o', this.deps.label, peer.toString(), error);
    }
  }

  /**
   * Latch {@link StrandRevocationEnforcerDeps.onSelfRevoked} to the TRANSITION
   * into the revoked state: fired once on entry, and re-armed the moment this
   * node is out of the set again — a manager can re-admit a party it removed
   * (a fresh `Member` row makes the orphaned bindings live again), and a second
   * removal has to be reported like the first.
   */
  private trackSelfRevoked(selfRevoked: boolean): void {
    if (!selfRevoked) {
      this.selfRevokedSignaled = false;
      return;
    }
    if (this.selfRevokedSignaled) {
      return;
    }
    this.selfRevokedSignaled = true;
    log('[%s] THIS node is revoked from the strand (removed or left) — signalling', this.deps.label);
    try {
      this.deps.onSelfRevoked?.();
    } catch (error) {
      log('[%s] onSelfRevoked handler threw: %o', this.deps.label, error);
    }
  }
}

/**
 * The distinct peer ids of `network`'s open connections that are in `revoked`,
 * as the `PeerId` objects `hangUp` takes — reusing each connection's own
 * `remotePeer` rather than parsing the string back, so no peer-id codec is
 * needed here. Self is excluded (a node holds no connection to itself, and
 * hanging one up would be nonsense if it did), and a peer connected twice — say
 * one direct and one relayed — yields ONE hangUp, which closes both. A throw
 * mid-enumeration is logged and keeps whatever was collected before it: a
 * partial sweep beats none, and the next refresh re-enumerates anyway.
 */
function connectedRevokedPeers(
  network: StrandRevocationNetwork,
  revoked: ReadonlySet<string>,
  selfPeerId: string,
  label: string
): PeerId[] {
  const targets = new Map<string, PeerId>();
  try {
    for (const connection of network.getConnections()) {
      const remotePeerId = connection.remotePeer.toString();
      if (remotePeerId !== selfPeerId && revoked.has(remotePeerId)) {
        targets.set(remotePeerId, connection.remotePeer);
      }
    }
  } catch (error) {
    log('[%s] connection enumeration failed — teardown skipped this pass: %o', label, error);
  }
  return [...targets.values()];
}

/**
 * Derive the deny set: a peer id is revoked iff it has at least one ORPHANED
 * binding (a `MemberPeer` row whose member key has no live `Member` row) AND no
 * live-membered binding. The second conjunct is what lets a peer id bound to
 * TWO member keys — revoked under one, live under the other — keep serving the
 * live member: a machine serving a live member must not be cut. Per-binding,
 * not per-member, so every machine of a multi-device removed party lands in
 * the set.
 */
function deriveRevokedPeerIds(rows: StrandRevocationRows): Set<string> {
  const orphaned = new Set<string>();
  const live = new Set<string>();
  for (const binding of rows.bindings) {
    (rows.memberKeys.has(binding.memberKey) ? live : orphaned).add(binding.peerId);
  }
  for (const peerId of live) {
    orphaned.delete(peerId);
  }
  return orphaned;
}

/** The one capability the gater composition needs from the enforcer. */
export type StrandRevocationJudge = Pick<StrandRevocationEnforcer, 'isRevoked'>;

/**
 * Build a closed strand's connection gater: the caller-supplied gater (if any)
 * with revoked-peer denial composed onto three hooks. The opportunistic
 * SECONDARY layer — the per-stream gate above is the fail-closed primary.
 *
 *  - `denyInboundEncryptedConnection`: deny iff revoked, so a removed party's
 *    node is refused before any protocol negotiation.
 *  - `denyDialPeer`: deny iff revoked — the owner ruling covers "communicated
 *    with", not just "answered to", and refusing the dial locally is instant,
 *    which keeps Optimystic from wasting a dial timeout on a peer this node
 *    will not talk to anyway.
 *  - `denyInboundRelayReservation`: deny iff revoked — matters when the strand
 *    node runs the relay server (the storage-profile default), where admitting
 *    the reservation would let a removed party keep using this node's
 *    forwarding capacity.
 *
 * Composition semantics: every hook of `base` is preserved as-is; on the three
 * composed hooks a deny from EITHER the base gater or the revocation check
 * denies, and an error (or a decision slower than `decisionTimeoutMs`) in
 * either is fail-open — the base error admits through to the revocation check,
 * a revocation-check error admits outright, and the fail-closed stream gate
 * still stands behind both. The deadline is belt-and-braces: the snapshot read
 * is synchronous.
 *
 * NOTE: accepted tradeoff — swallowing a BASE hook's throw diverges from
 * `createMembershipConnectionGater`, which lets it propagate to libp2p (a
 * fail-closed outcome there). Uniform fail-open was chosen for this module so
 * every hook has one failure direction, and it was the shape the plan specified;
 * the cost is that an embedder gater which throws is silently admitted here
 * while the same gater passed raw to an OPEN strand would refuse. Loud in the
 * log either way. Revisit if an embedder ever ships a gater whose throw is a
 * meaningful deny, or if the two gaters are unified.
 *
 * NOTE: `base` is spread, so a gater passed as a CLASS INSTANCE would lose its
 * prototype methods — same caveat as `createMembershipConnectionGater`; every
 * caller in this repo supplies a plain object (the RN/web permissive gaters,
 * e.g. `{ denyDialMultiaddr: () => false }`, keep working unchanged).
 */
export function createRevocationConnectionGater(
  enforcer: StrandRevocationJudge,
  base?: ConnectionGater,
  decisionTimeoutMs: number = ADMISSION_DECISION_TIMEOUT_MS
): ConnectionGater {
  /** The base gater's verdict, fail-open: an error or absence is "not denied". */
  const baseDenies = async (decide: () => Promise<boolean> | boolean | undefined, hook: string): Promise<boolean> => {
    try {
      return await decide() === true;
    } catch (error) {
      log('base gater %s threw — treating as not-denied (fail-open): %o', hook, error);
      return false;
    }
  };
  /** The revocation verdict, bounded and fail-open. */
  const revokedDenies = async (peerId: PeerId, hook: string): Promise<boolean> => {
    const remotePeerId = peerId.toString();
    try {
      const revoked = await decideWithinDeadline(
        () => enforcer.isRevoked(remotePeerId), false, decisionTimeoutMs, `${hook}(${remotePeerId})`
      );
      if (revoked) {
        log('%s: %s is revoked — denying', hook, remotePeerId);
      }
      return revoked;
    } catch (error) {
      log('%s revocation check threw for %s — admitting (fail-open; stream gate decides): %o', hook, remotePeerId, error);
      return false;
    }
  };
  return {
    ...base,
    denyDialPeer: async (peerId: PeerId): Promise<boolean> => {
      if (await baseDenies(() => base?.denyDialPeer?.(peerId), 'denyDialPeer')) {
        return true;
      }
      return revokedDenies(peerId, 'denyDialPeer');
    },
    denyInboundEncryptedConnection: async (peerId: PeerId, maConn: MultiaddrConnection): Promise<boolean> => {
      if (await baseDenies(() => base?.denyInboundEncryptedConnection?.(peerId, maConn), 'denyInboundEncryptedConnection')) {
        return true;
      }
      return revokedDenies(peerId, 'denyInboundEncryptedConnection');
    },
    denyInboundRelayReservation: async (peerId: PeerId): Promise<boolean> => {
      if (await baseDenies(() => base?.denyInboundRelayReservation?.(peerId), 'denyInboundRelayReservation')) {
        return true;
      }
      return revokedDenies(peerId, 'denyInboundRelayReservation');
    }
  };
}
