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
 * `node.dialProtocol` for the sender, and the same minimal `LibP2PStream` shim.
 * The exchange is a single request → single ack on one stream (like seed
 * delivery), so each side reads to EOF and decodes one frame via the shared
 * {@link decodeLengthPrefixedFrame} guard.
 *
 * **Authorization (v1):** the control network already restricts membership —
 * only this party's cadre peers connect (schema-gated `CadrePeer`). A wake is
 * low-risk: it only causes the receiver to spend resources coming online for a
 * strand it already participates in. So the receiver verifies the remote peer is
 * a `CadrePeer` member (via the injected `isMember` gate) and requires no
 * signature beyond control-network membership. A richer per-request signature is
 * deliberately out of scope for v1.
 */

import debug from 'debug';
import type { Libp2p, Connection } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { StrandInstance, WakeRequest, WakeAck } from './types.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';

const log = debug('sereus:cadre:strand-wake');

/** Protocol id for control-network push-wake (parallel to `/sereus/seed/1.0.0`). */
export const WAKE_PROTOCOL = '/sereus/strand-wake/1.0.0';

/**
 * Maximum wake frame size. Wake messages are tiny (a strand id + short reason),
 * so this is a defensive cap — far below the 1MB seed ceiling — that bounds the
 * bytes a peer can make the receiver buffer per stream.
 */
const MAX_WAKE_SIZE = 64 * 1024;

/** Default time to wait for the ack before abandoning a wake dial (ms). */
const DEFAULT_WAKE_TIMEOUT_MS = 10_000;

/**
 * Minimal libp2p stream surface (libp2p 3.x): AsyncIterable for reads, `send()`
 * for writes. Mirrors the shape used in `seed-bootstrap.ts`.
 */
interface LibP2PStream extends AsyncIterable<Uint8Array> {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(err: Error): void;
}

/** Write a JSON object as a single 4-byte big-endian length-prefixed frame. */
function writeFrame(stream: LibP2PStream, obj: unknown): void {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, body.length, false);
  stream.send(prefix);
  stream.send(body);
}

/**
 * Read a libp2p stream to EOF and decode the single length-prefixed JSON frame
 * it carries. Caps the accumulated bytes at {@link MAX_WAKE_SIZE} and reuses the
 * shared {@link decodeLengthPrefixedFrame} guard for the prefix/length checks.
 */
async function readFrame<T>(stream: AsyncIterable<Uint8Array>): Promise<T> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
    chunks.push(bytes);
    total += bytes.length;
    if (total > MAX_WAKE_SIZE) {
      throw new Error(`Wake message too large: ${total} bytes exceeds max ${MAX_WAKE_SIZE}`);
    }
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  const body = decodeLengthPrefixedFrame(data, MAX_WAKE_SIZE);
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

/** Reject if `op` does not settle within `ms`. */
function withTimeout<T>(ms: number, label: string, op: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Wake ${label} timed out after ${ms}ms`)), ms);
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
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
   */
  wake(strandId: string): Promise<void>;
}

/**
 * Receiver side of the push-wake protocol. Registers a `WAKE_PROTOCOL` handler
 * on the control node and, for each inbound {@link WakeRequest}, gates on cadre
 * membership, then resumes the named strand if it is hibernating/idle and we
 * participate in it — replying with a {@link WakeAck}.
 */
export class StrandWakeService {
  private readonly options: StrandWakeServiceOptions;
  private node: Libp2p | null = null;

  constructor(options: StrandWakeServiceOptions) {
    this.options = options;
  }

  /** Register the wake protocol handler on the control node. */
  initialize(node: Libp2p): void {
    this.node = node;
    // `runOnLimitedConnection: true` is REQUIRED for the relay path: a NAT'd
    // receiver is reached over a circuit-relay connection, which libp2p marks
    // "limited" (the relay caps its data/duration). Without this the receiver
    // would refuse the inbound wake stream on exactly the connection the
    // protocol is designed to use (see the relay note on `dialWake`).
    void node.handle(WAKE_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleStream(rawStream as LibP2PStream, remotePeerId);
    }, { runOnLimitedConnection: true });
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
   * Read the inbound request, decide + execute the wake, and write the ack. A
   * malformed/oversized frame (or any handler error) is reported as a
   * non-accepting ack rather than a dropped stream.
   */
  private async handleStream(stream: LibP2PStream, remotePeerId: string): Promise<void> {
    log('Incoming wake request from: %s', remotePeerId);
    try {
      const request = await readFrame<WakeRequest>(stream);
      const ack = await this.processWakeRequest(request, remotePeerId);
      writeFrame(stream, ack);
    } catch (err) {
      log('Error handling wake request from %s: %o', remotePeerId, err);
      const ack: WakeAck = {
        accepted: false,
        reason: err instanceof Error ? err.message : 'Unknown error',
      };
      try {
        writeFrame(stream, ack);
      } catch {
        // Ignore send errors on the error path.
      }
    } finally {
      try {
        await stream.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  /**
   * Decide and execute the wake for a decoded request. Exposed (not private) so
   * the decision matrix can be unit-tested directly.
   *
   * - Non-member sender → rejected (`accepted: false`).
   * - Unknown / not-participated strand → rejected.
   * - Hibernating or idle strand → resumed via the wake path, then `accepted`.
   * - Already-live strand → no-op, `accepted` with current status.
   */
  async processWakeRequest(request: WakeRequest, remotePeerId: string): Promise<WakeAck> {
    // Control-network membership is the v1 authorization: only this party's
    // cadre peers may ask us to wake.
    if (!(await this.options.isMember(remotePeerId))) {
      log('Rejecting wake from non-member %s', remotePeerId);
      return { accepted: false, reason: 'Sender is not a cadre member' };
    }

    const instance = this.options.getStrand(request.strandId);
    if (!instance) {
      log('Rejecting wake for unknown/unparticipated strand %s', request.strandId);
      return { accepted: false, reason: 'Strand not found or not participated in' };
    }

    if (instance.status === 'hibernating' || instance.status === 'idle') {
      log('Waking strand %s on push from %s (reason=%s)', request.strandId, remotePeerId, request.reason ?? 'unspecified');
      await this.options.wake(request.strandId);
    } else {
      log('Strand %s already %s; push-wake is a no-op', request.strandId, instance.status);
    }

    // The wake path mutates the shared instance, so re-read its current status.
    return { accepted: true, status: instance.status };
  }
}

/** Options for {@link dialWake}. */
export interface DialWakeOptions {
  /** Per-dial timeout in ms (default {@link DEFAULT_WAKE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Override the protocol id (defaults to {@link WAKE_PROTOCOL}). */
  protocolId?: string;
}

/**
 * Sender side: dial a target's control-network address(es), send a
 * {@link WakeRequest} over `WAKE_PROTOCOL`, and return the peer's {@link WakeAck}.
 *
 * Tries each candidate address in order (signaling/relay first, as produced by
 * `CadreNode.resolvePeerAddrs`) until one dials, so a NAT'd peer is reachable via
 * its circuit-relay address. Throws if no address is dialable.
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;

  let lastError: Error | null = null;
  for (const addr of addrs) {
    try {
      return await withTimeout(timeoutMs, `dial ${addr.toString()}`, () => sendWake(node, addr, protocolId, request));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log('Wake dial to %s failed: %o', addr.toString(), err);
    }
  }
  throw lastError ?? new Error('Wake dial failed');
}

/** Open one stream, send the request, half-close, and read the ack. */
async function sendWake(
  node: Libp2p,
  addr: Multiaddr,
  protocolId: string,
  request: WakeRequest
): Promise<WakeAck> {
  // `runOnLimitedConnection: true`: the target may be reachable only over a
  // circuit-relay connection (the signaling-first addr), which libp2p marks
  // "limited". The wake exchange is a single tiny request→ack well within the
  // relay's data/duration cap, so opening it on the limited connection is safe
  // and is the whole point of dialing the relay address.
  const rawStream = await node.dialProtocol(addr, protocolId, { runOnLimitedConnection: true });
  const stream = rawStream as unknown as LibP2PStream;
  try {
    writeFrame(stream, request);
    // close() half-closes the write end (EOF) while the read end stays open for
    // the ack — the same libp2p 3.x pattern as seed delivery.
    await stream.close();
    const ack = await readFrame<WakeAck>(stream);
    log('Wake ack from %s: accepted=%s status=%s', addr.toString(), ack.accepted, ack.status ?? '-');
    return ack;
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}
