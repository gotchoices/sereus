/**
 * Control-network push-wake transport.
 *
 * Lets a same-cadre peer — typically an always-on server that participates in a
 * strand and sees new activity — signal a hibernating cadre peer to bring that
 * strand online, pull pending activity, and re-hibernate. Push-wake travels the
 * **control network** (the per-party network connecting this party's own cadre
 * nodes), which is the only network a hibernating peer keeps connected.
 *
 * Modeled directly on `seed-bootstrap.ts`: a dedicated libp2p protocol id,
 * 4-byte big-endian length-prefixed JSON frames, `node.handle` for the receiver,
 * `node.dialProtocol` for the sender, and the shared `ControlStream` primitives
 * from `control-stream.ts`. The exchange is a single request → single ack on one
 * stream (like seed delivery), so each side reads to EOF (under a read timeout)
 * and decodes one frame via the shared {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** a wake is low-risk — it only causes the receiver to
 * spend resources coming online for a strand it already participates in — so the
 * receiver carries no per-request signature and instead defers entirely to the
 * injected `isMember` predicate. `CadreNode` injects its AUTHORIZED-membership
 * predicate there (`isAuthorizedMember`: the sender's `CadrePeer` row must carry
 * a voucher that verifies against an owner key in the receiver's node-local
 * trusted-owner anchor), so a peer that merely published rows into the replicated
 * control DB is refused. This module stays agnostic: it enforces whatever
 * predicate it is given.
 */

import debug from 'debug';
import type { Libp2p, Connection } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { StrandInstance, WakeRequest, WakeAck } from './types.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { type ControlStream, exchangeFrame, readStreamToEnd, replyAndClose } from './control-stream.js';
import { tryAddrsInTurn } from './peer-dial.js';
import { relayedRequestBudgetMs } from './link-budget.js';

const log = debug('sereus:cadre:strand-wake');

/** Protocol id for control-network push-wake (parallel to `/sereus/seed/1.0.0`). */
export const WAKE_PROTOCOL = '/sereus/strand-wake/1.0.0';

/**
 * Maximum wake frame size. Wake messages are tiny (a strand id + short reason),
 * so this is a defensive cap — far below the 1MB seed ceiling — that bounds the
 * bytes a peer can make the receiver buffer per stream.
 */
const MAX_WAKE_SIZE = 64 * 1024;

/**
 * Default deadline for ONE wake attempt — dial, request, ack — at the default declared link
 * (ms): `relayedRequestBudgetMs` in `link-budget.ts`, because the target may be reachable
 * only through a relay and the attempt has to open that connection before the exchange.
 * {@link dialWake} derives it from {@link DialWakeOptions.linkRoundTripMs} instead when given.
 *
 * It holds only link work because the receiver acks as soon as it has DECIDED, before the
 * wake itself runs ({@link StrandWakeService.processWakeRequest}).
 *
 * NOTE: the receiver's membership check (`isMember` → a control-database read) still runs
 * inside the exchange, and a read that consults a silent cohort peer can take up to
 * `COHORT_READ_DEADLINE_MS`. That is a read deadline, not link time, and is not counted
 * here; `debt-cadre-deadlines-sized-against-old-optimystic-bounds` owns it.
 */
export const DEFAULT_WAKE_TIMEOUT_MS = relayedRequestBudgetMs();

/**
 * Whole attempts one {@link dialWake} call budgets for: a stale signaling address, then the
 * direct address that works.
 */
export const WAKE_DIAL_ATTEMPTS = 2;

/**
 * Default budget for a WHOLE {@link dialWake} call at the default declared link, in ms —
 * every candidate address together, not each one: {@link WAKE_DIAL_ATTEMPTS} attempt
 * deadlines.
 *
 * Without it the cost of a wake is (candidate count × {@link
 * DEFAULT_WAKE_TIMEOUT_MS}), a number nothing chooses or bounds. That is not
 * hypothetical: an address behind a dropped NAT mapping, or any host that
 * blackholes rather than sending a RST, burns its full attempt timeout instead
 * of failing in milliseconds, so a five-address peer would cost five attempts.
 *
 * This makes the TARGET PEER the unit rather than the address — the same
 * decision, for the same reason, as
 * `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` in `peer-dial.ts`, though not the same
 * count: that one is sized to fit several dead addresses ahead of a working one,
 * while a wake target is expected to be awake and reachable on its first or second
 * address. Two whole attempts so a reachable peer whose signaling address is stale
 * still gets a genuine try at its direct one; a peer needing longer than that is
 * not "asleep and reachable", which is the only case a wake is for. The last
 * attempt inside the budget gets whatever remains of it, so the call returns at
 * the budget, not past it.
 *
 * Override per call with {@link DialWakeOptions.budgetMs} — tests that drive
 * dead addresses on purpose set it low so a dial's duration is a chosen number
 * rather than a transitive libp2p default stretched by machine load.
 */
export const DEFAULT_WAKE_DIAL_BUDGET_MS = WAKE_DIAL_ATTEMPTS * DEFAULT_WAKE_TIMEOUT_MS;

/** Default time the receiver waits for an inbound wake frame before aborting (ms). */
const DEFAULT_WAKE_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound wake streams a single peer can pin open. */
const DEFAULT_MAX_CONCURRENT_WAKES = 100;

/**
 * Read a libp2p stream to EOF and decode the single length-prefixed JSON frame
 * it carries. Bounded by `timeoutMs` (a never-half-closing peer is aborted, not
 * awaited forever) and capped at {@link MAX_WAKE_SIZE}, reusing the shared
 * {@link decodeLengthPrefixedFrame} guard for the prefix/length checks.
 */
async function readFrame<T>(stream: ControlStream, timeoutMs: number): Promise<T> {
  const data = await readStreamToEnd(stream, { maxBytes: MAX_WAKE_SIZE, timeoutMs, label: 'Wake' });
  const body = decodeLengthPrefixedFrame(data, MAX_WAKE_SIZE);
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

/**
 * Dependencies the {@link StrandWakeService} receiver needs from its host
 * (`CadreNode`), injected so the service is testable without a full node.
 */
export interface StrandWakeServiceOptions {
  /** Membership gate: is the remote peer a `CadrePeer` member of this cadre? */
  isMember(remotePeerId: string): Promise<boolean>;
  /** Look up a local strand instance by id (undefined if not participated in). */
  getStrand(strandId: string): StrandInstance | undefined;
  /**
   * Trigger the local wake path for a hibernating/idle strand. Wired to
   * `CadreNode.wakeStrand` (→ `HibernationManager` → `resumeStrand`), whose
   * resume coalescing prevents a push-wake racing a concurrent check-in.
   *
   * Started, not awaited: the ack goes back before the strand is up, and a wake
   * that fails afterwards is logged here rather than reported to the sender.
   */
  wake(strandId: string): Promise<void>;
  /**
   * Time to wait for the inbound wake frame before aborting the read (ms).
   * Defaults to {@link DEFAULT_WAKE_READ_TIMEOUT_MS}. Bounds a buggy/compromised
   * own-cadre node that opens a stream and never half-closes its write end.
   */
  readTimeoutMs?: number;
  /**
   * Cap on concurrent inbound wake streams (defaults to
   * {@link DEFAULT_MAX_CONCURRENT_WAKES}). Over the cap, a non-accepting ack is
   * returned without invoking the wake path.
   *
   * It counts streams, not wakes: a wake started after its ack is no longer
   * counted. Those are bounded by the strands this node participates in instead,
   * since an unknown strand is refused before any wake starts and the wake path
   * coalesces per strand.
   */
  maxConcurrent?: number;
}

/**
 * Receiver side of the push-wake protocol. Registers a `WAKE_PROTOCOL` handler
 * on the control node and, for each inbound {@link WakeRequest}, gates on cadre
 * membership, replies with a {@link WakeAck}, and starts resuming the named
 * strand if it is hibernating/idle and we participate in it.
 */
export class StrandWakeService {
  private readonly options: StrandWakeServiceOptions;
  private readonly readTimeoutMs: number;
  private readonly maxConcurrent: number;
  private node: Libp2p | null = null;
  /** In-flight inbound wake streams, used to enforce {@link maxConcurrent}. */
  private activeStreams = 0;

  constructor(options: StrandWakeServiceOptions) {
    this.options = options;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_WAKE_READ_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_WAKES;
  }

  /** Number of in-flight inbound wake streams. */
  get activeCount(): number {
    return this.activeStreams;
  }

  /**
   * Register the wake protocol handler on the control node. Rejects when libp2p
   * refuses the registration; the node reference is kept only once the handler
   * is in place.
   */
  async initialize(node: Libp2p): Promise<void> {
    // `runOnLimitedConnection: true` is REQUIRED for the relay path: a NAT'd
    // receiver is reached over a circuit-relay connection, which libp2p marks
    // "limited" (the relay caps its data/duration). Without this the receiver
    // would refuse the inbound wake stream on exactly the connection the
    // protocol is designed to use (see the relay note on `dialWake`).
    await node.handle(WAKE_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleStream(rawStream as ControlStream, remotePeerId);
    }, { runOnLimitedConnection: true });
    this.node = node;
    log('StrandWakeService registered handler: %s', WAKE_PROTOCOL);
  }

  /** Unregister the handler and release the node reference. */
  async shutdown(): Promise<void> {
    if (this.node) {
      await this.node.unhandle(WAKE_PROTOCOL);
      this.node = null;
      log('StrandWakeService shutdown');
    }
  }

  /**
   * Read the inbound request, decide the wake, and write the ack.
   *
   * Three hardening layers, all reported as a non-accepting ack rather than a
   * dropped/hung stream: a concurrency cap (over {@link maxConcurrent}, reply
   * without touching the wake path), a read timeout (a peer that never
   * half-closes is aborted inside {@link readFrame}/`readStreamToEnd`), and the
   * existing malformed/oversized-frame guard.
   */
  private async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    log('Incoming wake request from: %s', remotePeerId);

    if (this.activeStreams >= this.maxConcurrent) {
      log('Rejecting wake from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrent);
      await replyAndClose(stream, { accepted: false, reason: 'Too many concurrent wake requests' } satisfies WakeAck, 'Wake');
      return;
    }

    this.activeStreams++;
    try {
      await replyAndClose(stream, await this.answerStream(stream, remotePeerId), 'Wake');
    } finally {
      this.activeStreams--;
    }
  }

  /** Read and decide one inbound request; any failure becomes a non-accepting ack. */
  private async answerStream(stream: ControlStream, remotePeerId: string): Promise<WakeAck> {
    try {
      const request = await readFrame<WakeRequest>(stream, this.readTimeoutMs);
      return await this.processWakeRequest(request, remotePeerId);
    } catch (err) {
      log('Error handling wake request from %s: %o', remotePeerId, err);
      return { accepted: false, reason: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Decide the wake for a decoded request and start it. Exposed (not private) so
   * the decision matrix can be unit-tested directly.
   *
   * - Non-member sender → rejected (`accepted: false`).
   * - Unknown / not-participated strand → rejected.
   * - Hibernating or idle strand → `accepted` with that status, and a wake started.
   * - Already-live strand → no-op, `accepted` with current status.
   *
   * The wake is not awaited, so the ack means "a wake was started", not "the
   * strand is up". Awaiting it would put the whole resume — a sibling address
   * collection, a strand node build, a relay reservation drive — inside the
   * sender's attempt deadline, coupling that deadline to this node's own budgets.
   */
  async processWakeRequest(request: WakeRequest, remotePeerId: string): Promise<WakeAck> {
    // The injected membership predicate is the whole v1 authorization (CadreNode
    // supplies the voucher-anchored one); only a peer it admits may ask us to wake.
    if (!(await this.options.isMember(remotePeerId))) {
      log('Rejecting wake from non-member %s', remotePeerId);
      return { accepted: false, reason: 'Sender is not a cadre member' };
    }

    const instance = this.options.getStrand(request.strandId);
    if (!instance) {
      log('Rejecting wake for unknown/unparticipated strand %s', request.strandId);
      return { accepted: false, reason: 'Strand not found or not participated in' };
    }

    // Read before the wake starts: the wake path mutates the shared instance.
    const status = instance.status;
    if (status === 'hibernating' || status === 'idle') {
      log('Waking strand %s on push from %s (reason=%s)', request.strandId, remotePeerId, request.reason ?? 'unspecified');
      this.startWake(request.strandId);
    } else {
      log('Strand %s already %s; push-wake is a no-op', request.strandId, status);
    }

    return { accepted: true, status };
  }

  /**
   * Start a wake without awaiting it — the same fire-and-forget an activity-driven
   * local wake uses (`HibernationManager`), which also coalesces the two.
   */
  private startWake(strandId: string): void {
    void this.options.wake(strandId).catch((err: unknown) => {
      log('Push-wake of strand %s failed after it was accepted: %o', strandId, err);
    });
  }
}

/** Options for {@link dialWake}. */
export interface DialWakeOptions {
  /**
   * The sender's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
   * both deadlines below are derived when not given. Unset means the declared default.
   */
  linkRoundTripMs?: number;
  /** Per-ATTEMPT timeout in ms (default: derived as {@link DEFAULT_WAKE_TIMEOUT_MS} is). */
  timeoutMs?: number;
  /**
   * Budget for the whole call — every candidate together (default:
   * {@link WAKE_DIAL_ATTEMPTS} × the per-attempt timeout, as {@link DEFAULT_WAKE_DIAL_BUDGET_MS}).
   */
  budgetMs?: number;
  /** Override the protocol id (defaults to {@link WAKE_PROTOCOL}). */
  protocolId?: string;
}

/**
 * Sender side: dial a target's control-network address(es), send a
 * {@link WakeRequest} over `WAKE_PROTOCOL`, and return the peer's {@link WakeAck}.
 *
 * Tries each candidate address in order (signaling/relay first, as produced by
 * `CadreNode.resolvePeerAddrs`) until one dials, so a NAT'd peer is reachable via
 * its circuit-relay address. Each attempt is bounded by `timeoutMs` and the call
 * as a whole by `budgetMs` (see {@link DEFAULT_WAKE_DIAL_BUDGET_MS}); a candidate
 * the budget leaves no room for is reported as untried rather than silently
 * dropped.
 *
 * Throws if no address is dialable — with an error naming EVERY candidate and
 * why it failed, not merely the last one ({@link tryAddrsInTurn}). That
 * distinction is not cosmetic: with only the last candidate's message the
 * failure that mattered (usually the signaling address, tried first) is
 * invisible outside a debug log, and the surfaced message points at whichever
 * address happened to be tried last.
 *
 * The candidate loop is deliberately explicit rather than one
 * `dialProtocol(addrs)` call. libp2p sorts any multi-address dial with
 * `defaultAddressSorter`, whose `circuitRelayAddressesLast` pass would demote
 * exactly the signaling address this ordering puts first — silently inverting
 * it, with no per-dial sorter override to opt out of. For the same reason this
 * does not use `dialPeerAddrs`, which puts relayed addresses last.
 *
 * NOTE: unlike `dialPeerAddrs`, this does not drop addresses that relay through this node, so a
 * relay waking a peer that holds a reservation on it tries that address and gets `Can not dial
 * self` (fast, then the next candidate). If wakes are ever sent from a relay to its own
 * reservation holders routinely, share `dialPeerAddrs`'s filter here.
 */
export async function dialWake(
  node: Libp2p,
  addrs: Multiaddr[],
  request: WakeRequest,
  options: DialWakeOptions = {}
): Promise<WakeAck> {
  if (addrs.length === 0) {
    throw new Error('No dialable address for wake target');
  }
  const protocolId = options.protocolId ?? WAKE_PROTOCOL;
  const perAddressMs = options.timeoutMs ?? relayedRequestBudgetMs(options.linkRoundTripMs);
  const budget = {
    perAddressMs,
    totalMs: options.budgetMs ?? WAKE_DIAL_ATTEMPTS * perAddressMs,
  };
  // The attempt's signal aborts the in-flight dialProtocol and resets the live
  // stream, so neither the connect nor the ack-read leaks.
  return await tryAddrsInTurn(addrs, budget, 'Wake dial', (addr, signal, attemptMs) =>
    sendWake(node, addr, protocolId, request, attemptMs, signal));
}

/**
 * Open one stream, send the request, half-close, and read the ack.
 *
 * `signal` is the per-attempt deadline from {@link dialWake}: it goes to
 * `dialProtocol` so a timeout during connect aborts the dial, and into
 * {@link exchangeFrame} so a timeout after the stream is open resets it —
 * releasing the otherwise unbounded ack-read.
 */
async function sendWake(
  node: Libp2p,
  addr: Multiaddr,
  protocolId: string,
  request: WakeRequest,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WakeAck> {
  // `runOnLimitedConnection: true`: the target may be reachable only over a
  // circuit-relay connection (the signaling-first addr), which libp2p marks
  // "limited". The wake exchange is a single tiny request→ack well within the
  // relay's data/duration cap, so opening it on the limited connection is safe
  // and is the whole point of dialing the relay address.
  const rawStream = await node.dialProtocol(addr, protocolId, { runOnLimitedConnection: true, signal });

  const ack = await exchangeFrame(
    rawStream as unknown as ControlStream,
    signal,
    request,
    (stream) => readFrame<WakeAck>(stream, timeoutMs),
    'Wake dial aborted by timeout',
  );

  log('Wake ack from %s: accepted=%s status=%s', addr.toString(), ack.accepted, ack.status ?? '-');
  return ack;
}
