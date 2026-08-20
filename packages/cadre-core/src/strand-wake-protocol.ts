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
import { type ControlStream, writeFrame, withDeadline, exchangeFrame, readStreamToEnd } from './control-stream.js';

const log = debug('sereus:cadre:strand-wake');

/** Protocol id for control-network push-wake (parallel to `/sereus/seed/1.0.0`). */
export const WAKE_PROTOCOL = '/sereus/strand-wake/1.0.0';

/**
 * Maximum wake frame size. Wake messages are tiny (a strand id + short reason),
 * so this is a defensive cap — far below the 1MB seed ceiling — that bounds the
 * bytes a peer can make the receiver buffer per stream.
 */
const MAX_WAKE_SIZE = 64 * 1024;

/** Default time to wait for the ack before abandoning ONE wake dial attempt (ms). */
const DEFAULT_WAKE_TIMEOUT_MS = 10_000;

/**
 * Default budget for a WHOLE {@link dialWake} call, in ms — every candidate
 * address together, not each one.
 *
 * Without it the cost of a wake is (candidate count × {@link
 * DEFAULT_WAKE_TIMEOUT_MS}), a number nothing chooses or bounds. That is not
 * hypothetical: an address behind a dropped NAT mapping, or any host that
 * blackholes rather than sending a RST, burns its full attempt timeout instead
 * of failing in milliseconds, so a two-address peer costs 20 s and a
 * five-address one costs 50 s.
 *
 * This makes the TARGET PEER the unit rather than the address — the same
 * decision, for the same reason, as
 * `DEFAULT_CONTROL_COHORT_DIAL_TIMEOUT_MS` in `control-cohort.ts`, and the same
 * chosen number. 20 s is deliberately wider than one attempt timeout so a
 * reachable peer whose signaling address is stale still gets a genuine try at
 * its direct one; a peer needing longer than that is not "asleep and reachable",
 * which is the only case a wake is for. The last attempt inside the budget gets
 * whatever remains of it, so the call returns at the budget, not past it.
 *
 * Override per call with {@link DialWakeOptions.budgetMs} — tests that drive
 * dead addresses on purpose set it low so a dial's duration is a chosen number
 * rather than a transitive libp2p default stretched by machine load.
 */
export const DEFAULT_WAKE_DIAL_BUDGET_MS = 20_000;

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
   */
  maxConcurrent?: number;
}

/**
 * Receiver side of the push-wake protocol. Registers a `WAKE_PROTOCOL` handler
 * on the control node and, for each inbound {@link WakeRequest}, gates on cadre
 * membership, then resumes the named strand if it is hibernating/idle and we
 * participate in it — replying with a {@link WakeAck}.
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
      await this.handleStream(rawStream as ControlStream, remotePeerId);
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
   * Read the inbound request, decide + execute the wake, and write the ack.
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
      const ack: WakeAck = { accepted: false, reason: 'Too many concurrent wake requests' };
      try {
        writeFrame(stream, ack);
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
      const request = await readFrame<WakeRequest>(stream, this.readTimeoutMs);
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
      this.activeStreams--;
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
  /** Per-ATTEMPT timeout in ms (default {@link DEFAULT_WAKE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Budget for the whole call — every candidate together (default
   * {@link DEFAULT_WAKE_DIAL_BUDGET_MS}).
   */
  budgetMs?: number;
  /** Override the protocol id (defaults to {@link WAKE_PROTOCOL}). */
  protocolId?: string;
}

/** One candidate's outcome, kept so the thrown error can name every attempt. */
interface WakeDialFailure {
  addr: Multiaddr;
  error: Error;
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
 * why it failed, not merely the last one. That distinction is not cosmetic:
 * with only the last candidate's message the failure that mattered (usually the
 * signaling address, tried first) is invisible outside a debug log, and the
 * surfaced message points at whichever address happened to be tried last.
 *
 * The candidate loop is deliberately explicit rather than one
 * `dialProtocol(addrs)` call. libp2p sorts any multi-address dial with
 * `defaultAddressSorter`, whose `circuitRelayAddressesLast` pass would demote
 * exactly the signaling address this ordering puts first — silently inverting
 * it, with no per-dial sorter override to opt out of.
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
  const budgetMs = options.budgetMs ?? DEFAULT_WAKE_DIAL_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const failures: WakeDialFailure[] = [];
  for (const addr of addrs) {
    // Whatever is left of the whole-call budget caps this attempt, so the last
    // candidate inside the budget still gets a real (if shortened) try.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push({ addr, error: new Error(`not tried — the ${budgetMs}ms wake dial budget was spent on earlier addresses`) });
      continue;
    }
    const attemptMs = Math.min(timeoutMs, remaining);
    try {
      // One deadline per attempt: its signal aborts the in-flight dialProtocol and
      // resets the live stream, so neither the connect nor the ack-read leaks.
      return await withDeadline(
        attemptMs,
        `Wake dial ${addr.toString()}`,
        (signal) => sendWake(node, addr, protocolId, request, attemptMs, signal),
      );
    } catch (err) {
      failures.push({ addr, error: err instanceof Error ? err : new Error(String(err)) });
      log('Wake dial to %s failed: %o', addr.toString(), err);
    }
  }
  throw wakeDialError(failures);
}

/**
 * Fold every candidate's failure into the one error {@link dialWake} throws.
 *
 * A single candidate throws its own error unchanged, so a one-address wake reads
 * exactly as it always has (and `rejects.toThrow(/timed out/)` still means what
 * it says). Several candidates produce one message naming each address and its
 * cause, with the FIRST failure as `cause` — the first candidate is the
 * signaling address, which is the one that matters when a relayed peer goes
 * unreachable.
 */
function wakeDialError(failures: WakeDialFailure[]): Error {
  if (failures.length === 0) {
    return new Error('Wake dial failed');
  }
  if (failures.length === 1) {
    return failures[0].error;
  }
  const detail = failures.map((f) => `${f.addr.toString()} — ${f.error.message}`).join('; ');
  return new Error(
    `Wake dial failed for all ${failures.length} candidate addresses: ${detail}`,
    { cause: failures[0].error },
  );
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
