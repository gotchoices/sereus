/**
 * Control-network strand-address RPC.
 *
 * A strand runs as its own libp2p node (`strand-<id>`, random port), separate
 * from the control node (`control-<partyId>`), with its own transport peerId
 * derived from the cadre identity key (`strand-transport-key.ts`). To seed a
 * strand's mesh, a node needs a sibling's **strand-network** address — but
 * `CadrePeer.Multiaddr` only stores the **control** node's addresses, and a
 * control address now names a different peer entirely, not merely a different
 * port. This protocol resolves the strand address on demand: a node asks its
 * connected co-cadre siblings "what are your live strand-`X` multiaddrs?" and
 * uses the union of their answers as the seed.
 *
 * Modeled directly on `strand-wake-protocol.ts`: a dedicated libp2p protocol id,
 * 4-byte big-endian length-prefixed JSON frames, `node.handle` for the receiver,
 * `node.dialProtocol` for the client, and the shared `ControlStream` primitives
 * from `control-stream.ts`. The exchange is a single request → single response on
 * one stream, so each side reads to EOF (under a read timeout) and decodes one
 * frame via the shared {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** like wake, the request carries no signature. Membership
 * is checked before this handler runs, by the control node's protocol guard
 * (`control-protocol-guard.ts`, the `members` class: `CadreNode.isAuthorizedMember`,
 * a voucher on the requester's `CadrePeer` row verified against the node-local
 * trusted-owner anchor). A peer it refuses gets its stream reset, never a reply, so
 * an outsider that published its own rows into the replicated control DB can neither
 * harvest live strand addresses nor announce a delegate. Cross-party strand bootstrap
 * is a different mechanism (strand formation / `MemberPeer`) and is out of scope here.
 */

import debug from 'debug';
import type { Libp2p, Connection, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { StrandAddrRequest, StrandAddrResponse, StrandAddrStatus } from './types.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { orderSignalingFirst } from './peer-record.js';
import { type ControlStream, withDeadline, exchangeFrame, readStreamToEnd, replyAndClose } from './control-stream.js';
import { relayedRequestBudgetMs } from './link-budget.js';

const log = debug('sereus:cadre:strand-addr');

/** Protocol id for the control-network strand-address RPC (parallel to `/sereus/strand-wake/1.0.0`). */
export const STRAND_ADDR_PROTOCOL = '/sereus/strand-addr/1.0.0';

/**
 * Maximum strand-addr frame size. Responses are tiny (a strand id + a few
 * multiaddrs), so this is a defensive cap — far below the 1MB seed ceiling —
 * that bounds the bytes a peer can make the receiver buffer per stream.
 */
const MAX_ADDR_SIZE = 64 * 1024;

/** Default time the receiver waits for an inbound request frame before aborting (ms). */
// eslint-disable-next-line no-restricted-syntax -- link-independent: a receiver cap on one small request frame on a stream the peer already opened; it bounds a peer that opens a stream and never sends, not the dial
const DEFAULT_ADDR_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound strand-addr streams a single peer can pin open. */
const DEFAULT_MAX_CONCURRENT_ADDRS = 100;

/**
 * Read a libp2p stream to EOF and decode the single length-prefixed JSON frame
 * it carries. Bounded by `timeoutMs` (a never-half-closing peer is aborted, not
 * awaited forever) and capped at {@link MAX_ADDR_SIZE}, reusing the shared
 * {@link decodeLengthPrefixedFrame} guard for the prefix/length checks.
 */
async function readFrame<T>(stream: ControlStream, timeoutMs: number): Promise<T> {
  const data = await readStreamToEnd(stream, { maxBytes: MAX_ADDR_SIZE, timeoutMs, label: 'Strand-addr' });
  const body = decodeLengthPrefixedFrame(data, MAX_ADDR_SIZE);
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

/** An address-free reply, for every path but a lookup: over the cap, an unreadable request, a lookup that threw. */
function addrlessResponse(status: StrandAddrStatus, strandId: string): StrandAddrResponse {
  return { status, strandId, multiaddrs: [] };
}

/**
 * Dependencies the {@link StrandAddrService} receiver needs from its host
 * (`CadreNode`), injected so the service is testable without a full node.
 */
export interface StrandAddrServiceOptions {
  /**
   * The local strand instance's dialable strand-network multiaddrs, ordered
   * signaling-first. Returns `[]` when the strand is not running / has no live
   * node (hibernating, quiescing, or never participated). Kept injectable so the
   * decision logic is unit-testable without a full node.
   */
  getStrandMultiaddrs(strandId: string): string[];
  /**
   * Called when a member's request carries a `delegatePeerId` — the derived
   * transport peerId its strand-`strandId` node runs as, with a validated
   * (parseable, non-self) peerId. Every caller is an authorized member: the
   * protocol guard admitted it before this handler ran.
   * `CadreNode` injects its delegate-admission grant recorder so this node's
   * connection gate — and thus its circuit-relay server, when it runs one —
   * admits that peerId (see `delegate-admission.ts`). Optional: absent, an
   * announce is ignored and the address lookup proceeds unchanged.
   */
  onDelegateAnnounce?(announcerPeerId: string, strandId: string, delegatePeerId: string): void;
  /**
   * Time to wait for the inbound request frame before aborting the read (ms).
   * Defaults to {@link DEFAULT_ADDR_READ_TIMEOUT_MS}. Bounds a buggy/compromised
   * own-cadre node that opens a stream and never half-closes its write end.
   */
  readTimeoutMs?: number;
  /**
   * Cap on concurrent inbound strand-addr streams (defaults to
   * {@link DEFAULT_MAX_CONCURRENT_ADDRS}). Over the cap, an `unavailable` reply is
   * returned without looking up any strand address.
   */
  maxConcurrent?: number;
}

/**
 * Receiver side of the strand-address RPC. Registers a `STRAND_ADDR_PROTOCOL`
 * handler on the control node and, for each inbound {@link StrandAddrRequest}
 * (from a peer the protocol guard has already admitted as an authorized member),
 * replies with the local strand instance's live multiaddrs — `ok` with an empty
 * list when the strand is not running, `unavailable` when it could not answer at all.
 */
export class StrandAddrService {
  private readonly options: StrandAddrServiceOptions;
  private readonly readTimeoutMs: number;
  private readonly maxConcurrent: number;
  private node: Libp2p | null = null;
  /** In-flight inbound strand-addr streams, used to enforce {@link maxConcurrent}. */
  private activeStreams = 0;

  constructor(options: StrandAddrServiceOptions) {
    this.options = options;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_ADDR_READ_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_ADDRS;
  }

  /** Number of in-flight inbound strand-addr streams. */
  get activeCount(): number {
    return this.activeStreams;
  }

  /**
   * Register the strand-addr protocol handler on the control node. Rejects when
   * libp2p refuses the registration (a duplicate handler, a peer-store write
   * failure); the node reference is kept only once the handler is in place.
   */
  async initialize(node: Libp2p): Promise<void> {
    // `runOnLimitedConnection: true` is REQUIRED for the relay path: a NAT'd
    // sibling is reached over a circuit-relay connection, which libp2p marks
    // "limited" (the relay caps its data/duration). Without this the receiver
    // would refuse the inbound stream on exactly the connection the protocol is
    // designed to use (same reasoning as wake; see the relay note on
    // `collectStrandAddrs`).
    await node.handle(STRAND_ADDR_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleStream(rawStream as ControlStream, remotePeerId);
    }, { runOnLimitedConnection: true });
    this.node = node;
    log('StrandAddrService registered handler: %s', STRAND_ADDR_PROTOCOL);
  }

  /** Unregister the handler and release the node reference. */
  async shutdown(): Promise<void> {
    if (this.node) {
      await this.node.unhandle(STRAND_ADDR_PROTOCOL);
      this.node = null;
      log('StrandAddrService shutdown');
    }
  }

  /**
   * Read the inbound request, decide the response, and write it back.
   *
   * Three hardening layers, all reported as an `unavailable`
   * {@link StrandAddrResponse} rather than a dropped/hung stream: a concurrency cap
   * (over {@link maxConcurrent}, reply without looking up any address), a read
   * timeout (a peer that never half-closes is aborted inside {@link readFrame}/
   * `readStreamToEnd`), and the existing malformed/oversized-frame guard. A
   * lookup that throws is `unavailable` too, never an empty `ok` the asker would
   * wait ten minutes on.
   */
  private async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    log('Incoming strand-addr request from: %s', remotePeerId);

    if (this.activeStreams >= this.maxConcurrent) {
      log('Rejecting strand-addr from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrent);
      // The request frame is unread here, so the strand id is unknown — reply
      // under an empty strand id; the asker retries an `unavailable` sibling soon.
      await replyAndClose(stream, addrlessResponse('unavailable', ''), 'Strand-addr');
      return;
    }

    this.activeStreams++;
    try {
      await replyAndClose(stream, await this.answerStream(stream, remotePeerId), 'Strand-addr');
    } finally {
      this.activeStreams--;
    }
  }

  /** Read and decide one inbound request; any failure becomes an `unavailable` response. */
  private async answerStream(stream: ControlStream, remotePeerId: string): Promise<StrandAddrResponse> {
    try {
      const request = await readFrame<StrandAddrRequest>(stream, this.readTimeoutMs);
      return await this.processAddrRequest(request, remotePeerId);
    } catch (err) {
      log('Error handling strand-addr request from %s: %o', remotePeerId, err);
      // Malformed/oversized/timed-out request, or a lookup that threw: reply
      // under an empty strand id rather than hanging.
      return addrlessResponse('unavailable', '');
    }
  }

  /**
   * Decide the response for a decoded request. Exposed (not private) so the
   * decision matrix can be unit-tested directly (mirrors wake's
   * `processWakeRequest`).
   *
   * - Request carrying a `delegatePeerId` → recorded via
   *   {@link StrandAddrServiceOptions.onDelegateAnnounce} before the lookup.
   * - Strand not running locally → `ok` with empty `multiaddrs` (`getStrandMultiaddrs` → `[]`).
   * - Running strand → `ok` with the strand's live, signaling-first multiaddrs.
   *
   * A throwing lookup propagates; {@link handleStream} answers it `unavailable`.
   */
  async processAddrRequest(request: StrandAddrRequest, remotePeerId: string): Promise<StrandAddrResponse> {
    this.recordDelegateAnnounce(request, remotePeerId);

    const multiaddrs = this.options.getStrandMultiaddrs(request.strandId);
    log('Strand-addr for %s → %d addr(s)', request.strandId, multiaddrs.length);
    return { status: 'ok', strandId: request.strandId, multiaddrs };
  }

  /**
   * Validate and forward a member's delegate announcement. A malformed field
   * (unparsable peerId) and a self-announcement (`delegatePeerId` equal to the
   * announcer's own peerId — a member is admitted directly, never by grant)
   * are logged and dropped; the address lookup proceeds either way.
   */
  private recordDelegateAnnounce(request: StrandAddrRequest, remotePeerId: string): void {
    const { strandId, delegatePeerId } = request;
    if (delegatePeerId === undefined || !this.options.onDelegateAnnounce) {
      return;
    }
    if (delegatePeerId === remotePeerId) {
      log('Ignoring self-announcement from %s (strand %s)', remotePeerId, strandId);
      return;
    }
    try {
      peerIdFromString(delegatePeerId);
    } catch (err) {
      log('Ignoring malformed delegatePeerId %o from %s: %o', delegatePeerId, remotePeerId, err);
      return;
    }
    this.options.onDelegateAnnounce(remotePeerId, strandId, delegatePeerId);
  }
}

/** A sibling to ask for its strand address. */
export interface StrandAddrPeer {
  /** The sibling's control-network peer id (also its strand-node peer id). */
  peerId: string;
  /**
   * Pre-resolved control-network multiaddrs, used as a fallback when no control
   * connection is already open. Dialing by {@link peerId} is preferred (it
   * reuses an existing connection); these are tried only if that fails.
   */
  addrs?: Multiaddr[];
}

/** Options for {@link collectStrandAddrs}. */
export interface CollectStrandAddrsOptions {
  /**
   * The asker's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which the
   * per-dial timeout is derived when {@link timeoutMs} is not given. Unset means the declared
   * default.
   */
  linkRoundTripMs?: number;
  /** Per-dial timeout in ms (default: {@link attemptTimeoutMs}). */
  timeoutMs?: number;
  /** Override the protocol id (defaults to {@link STRAND_ADDR_PROTOCOL}). */
  protocolId?: string;
  /**
   * The derived transport peerId the caller's own strand-`strandId` node runs
   * (or is about to run) as. Set on every request this collection sends, so
   * each receiver records a delegate admission grant for it — see
   * {@link StrandAddrRequest.delegatePeerId}. Omit for a pure address lookup.
   */
  delegatePeerId?: string;
}

/**
 * What asking one sibling produced, as {@link collectStrandAddrs} reports it.
 *
 * - `answered` — status `ok` with at least one address.
 * - `empty` — status `ok` with no address: the sibling does not run the strand
 *   right now, a normal steady state.
 * - `unavailable` — the sibling replied that it could not answer.
 * - `unreachable` — no reply at all: every dial target failed or timed out, the
 *   reply was malformed, or the sibling's protocol guard reset the stream because
 *   it does not (yet) count the asker as an authorized member.
 */
export type StrandAddrOutcome = 'answered' | 'empty' | 'unavailable' | 'unreachable';

/** Result of {@link collectStrandAddrs}. */
export interface StrandAddrCollection {
  /** Deduplicated union of every answer, signaling-first. */
  addrs: string[];
  /** One entry per candidate (self excluded), keyed by the sibling's control peerId. */
  outcomes: Map<string, StrandAddrOutcome>;
}

/** One sibling's share of a {@link StrandAddrCollection}. */
interface SiblingAnswer {
  outcome: StrandAddrOutcome;
  multiaddrs: string[];
}

/**
 * Client side: ask each candidate sibling for its live strand-`strandId`
 * multiaddrs and return the **deduplicated union** of every answer, ordered
 * signaling-first, alongside each sibling's {@link StrandAddrOutcome}.
 *
 * Best-effort per peer: a failed/timed-out/empty sibling contributes no address
 * and never fails the collection — an empty union (no sibling online or running
 * the strand) is an acceptable seed that self-heals on the next resume/reconcile
 * pass. `outcomes` is what lets a caller retry the siblings that could not answer
 * sooner than the ones that answered with nothing. The local node (`node.peerId`)
 * is excluded so we never RPC ourselves or seed with our own strand address.
 *
 * Dials run concurrently but the union preserves candidate order, so the result
 * is deterministic regardless of which sibling answers first.
 */
export async function collectStrandAddrs(
  node: Libp2p,
  peers: StrandAddrPeer[],
  strandId: string,
  options: CollectStrandAddrsOptions = {}
): Promise<StrandAddrCollection> {
  const selfId = node.peerId.toString();
  const request: StrandAddrRequest = options.delegatePeerId !== undefined
    ? { strandId, delegatePeerId: options.delegatePeerId }
    : { strandId };
  const candidates = peers.filter(p => p.peerId !== selfId);

  // Concurrent dials; `dialOneSibling` folds per-peer failure into an outcome, so
  // `Promise.all` never rejects and the result array stays in candidate order.
  const answers = await Promise.all(
    candidates.map(async (peer) => ({ peerId: peer.peerId, ...await dialOneSibling(node, peer, request, options) }))
  );

  const outcomes = new Map<string, StrandAddrOutcome>();
  // Deduplicated union in candidate order, then signaling-first for a usable
  // dial sequence (relay/`p2p-circuit` ahead of direct addrs).
  const seen = new Set<string>();
  const union: string[] = [];
  for (const { peerId, outcome, multiaddrs } of answers) {
    outcomes.set(peerId, outcome);
    for (const addr of multiaddrs) {
      if (!seen.has(addr)) {
        seen.add(addr);
        union.push(addr);
      }
    }
  }
  return { addrs: orderSignalingFirst(union), outcomes };
}

/**
 * Ask one sibling for its strand address. Tries each dial target in order (peerId
 * first to reuse an open control connection, then explicit addrs) until one
 * produces a well-formed reply, and reports that reply's outcome; a total failure
 * is `unreachable`, so a single dead sibling never aborts the collection. Never
 * throws.
 *
 * A reply of any status ends the loop: every target reaches the same responder,
 * so asking it again by another address would get the same answer.
 *
 * A total failure logs ONE line naming every target and its cause, because
 * per-target lines scattered through a concurrent fan-out do not reassemble into
 * "this sibling was unreachable".
 *
 * NOTE: cost is (targets × `timeoutMs`, 28.5 s each at the default declared link) with
 * no whole-sibling budget, the same shape `dialWake` bounds with
 * `DEFAULT_WAKE_DIAL_BUDGET_MS`. Siblings are asked concurrently, so a collection costs
 * its slowest sibling, not the sum. Fine today — `dialTargets` yields the peerId plus
 * whatever `resolvePeerAddrs` returned, which for a cadre device is one or two
 * addresses. If a sibling's record ever carries a long address list, give this the same
 * whole-sibling budget.
 */
async function dialOneSibling(
  node: Libp2p,
  peer: StrandAddrPeer,
  request: StrandAddrRequest,
  options: CollectStrandAddrsOptions
): Promise<SiblingAnswer> {
  const protocolId = options.protocolId ?? STRAND_ADDR_PROTOCOL;
  const timeoutMs = attemptTimeoutMs(options);
  const targets = dialTargets(peer);

  if (targets.length === 0) {
    log('No dial target for sibling %s', peer.peerId);
    return { outcome: 'unreachable', multiaddrs: [] };
  }

  const failures: string[] = [];
  for (const target of targets) {
    try {
      // One deadline per attempt: its signal aborts the in-flight dialProtocol and
      // resets the live stream, so neither the connect nor the response-read leaks.
      const response = await withDeadline(
        timeoutMs,
        `Strand-addr dial ${peer.peerId}`,
        (signal) => sendStrandAddr(node, target, protocolId, request, timeoutMs, signal),
      );
      return siblingAnswer(response);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failures.push(`${describeTarget(target)} — ${error.message}`);
      log('Strand-addr dial to %s via %s failed: %o', peer.peerId, describeTarget(target), err);
    }
  }
  log('Strand-addr dial to %s failed on all %d target(s), contributing no addrs: %s',
    peer.peerId, failures.length, failures.join('; '));
  return { outcome: 'unreachable', multiaddrs: [] };
}

/**
 * Deadline for ONE attempt to ask a sibling — dial, request, response — unless the caller set
 * its own: `relayedRequestBudgetMs` at the declared link (28.5 s at the default).
 *
 * An attempt is either a dial by peer id, which normally reuses an open control connection
 * (`CIRCUIT_REQUEST_ROUND_TRIPS`, 2), or the fallback to the sibling's control addresses, a
 * fresh and possibly relayed dial. One deadline covers both, so it is sized for the fallback.
 *
 * NOTE: the receiver's membership check (two live control reads) runs inside this deadline and
 * is not counted. In steady state those reads touch only held blocks and do not consult the
 * cohort. If a wake or address request is seen timing out while the receiver's membership read
 * is consulting, count one membership decision in this deadline or answer the check from the
 * materialized authorized-peer snapshot. See docs/cadre-consistency.md → "Deadlines Over
 * Optimystic's Reads and Commits".
 */
function attemptTimeoutMs(options: CollectStrandAddrsOptions): number {
  return options.timeoutMs ?? relayedRequestBudgetMs(options.linkRoundTripMs);
}

/** Map a validated reply to its outcome; only an `ok` reply contributes addresses. */
function siblingAnswer(response: StrandAddrResponse): SiblingAnswer {
  if (response.status !== 'ok') {
    return { outcome: response.status, multiaddrs: [] };
  }
  return {
    outcome: response.multiaddrs.length > 0 ? 'answered' : 'empty',
    multiaddrs: response.multiaddrs
  };
}

/**
 * Dial targets for a sibling, peerId first. Dialing by peerId lets libp2p reuse
 * an already-open control connection (the common case — the wiring ticket passes
 * connected siblings); the explicit control addrs are a fallback for when no
 * connection is open. An unparsable peerId is skipped (rely on addrs).
 */
function dialTargets(peer: StrandAddrPeer): Array<PeerId | Multiaddr> {
  const targets: Array<PeerId | Multiaddr> = [];
  try {
    targets.push(peerIdFromString(peer.peerId));
  } catch (err) {
    log('Unparsable peer id %s, falling back to addrs: %o', peer.peerId, err);
  }
  if (peer.addrs) {
    targets.push(...peer.addrs);
  }
  return targets;
}

/** Short label for a dial target (peerId or multiaddr) for logging. */
function describeTarget(target: PeerId | Multiaddr): string {
  return target.toString();
}

/**
 * Open one stream to a target, send the request, half-close, and read the
 * response.
 *
 * `signal` is the per-attempt deadline from {@link dialOneSibling}: it goes to
 * `dialProtocol` so a timeout during connect aborts the dial, and into
 * {@link exchangeFrame} so a timeout after the stream is open resets it —
 * releasing the otherwise unbounded response-read.
 */
async function sendStrandAddr(
  node: Libp2p,
  target: PeerId | Multiaddr,
  protocolId: string,
  request: StrandAddrRequest,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<StrandAddrResponse> {
  // `runOnLimitedConnection: true`: the sibling may be reachable only over a
  // circuit-relay connection (the signaling-first addr), which libp2p marks
  // "limited". The exchange is a single tiny request→response well within the
  // relay's data/duration cap, so opening it on the limited connection is safe
  // and is the whole point of dialing over the relay.
  const rawStream = await node.dialProtocol(target, protocolId, { runOnLimitedConnection: true, signal });

  const response = await exchangeFrame(
    rawStream as unknown as ControlStream,
    signal,
    request,
    (stream) => readFrame<unknown>(stream, timeoutMs),
    'Strand-addr dial aborted by timeout',
  );
  if (!isStrandAddrResponse(response)) {
    throw new Error('Malformed strand-addr response');
  }

  log('Strand-addr response: %s, %d addr(s) for %s', response.status, response.multiaddrs.length, response.strandId);
  return response;
}

const STRAND_ADDR_STATUSES: ReadonlySet<string> = new Set<StrandAddrStatus>(['ok', 'unavailable']);

/**
 * Shape check on a decoded reply: the responder is another machine, so a reply
 * missing its status (an older responder, or a buggy one) or carrying anything but
 * strings in `multiaddrs` is a failed exchange, not an answer.
 *
 * Deliberately not `sanitizeStrandAddrs` (strand-formation-protocol.ts): that drops
 * bad entries and caps the list at 16, which suits a cross-party formation result
 * but would silently truncate a sibling's full address list here.
 */
function isStrandAddrResponse(value: unknown): value is StrandAddrResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { status, strandId, multiaddrs } = value as Record<string, unknown>;
  return typeof status === 'string' && STRAND_ADDR_STATUSES.has(status)
    && typeof strandId === 'string'
    && Array.isArray(multiaddrs) && multiaddrs.every((addr) => typeof addr === 'string');
}
