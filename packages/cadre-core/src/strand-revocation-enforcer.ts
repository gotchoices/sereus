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

  /** One serialized snapshot rebuild; contains every failure (contract: never rejects). */
  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    this.refreshing = true;
    try {
      const rows = await this.deps.readRows();
      if (this.stopped) return;
      this.revokedPeerIds = deriveRevokedPeerIds(rows);
      log('[%s] deny set refreshed: %d revoked peer(s)', this.deps.label, this.revokedPeerIds.size);
    } catch (error) {
      log('[%s] deny-set refresh failed — keeping previous snapshot: %o', this.deps.label, error);
    } finally {
      this.refreshing = false;
    }
  }
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
