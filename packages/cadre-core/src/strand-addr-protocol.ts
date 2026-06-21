/**
 * Control-network strand-address RPC.
 *
 * A strand runs as its own libp2p node (`strand-<id>`, random port), separate
 * from the control node (`control-<partyId>`) even though both share the same
 * peerId. To seed a strand's mesh, a node needs a sibling's **strand-network**
 * address — but `CadrePeer.Multiaddr` only stores the **control** node's
 * addresses. This protocol resolves the strand address on demand: a node asks
 * its connected co-cadre siblings "what are your live strand-`X` multiaddrs?" and
 * uses the union of their answers as the seed.
 *
 * Modeled directly on `strand-wake-protocol.ts`: a dedicated libp2p protocol id,
 * 4-byte big-endian length-prefixed JSON frames, `node.handle` for the receiver,
 * `node.dialProtocol` for the client, and the shared `ControlStream` primitives
 * from `control-stream.ts`. The exchange is a single request → single response on
 * one stream, so each side reads to EOF (under a read timeout) and decodes one
 * frame via the shared {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** the control network is single-party — only this party's
 * cadre peers connect (schema-gated `CadrePeer`). Like wake, the receiver gates
 * on cadre membership (via the injected `isMember`) and requires no further
 * signature; a non-member is refused with an empty address list. This is
 * defense-in-depth (the control mesh already restricts membership) kept for
 * parity with wake. Cross-party strand bootstrap is a different mechanism
 * (strand formation / `MemberPeer`) and is out of scope here.
 */

import debug from 'debug';
import type { Libp2p, Connection, PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import type { StrandAddrRequest, StrandAddrResponse } from './types.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { orderSignalingFirst } from './peer-record.js';
import { type ControlStream, writeFrame, withTimeout, readStreamToEnd } from './control-stream.js';

const log = debug('sereus:cadre:strand-addr');

/** Protocol id for the control-network strand-address RPC (parallel to `/sereus/strand-wake/1.0.0`). */
export const STRAND_ADDR_PROTOCOL = '/sereus/strand-addr/1.0.0';

/**
 * Maximum strand-addr frame size. Responses are tiny (a strand id + a few
 * multiaddrs), so this is a defensive cap — far below the 1MB seed ceiling —
 * that bounds the bytes a peer can make the receiver buffer per stream.
 */
const MAX_ADDR_SIZE = 64 * 1024;

/** Default time to wait for the response before abandoning a strand-addr dial (ms). */
const DEFAULT_ADDR_TIMEOUT_MS = 10_000;

/** Default time the receiver waits for an inbound request frame before aborting (ms). */
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

/** Empty response used on every reject/error path (cap, malformed frame, non-member). */
function emptyResponse(strandId: string): StrandAddrResponse {
  return { strandId, multiaddrs: [] };
}

/**
 * Dependencies the {@link StrandAddrService} receiver needs from its host
 * (`CadreNode`), injected so the service is testable without a full node.
 */
export interface StrandAddrServiceOptions {
  /** Membership gate: is the remote peer a `CadrePeer` member of this cadre? */
  isMember(remotePeerId: string): Promise<boolean>;
  /**
   * The local strand instance's dialable strand-network multiaddrs, ordered
   * signaling-first. Returns `[]` when the strand is not running / has no live
   * node (hibernating, quiescing, or never participated). Kept injectable so the
   * decision logic is unit-testable without a full node.
   */
  getStrandMultiaddrs(strandId: string): string[];
  /**
   * Time to wait for the inbound request frame before aborting the read (ms).
   * Defaults to {@link DEFAULT_ADDR_READ_TIMEOUT_MS}. Bounds a buggy/compromised
   * own-cadre node that opens a stream and never half-closes its write end.
   */
  readTimeoutMs?: number;
  /**
   * Cap on concurrent inbound strand-addr streams (defaults to
   * {@link DEFAULT_MAX_CONCURRENT_ADDRS}). Over the cap, an empty response is
   * returned without looking up any strand address.
   */
  maxConcurrent?: number;
}

/**
 * Receiver side of the strand-address RPC. Registers a `STRAND_ADDR_PROTOCOL`
 * handler on the control node and, for each inbound {@link StrandAddrRequest},
 * gates on cadre membership, then replies with the local strand instance's live
 * multiaddrs (or an empty list when not a member / not running).
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

  /** Register the strand-addr protocol handler on the control node. */
  initialize(node: Libp2p): void {
    this.node = node;
    // `runOnLimitedConnection: true` is REQUIRED for the relay path: a NAT'd
    // sibling is reached over a circuit-relay connection, which libp2p marks
    // "limited" (the relay caps its data/duration). Without this the receiver
    // would refuse the inbound stream on exactly the connection the protocol is
    // designed to use (same reasoning as wake; see the relay note on
    // `collectStrandAddrs`).
    void node.handle(STRAND_ADDR_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleStream(rawStream as ControlStream, remotePeerId);
    }, { runOnLimitedConnection: true });
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
   * Three hardening layers, all reported as an empty {@link StrandAddrResponse}
   * rather than a dropped/hung stream: a concurrency cap (over
   * {@link maxConcurrent}, reply without looking up any address), a read timeout
   * (a peer that never half-closes is aborted inside {@link readFrame}/
   * `readStreamToEnd`), and the existing malformed/oversized-frame guard.
   */
  private async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    log('Incoming strand-addr request from: %s', remotePeerId);

    if (this.activeStreams >= this.maxConcurrent) {
      log('Rejecting strand-addr from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrent);
      // The request frame is unread here, so the strand id is unknown — reply
      // with an empty list under an empty strand id; the client treats any empty
      // response as "no addrs" and skips this sibling.
      try {
        writeFrame(stream, emptyResponse(''));
      } catch {
        // Ignore send errors on the reject path.
      }
      try {
        await stream.close();
      } catch {
        // Ignore close errors.
      }
      return;
    }

    this.activeStreams++;
    try {
      const request = await readFrame<StrandAddrRequest>(stream, this.readTimeoutMs);
      const response = await this.processAddrRequest(request, remotePeerId);
      writeFrame(stream, response);
    } catch (err) {
      log('Error handling strand-addr request from %s: %o', remotePeerId, err);
      // Malformed/oversized/timed-out request: strand id is unknown, so reply
      // with an empty list under an empty strand id rather than hanging.
      try {
        writeFrame(stream, emptyResponse(''));
      } catch {
        // Ignore send errors on the error path.
      }
    } finally {
      this.activeStreams--;
      try {
        await stream.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  /**
   * Decide the response for a decoded request. Exposed (not private) so the
   * decision matrix can be unit-tested directly (mirrors wake's
   * `processWakeRequest`).
   *
   * - Non-member sender → empty `multiaddrs` (refused).
   * - Strand not running locally → empty `multiaddrs` (`getStrandMultiaddrs` → `[]`).
   * - Member + running strand → the strand's live, signaling-first multiaddrs.
   */
  async processAddrRequest(request: StrandAddrRequest, remotePeerId: string): Promise<StrandAddrResponse> {
    // Control-network membership is the v1 authorization: only this party's
    // cadre peers may ask us for a strand address.
    if (!(await this.options.isMember(remotePeerId))) {
      log('Refusing strand-addr from non-member %s', remotePeerId);
      return emptyResponse(request.strandId);
    }

    const multiaddrs = this.options.getStrandMultiaddrs(request.strandId);
    log('Strand-addr for %s → %d addr(s)', request.strandId, multiaddrs.length);
    return { strandId: request.strandId, multiaddrs };
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
  /** Per-dial timeout in ms (default {@link DEFAULT_ADDR_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Override the protocol id (defaults to {@link STRAND_ADDR_PROTOCOL}). */
  protocolId?: string;
}

/**
 * Client side: ask each candidate sibling for its live strand-`strandId`
 * multiaddrs and return the **deduplicated union** of every answer, ordered
 * signaling-first.
 *
 * Best-effort per peer: a failed/timed-out/empty sibling is logged and skipped,
 * never fatal — an empty union (no sibling online or running the strand) returns
 * `[]`, which the caller treats as an acceptable seed that self-heals on the next
 * resume/reconcile pass. The local node (`node.peerId`) is excluded so we never
 * RPC ourselves or seed with our own strand address.
 *
 * Dials run concurrently but the union preserves candidate order, so the result
 * is deterministic regardless of which sibling answers first.
 */
export async function collectStrandAddrs(
  node: Libp2p,
  peers: StrandAddrPeer[],
  strandId: string,
  options: CollectStrandAddrsOptions = {}
): Promise<string[]> {
  const selfId = node.peerId.toString();
  const request: StrandAddrRequest = { strandId };
  const candidates = peers.filter(p => p.peerId !== selfId);

  // Concurrent dials; `dialOneSibling` swallows per-peer failure into `[]`, so
  // `Promise.all` never rejects and the result array stays in candidate order.
  const perPeer = await Promise.all(
    candidates.map(peer => dialOneSibling(node, peer, request, options))
  );

  // Deduplicated union in candidate order, then signaling-first for a usable
  // dial sequence (relay/`p2p-circuit` ahead of direct addrs).
  const seen = new Set<string>();
  const union: string[] = [];
  for (const addrs of perPeer) {
    for (const addr of addrs) {
      if (!seen.has(addr)) {
        seen.add(addr);
        union.push(addr);
      }
    }
  }
  return orderSignalingFirst(union);
}

/**
 * Ask one sibling for its strand address, returning its multiaddrs or `[]` on any
 * failure. Tries each dial target in order (peerId first to reuse an open control
 * connection, then explicit addrs) until one answers; a total failure is logged
 * and folded to `[]` so a single dead sibling never aborts the collection.
 */
async function dialOneSibling(
  node: Libp2p,
  peer: StrandAddrPeer,
  request: StrandAddrRequest,
  options: CollectStrandAddrsOptions
): Promise<string[]> {
  const protocolId = options.protocolId ?? STRAND_ADDR_PROTOCOL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADDR_TIMEOUT_MS;
  const targets = dialTargets(peer);

  if (targets.length === 0) {
    log('No dial target for sibling %s', peer.peerId);
    return [];
  }

  for (const target of targets) {
    // One controller per attempt: on timeout, `withTimeout`'s `onTimeout` aborts
    // it, which aborts the in-flight dialProtocol (via the dial `signal`) and the
    // live stream — so neither the connect nor the unbounded response-read leaks.
    const controller = new AbortController();
    try {
      const response = await withTimeout(
        timeoutMs,
        `Strand-addr dial ${peer.peerId}`,
        () => sendStrandAddr(node, target, protocolId, request, timeoutMs, controller.signal),
        () => controller.abort(),
      );
      return response.multiaddrs;
    } catch (err) {
      log('Strand-addr dial to %s via %s failed: %o', peer.peerId, describeTarget(target), err);
    }
  }
  return [];
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
 * `signal` is the per-attempt abort signal from {@link dialOneSibling}: it is
 * passed to `dialProtocol` so a timeout during connect aborts the dial, and once
 * the stream is open an abort listener resets the live stream — releasing the
 * otherwise unbounded response-read. `readFrame` still applies `timeoutMs` as a
 * backstop for the case where an abort does not propagate (e.g. a stream double
 * whose `abort()` is a no-op).
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
  const stream = rawStream as unknown as ControlStream;

  const abortErr = new Error('Strand-addr dial aborted by timeout');
  const onAbort = (): void => stream.abort(abortErr);
  // If the timeout already fired during connect, release the freshly-opened stream now.
  if (signal.aborted) {
    onAbort();
    throw abortErr;
  }
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    writeFrame(stream, request);
    // close() half-closes the write end (EOF) while the read end stays open for
    // the response — the same libp2p 3.x pattern as wake/seed delivery.
    await stream.close();
    const response = await readFrame<StrandAddrResponse>(stream, timeoutMs);
    log('Strand-addr response: %d addr(s) for %s', response.multiaddrs.length, response.strandId);
    return response;
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
