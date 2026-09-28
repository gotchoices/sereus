import debug from 'debug';
import type { IdentifyResult, Libp2p, PeerId } from '@libp2p/interface';
import type { ActionId, IPeerNetwork } from '@optimystic/db-core';
import { BlockTransferClient, buildBlockTransferProtocol, type BlockCommitProof, type IRawStorage } from '@optimystic/db-p2p';
import { peerJoinPushBudget } from './link-budget.js';

// Peer-join whole-store block catch-up, shared by the STRAND networks and the CONTROL
// network. On a new peer's `peer:identify` result — libp2p's identify protocol runs once per
// connection and reports the protocols the remote supports — naming this network's own
// block-transfer protocol, it schedules a debounced push of every committed, materialized
// block in the local raw store to that peer, so a machine that joined after blocks were
// committed still ends up physically holding them. Optimystic has no cohort-join catch-up
// of its own; a block committed while its writer was alone has exactly one holder forever
// without this (named collection-header blocks are written once, at collection creation,
// and their revision never moves again — so no later commit ever carries them anywhere).
//
// A peer whose identify does not name the protocol — a bare circuit relay, a bootstrap node,
// or (on the control network) a stranger the inbound gate admits without membership — is
// never scheduled at all: it cannot receive anything, since the protocol id is namespaced per
// network and the dial would simply fail. Before this filter existed, such a peer WAS
// scheduled, failed every dial, and after `PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES` produced a
// `console.warn` naming it — gotchoices/sereus#18 is two relay-only parties restarting and
// printing exactly that warning about their own relay, forever, on every reconnect. See
// {@link speaksBlockTransfer}.
//
// NOTE: this copies the WHOLE local store to every newly connected peer, which is right
// while a network is one party's handful of machines (see docs/architecture.md →
// Replication cluster size — the control network replicates to the whole party by intent,
// and "On a strand, the machine count is not a party count"). If these meshes ever get
// large, filter the pushed set by FRET cohort responsibility for each block id instead of
// pushing everything.
//
// NOTE: this lives in cadre-core only because `../optimystic` is read-only from this repo.
// If Optimystic ever grows a cohort-join catch-up of its own, delete this module rather
// than running two.
//
// Membership — the one place the two networks differ, expressed as the optional
// `authorizePeer` dep:
//
// - STRAND networks pass none. Anything that speaks the strand's own block-transfer protocol
//   already receives cohort replicas of new commits, so pushing older blocks to it exposes
//   nothing new; adding a gate would diverge from what ordinary replication already does
//   there.
// - The CONTROL network MUST pass one, because that argument does not carry over: its
//   inbound connection gate deliberately admits non-members in several states (an
//   un-enrolled node taking its seed, an open enrollment window, an outstanding
//   invitation, configured bootstrap/relay peers — see docs/architecture.md, the
//   control-network inbound connection gate). Pushing the whole control store to such a
//   peer would hand a stranger the party's entire membership, addresses and strand list.
//   `CadreNode` passes `isAuthorizedMember`; the gate is consulted at PUSH time, not at
//   schedule time, and fails closed on a thrown check. A denied run is not memoized, so
//   the peer is retried on its next `peer:identify` (a reconnect re-runs identify) — or
//   sooner, via `scheduleConnectedPeers()` on a membership change (the production join order is
//   connect-then-authorize, so the denial at dial time is the expected first pass).
//
// Both per-push deadlines are DERIVED from the declared link round trip
// (`link-budget.ts`), not fixed milliseconds. That is not tuning — it is what makes this
// module work at all over a relay. Opening a relayed connection costs a fixed number of
// exchanges, so the 3000 ms this catch-up used to allow its dial could never finish one
// above 375 ms of one-way link delay: the catch-up existed so that a machine which joined
// after blocks were committed physically ends up holding them, and through a relay on any
// link slow enough to matter it had never once managed to. The reproduction is
// `packages/integration-tests/src/scenarios/relayed-dial-cost-by-latency.integration.ts`.
//
// It does NOT work at every speed. Above the declared link, libp2p's own dial and
// inbound-upgrade limits — derived from the same declaration — abandon the connection before
// any deadline here is consulted, and the listener's one makes that failure look like an absent
// peer rather than a timeout. That is also what happens when the machine being caught up
// declared a FASTER link than this one, since its limit is the listener's. See
// `link-budget.ts` ("libp2p's own two limits", "What still fails at the supported link").
//
// RETRY, and why it backs off. A run whose PUSH FAILED — the transport threw, which is what
// a dial or response deadline expiring looks like here — re-arms on a doubling backoff
// (`retryBackoffMs` to `maxRetryBackoffMs`), and a `peer:identify` arriving while that wait
// is outstanding is DROPPED rather than collapsing it back to the debounce. Both halves are
// load-bearing:
//
// - Without the re-arm, a transient push failure over a stable connection left the peer
//   partially copied until its next reconnect (read repair still covered reads meanwhile).
// - Without dropping churn inside the wait, a peer that cannot be reached at all is
//   re-dialled on every `peer:identify` forever. That is not hypothetical: the 2026-09-26
//   relayed reproduction shows one peer re-opening a connection about every 14.5 s for a
//   200-second run, each event starting a catch-up whose dial could not possibly finish.
//   The connection kept re-appearing because Optimystic's own block-transfer push path
//   budgets its dial at `transferTimeoutMs ?? 30000` — the one dial budget in the stack
//   above the measured relayed setup cost — so it succeeded where this one could not.
//
// A NON-CLEAN run is NOT on its own enough to re-arm, and the distinction is what keeps the
// backoff from becoming a worse problem than the one it fixes. `clean` also goes false for
// outcomes no amount of retrying can change: the membership gate DENIED the peer; this
// network's raw storage implements no `listBlockIds`, so the catch-up is inert; or the
// receiver reported blocks in `missing`, which it does per block for a payload it cannot
// parse and for a revision whose retained commit proof this node does not hold (a push
// carrying no proof is refused outright by a receiver running the default
// `requirePushCertificate: true`, and an unretained proof is the ordinary case — see
// {@link Chunk.proofs}). Re-arming on those would re-push the WHOLE store to that peer every
// `maxRetryBackoffMs` for as long as the node runs, and report the failure below as a link
// budget problem when nothing about the link is wrong. All three still leave the peer
// un-memoized, so its next `peer:identify` retries — the behaviour that predates the
// backoff, and the right one for a verdict rather than a timeout. Denial in particular is
// re-driven on purpose by `scheduleConnectedPeers()` the moment the membership commit lands,
// because the control network's join order is connect-then-authorize.
//
// A re-arm is also skipped when the peer is no longer CONNECTED. This module's trigger is
// `peer:identify`, so a peer that went away already has one: re-arming instead would leave
// a machine dialing a peer it cannot see once a minute for the rest of its uptime.
//
// After `PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES` consecutive failures one `console.warn`
// names the peer and the budget, because otherwise a machine on a too-slow link says
// nothing at all: the connection simply never appears and only a DEBUG log mentions a dial
// timeout.
//
// NOTE: the protocol check happens once — either when a connection's `peer:identify` fires,
// or, for a peer already connected when this instance starts, when `scheduleConnectedPeers()`
// reads its protocols back from the peer store — and is never repeated once a peer is
// scheduled. A peer that stops speaking the protocol after being scheduled (should that ever
// happen) is not de-scheduled; `runCatchUp`'s own unreachable-peer bail is what would catch
// that case instead. `peer:identify` also fires on every identify-push from a connected peer
// (address or protocol changes), which only re-enters the debounce — cheap, and dropped
// outright for caught-up peers and peers inside a backoff wait.
//
// NOTE: a same-network peer whose identify never completes on a connection (the identify
// stream times out over a slow relayed link, say) is not caught up until a later identify
// succeeds — a reconnect, an identify-push, or on the control network a membership-change
// re-drive. Accepted: every db-p2p node runs identify, and read repair still covers reads
// meanwhile; if relayed links ever routinely outlast identify's timeout, raise that timeout
// in the node builder rather than scheduling unidentified peers here.
//
// NOTE: a peer that disconnects INSIDE a backoff wait still costs the one attempt that wait
// was already armed for — the connectivity check is made when the re-arm is decided, not when
// the timer fires, and this module subscribes to `peer:identify` only. One dial, not a
// recurring one; if a node ever holds many transient peers, subscribe to `connection:close`
// and clear the pending timer there.

const log = debug('sereus:cadre:peer-join-backfill');

/**
 * The block-transfer protocol's hard cap on one length-prefixed message. Mirrors
 * `MAX_BLOCK_MESSAGE_BYTES` in `@optimystic/db-p2p`'s `protocol-limits.ts` (8 MiB), which
 * that package does not re-export from its index — keep the two in sync if upstream ever
 * changes it or starts exporting it.
 */
export const MAX_BLOCK_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * Whether an identified peer's protocol list names this network's own block-transfer
 * protocol — the one gate that decides whether {@link PeerJoinBackfill} schedules a peer at
 * all. A peer that lacks it (a bare circuit relay, a bootstrap node, a stranger the control
 * network's inbound gate admitted without membership) cannot receive a push no matter how
 * long it is dialed, since the protocol id is namespaced per network. Exported because a
 * later strand peer-address ticket's identify-driven observation needs the identical test.
 */
export function speaksBlockTransfer(protocols: readonly string[], protocolPrefix: string): boolean {
  return protocols.includes(buildBlockTransferProtocol(protocolPrefix));
}

/**
 * Consecutive failed catch-up runs against ONE peer before the module says so on
 * `console.warn` rather than only in its DEBUG log. At the default backoff that is reached
 * about 35 seconds in (5 s + 10 s + 20 s), which is late enough to have ruled out a blip and
 * early enough to be the first thing an operator sees about a machine that is not catching up.
 */
export const PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES = 3;

/** Tuning for the per-peer catch-up. Every field optional; defaults in {@link DEFAULT_PEER_JOIN_BACKFILL}. */
export interface PeerJoinBackfillConfig {
  /** Default true. False disables the catch-up entirely (the pre-existing behaviour). */
  enabled?: boolean;
  /** Settle time after a connection opens before catching that peer up, ms. Default 1000. */
  debounceMs?: number;
  /** Ceiling on blocks copied in one catch-up. Default 10_000. Reaching it is LOGGED, never silent. */
  maxBlocks?: number;
  /** Soft byte budget per push message. Default 1 MiB. Protocol hard cap is {@link MAX_BLOCK_MESSAGE_BYTES} (8 MiB). */
  maxChunkBytes?: number;
  /** Max blocks per push message. Default 64. */
  maxChunkBlocks?: number;
  /**
   * Per-push dial deadline, ms. Default {@link peerJoinPushBudget}'s `dialTimeoutMs` — four link
   * round trips at the declared link, 14 000 ms as shipped. NOT a fixed number: a relayed dial
   * costs a fixed number of exchanges, so a host on a slower link moves this (and every other
   * cadre dial budget) by declaring `NetworkConfig.linkRoundTripMs`. Naming it here still wins
   * over the derived value — `link-budget.ts` has the counts and the measurement.
   */
  dialTimeoutMs?: number;
  /**
   * Per-push response deadline, ms. Default {@link peerJoinPushBudget}'s `responseTimeoutMs` —
   * two link round trips at the declared link plus a transfer allowance for the chunk's own
   * bytes, 13 000 ms as shipped. Derived differently from {@link dialTimeoutMs} because it
   * bounds a data transfer over a connection that is already open, not a dial.
   */
  responseTimeoutMs?: number;
  /**
   * First wait before re-running a catch-up whose last run did not complete cleanly, ms.
   * Default 5000. Doubles per consecutive failure up to {@link maxRetryBackoffMs}.
   */
  retryBackoffMs?: number;
  /** Ceiling on that doubling wait, ms. Default 60_000. */
  maxRetryBackoffMs?: number;
}

/** The resolved defaults every {@link PeerJoinBackfill} starts from. */
export const DEFAULT_PEER_JOIN_BACKFILL: Required<PeerJoinBackfillConfig> = {
  enabled: true,
  debounceMs: 1000,
  maxBlocks: 10_000,
  maxChunkBytes: 1024 * 1024,
  maxChunkBlocks: 64,
  // Derived at the DEFAULT declared link, for a `PeerJoinBackfill` built without a host's
  // declaration (this module's own tests, an embedder driving it directly). The two production
  // construction sites pass `peerJoinPushBudget(network?.linkRoundTripMs)` so a host that
  // declares a slower link moves both — see `link-budget.ts`.
  ...peerJoinPushBudget(),
  retryBackoffMs: 5000,
  maxRetryBackoffMs: 60_000
};

/**
 * The one capability the catch-up needs from a transfer client. Structural (rather than
 * the concrete `BlockTransferClient`) so unit tests can capture pushes without dialing
 * libp2p — see {@link PeerJoinBackfillDeps.createPushClient}.
 */
export type PeerJoinBackfillPushClient = Pick<BlockTransferClient, 'pushBlocks'>;

export interface PeerJoinBackfillDeps {
  /** Log tag naming which network this catch-up serves (a strand id, or `control-<partyId>`). */
  label: string;
  /** The libp2p node of the network being caught up — source of connection events and peer ids. */
  libp2p: Libp2p;
  /** `node.keyNetwork`, the IPeerNetwork BlockTransferClient dials through. */
  peerNetwork: IPeerNetwork;
  /** This network's own raw block store — the same instance handed to the libp2p node. */
  storage: IRawStorage;
  /** Must equal the prefix the receiver registered its handler under: `/optimystic/<networkName>`. */
  protocolPrefix: string;
  /**
   * Membership gate, consulted at PUSH time (fails closed on a throw). Absent = push to
   * every connected peer — correct for strand networks, NEVER for the control network;
   * see the module comment for why the strand no-gate argument does not carry over.
   */
  authorizePeer?: (peerId: string) => Promise<boolean>;
  /**
   * Test seam: build the per-peer push client. Defaults to a real
   * `BlockTransferClient` over {@link peerNetwork} + {@link protocolPrefix}.
   */
  createPushClient?: (peerId: PeerId) => PeerJoinBackfillPushClient;
}

/** What one peer's catch-up actually did. Returned for tests and logged at the end of each run. */
export interface PeerJoinBackfillResult {
  /** Blocks offered: had a committed `latest` AND materialized content locally. */
  offered: number;
  /** Blocks the remote reported it persisted. */
  accepted: number;
  /** Block ids the remote reported in `missing` (parse or persist failure on its side). */
  rejected: string[];
  /** Skipped: metadata has no `latest` (pending-only — not yet a durability claim here). */
  uncommitted: number;
  /** Skipped: `latest` exists but no materialized block is stored for that actionId. */
  unmaterialized: number;
  /** Not attempted because `maxBlocks` was reached. */
  capped: number;
  /** Skipped: a single block whose wire size alone exceeds {@link MAX_BLOCK_MESSAGE_BYTES}. */
  oversized: string[];
  /** True when the `authorizePeer` gate refused (or threw) — nothing was pushed, peer not memoized. */
  denied: boolean;
}

function emptyResult(): PeerJoinBackfillResult {
  return { offered: 0, accepted: 0, rejected: [], uncommitted: 0, unmaterialized: 0, capped: 0, oversized: [], denied: false };
}

/** One in-flight push message being accumulated. */
interface Chunk {
  ids: string[];
  buffers: Uint8Array[];
  meta: Record<string, { rev: number; actionId: ActionId }>;
  /**
   * The cohort commit proof retained for each block's pushed revision, where one exists.
   *
   * A receiver running the default `requirePushCertificate: true` REJECTS a block pushed
   * without one, so this is what makes peer-join catch-up land at all — a push carrying only
   * `meta` is the legacy shape and is refused. Sparse deliberately: a block whose proof was
   * never retained is still offered with its meta, which is the only thing that lets a
   * receiver migrating with the flag off land the replica at this node's revision rather than
   * a fabricated rev 1. Upstream's rule is the other direction and holds here by construction:
   * a proof is never attached WITHOUT its meta, because both are written from the same
   * `latest` in one place.
   */
  proofs: Record<string, BlockCommitProof>;
  bytes: number;
}

/**
 * Base64 wire size of a raw buffer — `pushBlocks` base64-encodes each block into the JSON
 * request, so the protocol cap must be judged against the encoded size, not the raw bytes.
 */
function base64WireBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Copies every block in one network's own raw store to each peer its libp2p node connects
 * to, so a peer that joined the network after blocks were committed still ends up holding
 * them physically (the receiver persists each push via `saveReplicatedBlock`, which is
 * monotonic and idempotent — crossing pushes from both ends cannot regress a revision).
 *
 * Best-effort throughout: nothing here throws into a libp2p event handler or into a
 * runtime bring-up; a failed chunk is logged and the run continues. A peer is marked
 * fully caught up ONLY after a run with no thrown chunk and an empty `missing` list, so
 * the next `peer:identify` from a peer whose catch-up failed retries it.
 */
export class PeerJoinBackfill {
  private readonly config: Required<PeerJoinBackfillConfig>;
  private readonly createPushClient: (peerId: PeerId) => PeerJoinBackfillPushClient;
  private started = false;
  private stopped = false;
  /** Peers fully caught up this runtime (never retried until the runtime is rebuilt). */
  private readonly done = new Set<string>();
  /** Peers with a catch-up currently running (suppresses concurrent duplicates). */
  private readonly inFlight = new Set<string>();
  /**
   * Peers whose (re-)schedule arrived while their OWN run was in flight, replayed once
   * that run finishes. Load-bearing for the gated path: the gate's authorization check is
   * a control-database read, so the window between it and the run's end is wide enough for
   * the very membership commit that would have authorized the peer to land inside it —
   * dropping that schedule (rather than deferring it) leaves the denied peer waiting for a
   * reconnect, which is exactly what the re-arm exists to avoid.
   */
  private readonly rearmAfterFlight = new Set<string>();
  /** Pending per-peer timers — the debounce, or a backoff re-arm. Cleared on stop. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Consecutive non-clean runs per peer, cleared when one finishes cleanly. */
  private readonly failures = new Map<string, number>();
  /**
   * Epoch ms before which a peer's catch-up must not be re-run, set alongside a backoff timer
   * that will run it. Its presence is what makes `peer:identify` churn free: a schedule
   * arriving inside the wait is dropped, rather than collapsing the backoff to the debounce.
   */
  private readonly retryAfter = new Map<string, number>();
  /** Peers already reported on `console.warn`; reset when a run finally lands cleanly. */
  private readonly warned = new Set<string>();
  private readonly onPeerIdentify: (evt: CustomEvent<IdentifyResult>) => void;
  private loggedNoListBlockIds = false;

  constructor(private readonly deps: PeerJoinBackfillDeps, config?: PeerJoinBackfillConfig) {
    this.config = { ...DEFAULT_PEER_JOIN_BACKFILL, ...config };
    this.createPushClient = deps.createPushClient
      ?? ((peerId) => new BlockTransferClient(peerId, deps.peerNetwork, deps.protocolPrefix));
    this.onPeerIdentify = (evt) => {
      const { peerId, protocols } = evt.detail;
      if (speaksBlockTransfer(protocols, this.deps.protocolPrefix)) {
        this.schedulePeer(peerId);
      }
    };
  }

  /**
   * Subscribe to `peer:identify` AND schedule a catch-up for already-connected peers whose
   * stored protocols already name this network's block-transfer protocol — a peer that does
   * not speak it (a bare circuit relay, a bootstrap node) is never scheduled at all. See
   * {@link speaksBlockTransfer} and the module comment.
   */
  start(): void {
    if (this.started || this.stopped || !this.config.enabled) return;
    this.started = true;
    this.deps.libp2p.addEventListener('peer:identify', this.onPeerIdentify);
    // A runtime rebuilt over live connections (resumeStrand) never sees their peer:identify —
    // it already fired before this instance existed, but its result is persisted in the peer
    // store — so walk what is already connected once.
    void this.scheduleConnectedPeers().then((scheduled) => {
      log('[%s] started (%d peer(s) already connected)', this.deps.label, scheduled);
    });
  }

  /** Unsubscribe, clear timers; in-flight runs observe the stopped flag and bail. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.started) {
      this.deps.libp2p.removeEventListener('peer:identify', this.onPeerIdentify);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.rearmAfterFlight.clear();
    this.retryAfter.clear();
    log('[%s] stopped', this.deps.label);
  }

  /**
   * (Re-)schedule a debounced catch-up for every currently-connected peer whose protocols, as
   * already stored in the libp2p peer store, name this network's block-transfer protocol. A
   * peer not yet in the peer store — its identify has not finished — is left to the
   * `peer:identify` handler rather than dialed blind; one whose stored protocols are known
   * and lack ours is skipped outright. Idempotent and cheap otherwise (caught-up peers are
   * skipped before any timer is set, and a peer whose run is in flight is deferred to the end
   * of that run rather than dropped). Driven by {@link start}, and — on a gated network — by
   * the embedder whenever membership changes, so a peer whose first pass was denied (connected
   * before it was authorized: the production join order) is retried without waiting for a
   * reconnect. Returns how many distinct peers were considered (for the start() log) — a peer
   * holding several connections is one peer, and is scheduled once.
   */
  async scheduleConnectedPeers(): Promise<number> {
    if (this.stopped) return 0;
    const peers = new Map<string, PeerId>();
    for (const connection of this.deps.libp2p.getConnections()) {
      peers.set(connection.remotePeer.toString(), connection.remotePeer);
    }
    await Promise.all([...peers.values()].map((peerId) => this.scheduleIfKnownToSpeak(peerId)));
    return peers.size;
  }

  /** Schedules `peerId` only if the peer store already knows it speaks this network's protocol. */
  private async scheduleIfKnownToSpeak(peerId: PeerId): Promise<void> {
    let protocols: string[];
    try {
      ({ protocols } = await this.deps.libp2p.peerStore.get(peerId));
    } catch (error) {
      // NotFoundError: identify has not finished. Leave it to the `peer:identify` handler
      // rather than dialing blind. Anything else is unexpected — log it and skip the peer.
      if ((error as Error).name !== 'NotFoundError') {
        log('[%s] peer store read for %s failed — not scheduling: %o', this.deps.label, peerId.toString(), error);
      }
      return;
    }
    if (speaksBlockTransfer(protocols, this.deps.protocolPrefix)) {
      this.schedulePeer(peerId);
    }
  }

  /** Debounced entry point for connection churn: one run per peer per settle window. */
  private schedulePeer(peerId: PeerId): void {
    const key = peerId.toString();
    if (this.stopped || this.done.has(key)) return;
    if (this.inFlight.has(key)) {
      // Defer rather than drop: the running pass may already be past its gate check (or
      // past the block this schedule was meant to carry), so replay it when that pass ends.
      this.rearmAfterFlight.add(key);
      return;
    }
    // A peer whose last run failed is already re-armed on a backoff timer that will run it, so
    // DROP this schedule instead of shortening the wait — otherwise a peer that cannot be
    // reached is re-dialled on every peer:identify forever (see the module comment's retry
    // paragraph). A denied run never gets here: it does not set a backoff.
    const retryAt = this.retryAfter.get(key);
    if (retryAt !== undefined && Date.now() < retryAt) return;
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.catchUpPeer(peerId);
    }, this.config.debounceMs));
  }

  /**
   * Run one peer's catch-up now, bypassing the debounce. Never rejects. Returns an
   * all-zero result without pushing when the peer is already caught up, already being
   * caught up, or this backfill is stopped.
   */
  async catchUpPeer(peerId: PeerId): Promise<PeerJoinBackfillResult> {
    const key = peerId.toString();
    if (this.stopped || this.done.has(key) || this.inFlight.has(key)) {
      return emptyResult();
    }
    this.inFlight.add(key);
    try {
      const { result, clean, pushFailed } = await this.runCatchUp(peerId);
      // NOTE: a run that hit `maxBlocks` is still "clean" and still memoizes the peer, so
      // the tail past the ceiling never reaches it. Deliberate: enumeration is not
      // resumable, so not memoizing would re-push the same prefix on every reconnect
      // without ever advancing. Loud in the log below (capped > 0). If a store can
      // realistically exceed maxBlocks, the fix is a resumable cursor, not either policy.
      if (clean && !this.stopped) {
        this.done.add(key);
        this.failures.delete(key);
        this.retryAfter.delete(key);
        this.warned.delete(key);
      } else if (pushFailed && !this.stopped && this.started && this.isConnected(peerId)) {
        // `pushFailed`, not `!clean`: a denial, an inert store and a receiver's per-block
        // rejection are all verdicts a retry cannot change, and re-arming on them would
        // re-push the whole store to that peer forever. See the module comment.
        //
        // Gated on `started` too: the re-arm exists to REPLACE a peer:identify-driven retry,
        // so a caller driving `catchUpPeer` by hand against a backfill that was never started
        // owns its own retry policy and must not be left holding a background timer.
        this.scheduleRetryWithBackoff(peerId);
      }
      log('[%s] catch-up peer=%s offered=%d accepted=%d rejected=%d uncommitted=%d unmaterialized=%d capped=%d oversized=%d denied=%s done=%s',
        this.deps.label, key, result.offered, result.accepted, result.rejected.length,
        result.uncommitted, result.unmaterialized, result.capped, result.oversized.length, result.denied, clean);
      return result;
    } catch (error) {
      // runCatchUp already contains a per-chunk catch; this guards the enumeration and
      // metadata reads too — a backfill fault must never surface through a libp2p event.
      log('[%s] catch-up peer=%s failed: %o', this.deps.label, key, error);
      return emptyResult();
    } finally {
      this.inFlight.delete(key);
      // Replay a schedule that arrived mid-run. `schedulePeer` re-checks `done`, so a run
      // that finished clean re-arms nothing; a denied or failed one gets its retry.
      if (this.rearmAfterFlight.delete(key)) {
        this.schedulePeer(peerId);
      }
    }
  }

  /** Whether this network's libp2p node still holds a connection to that peer. */
  private isConnected(peerId: PeerId): boolean {
    return this.deps.libp2p.getConnections(peerId).length > 0;
  }

  /**
   * Re-arm one peer's catch-up after a run whose push failed, on a wait that doubles
   * per consecutive failure up to `maxRetryBackoffMs`. Sets {@link retryAfter} alongside the
   * timer, which is what makes `peer:identify` churn inside the wait free.
   */
  private scheduleRetryWithBackoff(peerId: PeerId): void {
    const key = peerId.toString();
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    const delayMs = Math.min(
      this.config.retryBackoffMs * 2 ** (failures - 1),
      this.config.maxRetryBackoffMs
    );
    this.retryAfter.set(key, Date.now() + delayMs);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      this.retryAfter.delete(key);
      void this.catchUpPeer(peerId);
    }, delayMs));
    log('[%s] catch-up peer=%s failed %d time(s) in a row; retrying in %dms',
      this.deps.label, key, failures, delayMs);
    this.warnPersistentFailure(key, failures);
  }

  /**
   * Say ONCE per peer, outside the DEBUG log, that its catch-up is not landing. Without this a
   * machine on a link too slow for a relayed dial produces no statement that anything is wrong:
   * the peer never appears to hold the blocks, and the only trace is a DEBUG line naming a dial
   * timeout. Reset when a run finally lands cleanly, so a peer that recovers can report again.
   */
  private warnPersistentFailure(key: string, failures: number): void {
    if (failures < PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES || this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(
      `[cadre:${this.deps.label}] peer-join block catch-up to peer ${key} has failed ${failures} times in a row `
      + `(dial budget ${this.config.dialTimeoutMs}ms, response budget ${this.config.responseTimeoutMs}ms). `
      + 'That peer may not be holding blocks committed before it joined. If it is reachable only through a relay, '
      + 'these budgets and libp2p\'s own connection limits are derived from network.linkRoundTripMs (see link-budget.ts); '
      + 'a link slower than that declaration, or a peer that declared a faster one, cannot open a relayed connection at all.'
    );
  }

  /**
   * The actual copy. `clean` = every chunk pushed and the remote persisted every block.
   * `pushFailed` = at least one push THREW, which is the only non-clean outcome a retry can
   * change; the others are verdicts (denied, inert store, blocks the receiver refused).
   */
  private async runCatchUp(peerId: PeerId): Promise<{ result: PeerJoinBackfillResult; clean: boolean; pushFailed: boolean }> {
    const result = emptyResult();
    const { storage } = this.deps;

    // The membership gate, judged at push time (never at schedule time — authorization can
    // change during the debounce window in either direction). Fails CLOSED on a throw: a
    // gate that cannot answer must not leak the store. A denied run is not clean, so the
    // peer is retried later rather than memoized as caught up.
    if (this.deps.authorizePeer) {
      let authorized = false;
      try {
        authorized = await this.deps.authorizePeer(peerId.toString());
      } catch (error) {
        log('[%s] authorizePeer(%s) threw — treating as denied: %o', this.deps.label, peerId.toString(), error);
      }
      if (!authorized) {
        result.denied = true;
        return { result, clean: false, pushFailed: false };
      }
    }

    if (!storage.listBlockIds) {
      if (!this.loggedNoListBlockIds) {
        this.loggedNoListBlockIds = true;
        log('[%s] raw storage does not implement listBlockIds(); backfill is inert', this.deps.label);
      }
      return { result, clean: false, pushFailed: false };
    }

    const client = this.createPushClient(peerId);
    const encoder = new TextEncoder();
    let chunk: Chunk = { ids: [], buffers: [], meta: {}, proofs: {}, bytes: 0 };
    let chunkFailed = false;
    let anyChunkDelivered = false;
    /**
     * A peer that has answered no push at all, and failed one, is not reachable on this
     * protocol — abandon rather than spend a dial timeout per remaining chunk. Once ONE
     * push has been answered the peer demonstrably speaks it, so a later failure is a
     * transient blip and the rest of the store is still worth pushing.
     */
    const peerUnreachable = (): boolean => chunkFailed && !anyChunkDelivered;

    const flush = async (): Promise<void> => {
      if (chunk.ids.length === 0) return;
      const { ids, buffers, meta, proofs } = chunk;
      chunk = { ids: [], buffers: [], meta: {}, proofs: {}, bytes: 0 };
      try {
        // ONE certification value rather than two arguments, so a caller cannot pair a proof
        // for one revision with meta for another — both were written from the same `latest`.
        const response = await client.pushBlocks(ids, buffers, 'replication',
          { blockMeta: meta, blockProofs: proofs }, {
          dialTimeoutMs: this.config.dialTimeoutMs,
          responseTimeoutMs: this.config.responseTimeoutMs
        });
        anyChunkDelivered = true;
        const missing = new Set(response.missing);
        for (const id of ids) {
          if (missing.has(id)) {
            result.rejected.push(id);
          } else {
            result.accepted += 1;
          }
        }
        if (response.missing.length > 0) {
          log('[%s] peer=%s rejected %d block(s): %o', this.deps.label, peerId.toString(), response.missing.length, response.missing);
        }
      } catch (error) {
        chunkFailed = true;
        log('[%s] push to peer=%s failed for %d block(s): %s', this.deps.label, peerId.toString(), ids.length, (error as Error).message);
      }
    };

    for await (const blockId of storage.listBlockIds()) {
      if (this.stopped) break;
      if (result.offered >= this.config.maxBlocks) {
        // Past the ceiling: count what is left (id enumeration only — no more reads or
        // pushes) so the cap is loud in the end-of-run log rather than silent.
        result.capped += 1;
        continue;
      }

      const metadata = await storage.getMetadata(blockId);
      const latest = metadata?.latest;
      if (!latest) {
        result.uncommitted += 1;
        continue;
      }
      // NOTE: a block whose latest revision is a DELETE materializes to nothing (a
      // tombstone), so it is skipped here — a peer that joins after such a delete never
      // receives the tombstone from this path and relies on read repair for it. Fine
      // while nothing deletes whole blocks pre-join; if the whole-store coverage gate in
      // strand-membership-closed-strand-e2e ever reports a tombstone residue, teach this
      // to push the promoted delete transform instead of skipping.
      const block = await storage.getMaterializedBlock(blockId, latest.actionId);
      if (!block) {
        result.unmaterialized += 1;
        log('[%s] block=%s has latest rev %d but no materialized content; skipped', this.deps.label, blockId, latest.rev);
        continue;
      }

      const buffer = encoder.encode(JSON.stringify(block));
      // NOTE: MAX_BLOCK_MESSAGE_BYTES caps the whole framed request, not one block, and
      // this test ignores the request envelope (ids array, blockMeta, JSON punctuation).
      // A lone block within a few KiB of the cap therefore still ships and is rejected by
      // the receiver's length-prefix decoder — a permanent chunk failure for that peer. No
      // block comes close today; if one ever can, subtract a measured envelope allowance
      // here rather than raising the cap.
      if (base64WireBytes(buffer.length) >= MAX_BLOCK_MESSAGE_BYTES) {
        result.oversized.push(blockId);
        log('[%s] block=%s is %d bytes (%d on the wire) — exceeds the %d-byte protocol cap alone; skipped',
          this.deps.label, blockId, buffer.length, base64WireBytes(buffer.length), MAX_BLOCK_MESSAGE_BYTES);
        continue;
      }

      // Flush before adding when this block would overflow either budget. A single block
      // larger than maxChunkBytes still ships — alone, in its own chunk.
      if (chunk.ids.length > 0
        && (chunk.ids.length + 1 > this.config.maxChunkBlocks || chunk.bytes + buffer.length > this.config.maxChunkBytes)) {
        await flush();
        if (this.stopped || peerUnreachable()) break;
      }
      chunk.ids.push(blockId);
      chunk.buffers.push(buffer);
      chunk.meta[blockId] = { rev: latest.rev, actionId: latest.actionId };
      // Read the proof for EXACTLY the revision being pushed, from the same `latest` the meta
      // above was written from. Absent is normal (nothing retained a proof for that revision);
      // the block still ships with its meta and the receiver decides.
      const proof = await storage.getBlockProof(blockId, latest.rev);
      if (proof) {
        chunk.proofs[blockId] = proof;
      }
      chunk.bytes += buffer.length;
      result.offered += 1;
    }

    if (!this.stopped && !peerUnreachable()) {
      await flush();
    }

    if (result.capped > 0) {
      log('[%s] peer=%s catch-up CAPPED at %d blocks; %d block id(s) not attempted',
        this.deps.label, peerId.toString(), this.config.maxBlocks, result.capped);
    }

    const clean = !chunkFailed && result.rejected.length === 0;
    return { result, clean, pushFailed: chunkFailed };
  }
}
