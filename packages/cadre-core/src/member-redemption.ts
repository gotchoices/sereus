/**
 * The member-dialed redemption exchange shared by cadre invitations
 * (`cadre-invite-protocol.ts`) and owner grants (`owner-grant-protocol.ts`): a holder dials ANY
 * member machine its bundle names, proves possession in one signed frame, and the member writes
 * rows on the issuer's behalf and answers in one frame. The issuer need not be online.
 *
 * What is the same for both credentials lives here, generic over the request and reply types:
 *
 * - the member side's hardening and sequencing ({@link MemberRedemptionHandler}): a concurrency
 *   cap, a read timeout, the checks before any database work, the push of this member's control
 *   store to the holder for a credential still live here, and the writes under that admission;
 * - the holder side's dialing ({@link dialRedemption}, {@link dialRedemptionInPasses}): the
 *   bundle's addresses one at a time under a per-address deadline, one signed request for every
 *   address and every pass, and the pacing between passes;
 * - the shape checks both directions apply off the wire, and the frame cap.
 *
 * What differs — the bundle, the request's fields and signatures, the refusal codes, the rows
 * written and the reply's contents — stays in each protocol module, which passes it in. Same
 * shape as the seed and wake protocols underneath: one length-prefixed JSON frame each way over
 * the primitives in `control-stream.ts`.
 */

import debug from 'debug';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Connection, Libp2p } from '@libp2p/interface';
import { type ControlStream, withDeadline, exchangeFrame, readStreamToEnd, replyAndClose } from './control-stream.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { relayedRequestBudgetMs } from './link-budget.js';
import { parseNullableStoredDatetimeMs } from './control-database.js';
import { requireEd25519PublicKeyB64 } from './ed25519-key.js';
import { dialAddr, nextMacrotask, trailingPeerId } from './peer-dial.js';
import { chainMessages } from './control-retry.js';
import { isRetriableControlWriteFailure } from './control-write-retry.js';
import type { CadreJoinProgress } from './types.js';

const log = debug('sereus:cadre:member-redemption');

/**
 * Cap on either frame of either protocol. A request is one signed row, two signatures and a few
 * addresses; a reply adds at most a peer list of a cadre's size. Both fit in a few KB; 64 KiB is
 * the defensive bound a stranger can make the handler buffer.
 */
export const MAX_REDEMPTION_FRAME_BYTES = 64 * 1024;

/**
 * Default time the member waits for the request frame before aborting the read (ms). The read
 * only: a stranger opens the stream, so the bound is on a caller that opens one and never sends.
 * Same figure as the seed handler's.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: a receiver cap on one frame on a stream the peer already opened; it bounds a peer that opens a stream and never sends, not the dial
const DEFAULT_REDEEM_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound redemptions; over it the handler answers `busy`. */
const DEFAULT_MAX_CONCURRENT_REDEMPTIONS = 100;

/** Longest string field accepted off the wire; a stamp is 342 base64url chars, a signature 86. */
export const MAX_WIRE_FIELD_LENGTH = 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// ── Shape checks (both directions, both protocols) ───────────────────────────

export function isBoundedString(value: unknown, max = MAX_WIRE_FIELD_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isEd25519KeyB64(value: unknown): value is string {
  if (!isBoundedString(value) || !BASE64URL.test(value)) return false;
  try {
    requireEd25519PublicKeyB64(value, 'key');
    return true;
  } catch {
    return false;
  }
}

/** Is `value` a null-or-bounded-string column, as the nullable text columns of a travelling row are? */
export function isNullableBoundedString(value: unknown, max = MAX_WIRE_FIELD_LENGTH): value is string | null {
  return value === null || isBoundedString(value, max);
}

/** Is `value` a null-or-positive-integer use cap? */
export function isNullableUseCap(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 1);
}

// ── Refusals ─────────────────────────────────────────────────────────────────

/** A refusal as the member sends it: a code, a reason, nothing else. */
export interface RedemptionRejection<Code extends string> {
  accepted: false;
  code: Code;
  reason: string;
}

/**
 * A refusal as the holder reads it: the code and reason verbatim off the wire, untyped, so each
 * protocol's rejected-error is the one place that classifies a code this build does not know
 * (as `'unrecognized'`, retryable) rather than the decoder folding it into a code it does.
 */
export interface RedemptionRefusalFrame {
  accepted: false;
  code: unknown;
  reason: unknown;
}

export function rejection<Code extends string>(code: Code, reason: string): RedemptionRejection<Code> {
  return { accepted: false, code, reason };
}

/** One row of a protocol's constraint table: the constraint names the schema refuses a write with, and the code and reason each maps to. */
export type ConstraintRefusalRow<Code extends string> = readonly [RegExp, Code, string];

/** Which named constraint, if any, refused the write — read off the error's cause chain. */
export function constraintRefusal<Code extends string>(error: unknown, table: ReadonlyArray<ConstraintRefusalRow<Code>>): RedemptionRejection<Code> | null {
  if (!(error instanceof Error)) return null;
  const messages = chainMessages(error);
  for (const [pattern, code, reason] of table) {
    if (messages.some((message) => pattern.test(message))) return rejection(code, reason);
  }
  return null;
}

/** A write failure that is not a refusal: the retry gave up (`conflict`), or something else (`internal`). */
export function writeFailureRefusal(error: unknown): RedemptionRejection<'conflict' | 'internal'> {
  // NOTE: a seat torn on a member alone with an uncaught-up device was measured answering
  // `internal`, not `conflict` (cadre-invite-redeemed-at-a-member-without-the-row). Both are
  // retryable, so the holder is unaffected; if the two codes ever diverge in retryability,
  // find which tear `isRetriableControlWriteFailure` does not recognise.
  return isRetriableControlWriteFailure(error)
    ? rejection('conflict', 'The redemption write failed transiently; nothing was recorded')
    : rejection('internal', 'Internal redemption error');
}

// ── Member side (handler base) ───────────────────────────────────────────────

export interface MemberRedemptionHandlerOptions {
  /** This member's party id; a request for another party is refused by name. */
  partyId: string;
  /**
   * Push this member's control store to the holder, resolving once the push has finished, and
   * keep the holder counted in this member's control write cohort until the returned release
   * is called. Called after the request verified and before the row is seated and the
   * redemption is written; the handler releases once both have settled. Absent, the writes go
   * ahead with the holder neither caught up nor in the cohort, so it does not hold them; see
   * {@link MemberRedemptionHandler.admitIfLive}.
   */
  admitDevice?: (peerId: string) => Promise<() => void>;
  /** Time to wait for the request frame; default {@link DEFAULT_REDEEM_READ_TIMEOUT_MS}. */
  redeemReadTimeoutMs?: number;
  /** Cap on concurrent inbound redemptions; default {@link DEFAULT_MAX_CONCURRENT_REDEMPTIONS}. */
  maxConcurrentRedemptions?: number;
}

/**
 * Member side of one redemption protocol: registers the handler and drives each inbound stream
 * through the checks in cost order — shape, then whatever the protocol checks without database
 * work (party, signatures, and for an invitation the connecting identity and target device) —
 * so no database work happens for a stranger that cannot prove anything; then admits the holder
 * to this member's control replication (`admitDevice`) when the credential is live here, and
 * runs the protocol's writes. Hardened as the seed handler is: a concurrency cap (over it,
 * `busy`) and a read timeout.
 *
 * Registered only by a started `CadreNode`, after its control database is up, like the
 * formation responder; nothing here is reachable on a node without one.
 *
 * A subclass supplies the five credential-specific pieces: the request's shape, the checks after
 * it, the liveness read behind the push, the writes, and the two fixed refusals the base sends
 * on its own (`busy`, and `internal` for a frame it could not read or a failure it did not
 * expect).
 */
export abstract class MemberRedemptionHandler<Request, Reply extends { accepted: boolean }> {
  protected readonly partyId: string;
  private readonly admitDevice: MemberRedemptionHandlerOptions['admitDevice'];
  private readonly readTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly registered = new Set<Libp2p>();
  private active = 0;

  /**
   * @param label - Names the credential in log lines and stream labels ("Cadre invite", "Owner grant").
   * @param protocolId - The protocol id {@link register} handles by default.
   */
  protected constructor(protected readonly label: string, protected readonly protocolId: string, options: MemberRedemptionHandlerOptions) {
    this.partyId = options.partyId;
    this.admitDevice = options.admitDevice;
    this.readTimeoutMs = options.redeemReadTimeoutMs ?? DEFAULT_REDEEM_READ_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrentRedemptions ?? DEFAULT_MAX_CONCURRENT_REDEMPTIONS;
  }

  /** The refusal for a caller over the concurrency cap. */
  protected abstract readonly busyRefusal: Reply;
  /** The refusal for a request frame the member could not read, or an unexpected failure: nothing was proved either way, so the holder stays free to try the next address. */
  protected abstract readonly internalRefusal: Reply;
  /** The refusal for a frame that is not a well-formed request. */
  protected abstract readonly malformedRefusal: Reply;
  /** The request's shape, every field in its wire form and bounded. */
  protected abstract isWellFormedRequest(value: unknown): value is Request;
  /** The checks after the shape that cost no database work; null to go on to the writes. */
  protected abstract checkRequest(request: Request, remotePeerId: string): Reply | null;
  /** Is the credential the (checked) request carries still live on this member? Decides whether the holder is pushed the store (see {@link admitIfLive}). */
  protected abstract isLive(request: Request): Promise<boolean>;
  /** The protocol's writes under the admission, each answered by name when it fails. */
  protected abstract redeemAdmitted(request: Request, remotePeerId: string): Promise<Reply>;

  /** In-flight inbound redemptions. */
  get activeCount(): number {
    return this.active;
  }

  /**
   * Register on `node`; rejects when libp2p refuses the registration. `runOnLimitedConnection`
   * because a phone redeems through a relay, whose connection libp2p marks limited; the
   * exchange is two small frames, well inside any relay's cap.
   */
  async register(node: Libp2p, protocolId: string = this.protocolId): Promise<void> {
    if (this.registered.has(node)) return;
    await node.handle(protocolId, async (rawStream: unknown, rawConnection: unknown) => {
      await this.handleStream(rawStream as ControlStream, (rawConnection as Connection).remotePeer.toString());
    }, { runOnLimitedConnection: true });
    this.registered.add(node);
    log('%s handler registered (%s)', this.label, protocolId);
  }

  async unregister(node: Libp2p, protocolId: string = this.protocolId): Promise<void> {
    if (!this.registered.has(node)) return;
    await node.unhandle(protocolId);
    this.registered.delete(node);
    log('%s handler unregistered (%s)', this.label, protocolId);
  }

  /**
   * One inbound redemption: read the frame, decide, reply, close. Public as the seam a protocol
   * spec drives directly; `remotePeerId` is the connection's authenticated peer.
   */
  async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    if (this.active >= this.maxConcurrent) {
      log('%s: refusing redemption from %s: %d in flight at cap %d', this.label, remotePeerId, this.active, this.maxConcurrent);
      await replyAndClose(stream, this.busyRefusal, this.label);
      return;
    }
    this.active++;
    try {
      const reply = await this.decide(stream, remotePeerId);
      log('%s: redemption from %s: %s', this.label, remotePeerId, reply.accepted ? 'accepted' : `refused (${(reply as { code?: unknown }).code})`);
      await replyAndClose(stream, reply, this.label);
    } catch (error) {
      log('%s: redemption from %s failed: %o', this.label, remotePeerId, error);
      await replyAndClose(stream, this.internalRefusal, this.label);
    } finally {
      this.active--;
    }
  }

  /**
   * Read the request frame to EOF, bounded and size-capped; JSON only, shape is the subclass's.
   * Throws on a frame that cannot be read, which {@link handleStream} answers `internal`: a read
   * timeout or a cut frame proves nothing about the credential, so the holder must stay free to
   * try the next address.
   */
  private async readRequest(stream: ControlStream): Promise<unknown> {
    const data = await readStreamToEnd(stream, { maxBytes: MAX_REDEMPTION_FRAME_BYTES, timeoutMs: this.readTimeoutMs, label: this.label });
    return JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data, MAX_REDEMPTION_FRAME_BYTES)));
  }

  private async decide(stream: ControlStream, remotePeerId: string): Promise<Reply> {
    const request = await this.readRequest(stream);
    if (!this.isWellFormedRequest(request)) return this.malformedRefusal;
    const refused = this.checkRequest(request, remotePeerId);
    if (refused) return refused;
    const release = await this.admitIfLive(request, remotePeerId);
    try {
      return await this.redeemAdmitted(request, remotePeerId);
    } finally {
      release();
    }
  }

  /**
   * Admit the holder to this member's control replication before the first write of the
   * exchange (the seat, when this member does not hold the row; otherwise the redemption), and
   * resolve to the release that ends the admission. The holder is not a member, so only this
   * puts it in this member's control write cohort, and it must be there to hold the rows the
   * exchange writes. It is pushed the control store first, because a cohort node with no base
   * revision of a block refuses a commit to it; a member alone with the holder would then have
   * half its cohort refusing, and the write would tear instead of committing.
   *
   * Only for a credential still live here ({@link isLive}, judged on the row this member holds
   * or, before the seat, on the bundle's copy once its issuer signature verifies): the holder
   * of a withdrawn, expired or spent one, or of a forged copy naming a real owner, is refused
   * without being sent anything. The retry of a redemption already written can read as spent
   * too and is sent nothing; it needs nothing, since the rows it would hold are written and
   * the ordinary catch-up reaches a member. Best-effort: a failed check or push is logged and
   * the writes go ahead without the holder admitted, then commit or are answered retryably.
   */
  private async admitIfLive(request: Request, remotePeerId: string): Promise<() => void> {
    const notAdmitted = (): void => undefined;
    if (!this.admitDevice) return notAdmitted;
    try {
      if (!await this.isLive(request)) {
        log('%s: the credential is not live here; %s is not admitted before the write', this.label, remotePeerId);
        return notAdmitted;
      }
      // NOTE: accepted tradeoff — when a write then fails (the seat refused, the last use
      // taken by a race, the row expiring between this check and the write), the holder keeps
      // a copy of a control store it was not admitted to. It holds a live owner-signed
      // credential and proved possession and consent, and a seed hands an un-enrolled machine
      // the same information. Revisit if a control table ever carries data a non-member must not see.
      return await this.admitDevice(remotePeerId);
    } catch (error) {
      log('%s: admitting %s before its write failed (writing anyway): %o', this.label, remotePeerId, error);
      return notAdmitted;
    }
  }
}

// ── Holder side (dialer) ─────────────────────────────────────────────────────

/** What one address the bundle named came to. */
export interface RedemptionAddressOutcome {
  addr: string;
  /** A dial or exchange failure, or a retryable refusal. */
  error: Error;
}

/** A member's refusal as the holder classifies it; `retryable` decides whether the next address is tried. */
export type RedemptionRefusal = Error & { readonly retryable: boolean };

/** What a successful redemption yields the holder. */
export interface MemberRedemption<Accepted> {
  reply: Accepted;
  /** The answering member's peer id, from the address's trailing `/p2p/`; null when it named none. */
  memberPeerId: string | null;
  /** The address that answered. */
  memberAddr: string;
}

export interface MemberRedemptionOptions<Accepted> {
  /** Names the credential in log lines and deadline labels ("Cadre invitation", "Owner grant"). */
  label: string;
  protocolId: string;
  /** The bundle's multiaddrs ending in `/p2p/<peerId>`, dialed in order. */
  members: readonly string[];
  /** The signed request; the same one goes to every address (and every pass). */
  request: unknown;
  /** Read an acceptance frame's fields into `Accepted`, sanitizing them; throws on a malformed one, which moves the holder to the next address. */
  decodeAccepted(frame: Record<string, unknown>): Accepted;
  /** A refusal frame's code and reason, as the protocol classifies them. */
  refusal(code: unknown, reason: unknown): RedemptionRefusal;
  /** The holder's check on an acceptance; throws when it does not check out, which ends the call. */
  verifyAccepted(reply: Accepted): void;
  /** The error for every address tried and none accepting. */
  unreachable(outcomes: readonly RedemptionAddressOutcome[]): Error;
  /**
   * This machine's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which the
   * per-address deadline derives: a dial that may need a relay plus one request
   * (`relayedRequestBudgetMs`, 28.5 s at the default declaration), as seed delivery's is.
   */
  linkRoundTripMs?: number;
  /** Per-address deadline override; default derived from `linkRoundTripMs`. */
  addressBudgetMs?: number;
  /** Cancels the dial or stream in flight and ends the pass; the call throws the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Dial `addr`, open one stream to it, send the request, half-close, read the one reply frame.
 * `signal` is the per-address deadline: it cancels the dial and resets a live stream.
 *
 * The address is dialed outside libp2p's dial queue (`dialAddr`), so another dial of the
 * member in flight cannot capture this attempt; an open connection is still reused.
 */
async function exchangeRedemption<Accepted>(
  node: Libp2p,
  addr: Multiaddr,
  options: MemberRedemptionOptions<Accepted>,
  signal: AbortSignal,
  budgetMs: number
): Promise<Accepted | RedemptionRefusalFrame> {
  const connection = await dialAddr(node, addr, signal, `${options.label} redemption`);
  // `runOnLimitedConnection`: a member may be reachable only through a relay (see `register`).
  const rawStream = await connection.newStream(options.protocolId, { runOnLimitedConnection: true, signal });
  return await exchangeFrame(
    rawStream as unknown as ControlStream,
    signal,
    options.request,
    async (stream) => {
      const data = await readStreamToEnd(stream, { maxBytes: MAX_REDEMPTION_FRAME_BYTES, timeoutMs: budgetMs, label: `${options.label} reply` });
      return decodeReply(JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data, MAX_REDEMPTION_FRAME_BYTES))), options);
    },
    `${options.label} redemption aborted by its deadline`
  );
}

/**
 * Read a reply frame into a typed reply. A refusal keeps only its code and reason, as sent;
 * an acceptance is the protocol's to read. Throws on a frame that is neither.
 */
function decodeReply<Accepted>(value: unknown, options: MemberRedemptionOptions<Accepted>): Accepted | RedemptionRefusalFrame {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${options.label} reply is not an object`);
  }
  const reply = value as Record<string, unknown>;
  if (reply.accepted !== true) {
    return { accepted: false, code: reply.code, reason: reply.reason };
  }
  return options.decodeAccepted(reply);
}

function isRefusal<Accepted>(reply: Accepted | RedemptionRefusalFrame): reply is RedemptionRefusalFrame {
  return (reply as { accepted?: unknown }).accepted === false;
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  // A WebSocket transport rejects a refused dial with an `ErrorEvent`, whose text is its `message`.
  const message = (error as { message?: unknown } | null)?.message;
  return new Error(typeof message === 'string' && message.length > 0 ? message : String(error), { cause: error });
}

/**
 * Run `op` with a signal that aborts when either `deadline` or the caller's `signal` does.
 * Relayed by hand rather than with `AbortSignal.any`, which the phone runtimes lack.
 */
async function underDeadlineAndCaller<T>(
  deadline: AbortSignal,
  caller: AbortSignal | undefined,
  op: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (!caller) return await op(deadline);
  const either = new AbortController();
  const abort = (): void => either.abort();
  deadline.addEventListener('abort', abort, { once: true });
  caller.addEventListener('abort', abort, { once: true });
  // An abort between the caller's last check and the listener above fired no event.
  if (caller.aborted) abort();
  try {
    return await op(either.signal);
  } finally {
    deadline.removeEventListener('abort', abort);
    caller.removeEventListener('abort', abort);
  }
}

/** One pass's answer: the acceptance, or what every address came to and whether any member answered at all. */
type PassOutcome<Accepted> =
  | { redeemed: MemberRedemption<Accepted> }
  | { outcomes: RedemptionAddressOutcome[]; memberAnswered: boolean };

/**
 * One pass over the bundle's addresses, one at a time, each under its own deadline, stopping at
 * the first acceptance or the first final refusal. A dial failure, a malformed reply or a
 * retryable refusal moves to the next address. A final refusal and an acceptance that fails
 * the holder's check are thrown from outside the per-address catch, so neither is ever
 * mistaken for an address that could not be reached.
 */
async function dialOnce<Accepted>(node: Libp2p, options: MemberRedemptionOptions<Accepted>): Promise<PassOutcome<Accepted>> {
  const budgetMs = options.addressBudgetMs ?? relayedRequestBudgetMs(options.linkRoundTripMs);
  const outcomes: RedemptionAddressOutcome[] = [];
  let memberAnswered = false;
  for (const addr of options.members) {
    options.signal?.throwIfAborted();
    // Between attempts: a relayed address's relay leg goes through libp2p's dial queue, which
    // needs a macrotask to drop an aborted job (see `tryAddrsInTurn`).
    if (outcomes.length > 0) await nextMacrotask();
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(addr);
    } catch (error) {
      outcomes.push({ addr, error: new Error('not a multiaddr', { cause: error }) });
      continue;
    }
    let reply: Accepted | RedemptionRefusalFrame;
    try {
      reply = await withDeadline(budgetMs, `${options.label} redemption via ${addr}`,
        (deadline) => underDeadlineAndCaller(deadline, options.signal,
          (signal) => exchangeRedemption(node, parsed, options, signal, budgetMs)));
    } catch (error) {
      // The caller's abort cut this attempt short; its reason, not the cut, is the answer.
      options.signal?.throwIfAborted();
      log('%s redemption via %s failed before an answer (%s); trying the next address', options.label, addr, asError(error).message);
      outcomes.push({ addr, error: asError(error) });
      continue;
    }
    if (isRefusal(reply)) {
      const refusal = options.refusal(reply.code, reply.reason);
      if (!refusal.retryable) throw refusal;
      log('%s redemption via %s refused retryably (%s); trying the next address', options.label, addr, refusal.message);
      outcomes.push({ addr, error: refusal });
      memberAnswered = true;
      continue;
    }
    options.verifyAccepted(reply);
    return { redeemed: { reply, memberPeerId: trailingPeerId(parsed), memberAddr: addr } };
  }
  return { outcomes, memberAnswered };
}

/**
 * Holder side: try the bundle's addresses one at a time ({@link dialOnce}) and throw the
 * protocol's unreachable error when none accepts.
 *
 * Every address gets the SAME request, with one usage nonce: the usage table is keyed by it,
 * so a member the holder gave up on that was still committing cannot redeem it twice, and a
 * retry at the next member after a dropped reply is answered as already done.
 *
 * @throws the protocol's rejected error on a final refusal, its reply-invalid error on an
 *   acceptance that fails `verifyAccepted`, its unreachable error when every address was tried
 *   and none accepted, and the reason of `options.signal` once it aborts.
 */
export async function dialRedemption<Accepted>(node: Libp2p, options: MemberRedemptionOptions<Accepted>): Promise<MemberRedemption<Accepted>> {
  const outcome = await dialOnce(node, options);
  if ('redeemed' in outcome) return outcome.redeemed;
  throw options.unreachable(outcome.outcomes);
}

/** Pause after the first pass in which no member accepted; doubled after each further one. */
const REDEEM_PASS_FIRST_PAUSE_MS = 5_000;

/** Longest pause between passes. */
const REDEEM_PASS_MAX_PAUSE_MS = 60_000;

export interface MemberRedemptionPassOptions<Accepted> extends MemberRedemptionOptions<Accepted> {
  /** Keep making passes while every answer is retryable; false makes exactly one. */
  waitForMember: boolean;
  /** Called at each pass and each pause; an exception it throws is logged and ignored. */
  onProgress?: (progress: CadreJoinProgress) => void;
  /** The credential's stored expiry (its row's `expiresAt`, a `datetime` string); null for none. */
  expiresAt: string | null;
  /** The refusal a member would give the credential once expired, thrown when this holder's own clock says it has. */
  expired(): Error;
}

/**
 * Holder side, in passes: one {@link dialOnce} pass over the bundle's addresses, or, with
 * `waitForMember`, as many as it takes, pausing between them (5 s after the first, doubling to
 * 60 s, never past the credential's expiry). Every pass sends the same signed request, so a
 * member that wrote the redemption on a pass whose reply was lost answers a later pass as
 * already done, with no second usage row.
 *
 * A wait ends at the first acceptance, at a final refusal or an invalid reply (thrown as
 * {@link dialRedemption} throws them), when the credential expires by this holder's clock
 * (thrown as `expired()`), when `signal` aborts (its reason thrown), and when `node` stops. A
 * bundle that names no address has nothing to wait for and throws at once.
 */
export async function dialRedemptionInPasses<Accepted>(node: Libp2p, options: MemberRedemptionPassOptions<Accepted>): Promise<MemberRedemption<Accepted>> {
  for (let pass = 1; ; pass++) {
    if (options.waitForMember) {
      // One pass leaves expiry to the member, whose clock decides; a wait has nothing else to end it.
      refuseIfExpired(options);
      refuseIfStopped(node, options.label);
    }
    reportProgress(options.onProgress, { state: 'redeeming', pass });
    const outcome = await dialOnce(node, options);
    if ('redeemed' in outcome) return outcome.redeemed;
    if (!options.waitForMember || outcome.outcomes.length === 0) throw options.unreachable(outcome.outcomes);
    const pauseMs = pauseAfterPass(pass, options.expiresAt);
    reportProgress(options.onProgress, {
      state: 'waiting',
      pass,
      retryAtMs: Date.now() + pauseMs,
      // Any refusal means a member answered and is not ready yet; otherwise none answered at all.
      reason: outcome.memberAnswered ? 'member-not-ready' : 'no-member-answered',
      outcomes: outcome.outcomes
    });
    log('%s redemption pass %d found no member ready; the next pass in %d ms', options.label, pass, pauseMs);
    await pause(pauseMs, options.signal, node);
  }
}

// NOTE: judged by this holder's clock, so one running ahead ends a wait before the members
// would refuse it. If waits are seen ending early on skewed phones, allow a grace margin here.
function refuseIfExpired<Accepted>(options: MemberRedemptionPassOptions<Accepted>): void {
  const expiresAtMs = parseNullableStoredDatetimeMs(options.expiresAt);
  if (expiresAtMs !== null && expiresAtMs <= Date.now()) {
    throw options.expired();
  }
}

/** A stopped node's every dial fails at once, which would otherwise read as "no member answered" until expiry. */
function refuseIfStopped(node: Libp2p, label: string): void {
  if (node.status !== 'started') {
    throw new Error(`${label} redemption stopped waiting: the node is ${node.status}`);
  }
}

/** The pause after pass `pass`, cut short at the credential's expiry so the next check ends the wait then. */
function pauseAfterPass(pass: number, expiresAt: string | null): number {
  const backoffMs = Math.min(REDEEM_PASS_FIRST_PAUSE_MS * 2 ** (pass - 1), REDEEM_PASS_MAX_PAUSE_MS);
  const expiresAtMs = parseNullableStoredDatetimeMs(expiresAt);
  return expiresAtMs === null ? backoffMs : Math.max(0, Math.min(backoffMs, expiresAtMs - Date.now()));
}

/** A UI callback must not break the join. */
function reportProgress(onProgress: ((progress: CadreJoinProgress) => void) | undefined, progress: CadreJoinProgress): void {
  if (!onProgress) return;
  try {
    onProgress(progress);
  } catch (error) {
    log('redemption progress callback threw (ignored): %o', error);
  }
}

/**
 * Wait `ms`, or reject with `signal`'s reason as soon as it aborts. Ends early, resolving, when
 * `node` stops (or is already stopped), so the next pass's stop check ends the wait without a
 * timer holding the process open. Listeners and timer are cleared however it ends.
 */
function pause(ms: number, signal: AbortSignal | undefined, node: Libp2p): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (node.status !== 'started') {
      resolve();
      return;
    }
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      node.removeEventListener('stop', onStop);
    };
    const onAbort = (): void => {
      settle();
      reject(signal!.reason);
    };
    const onStop = (): void => {
      settle();
      resolve();
    };
    const timer = setTimeout(onStop, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    node.addEventListener('stop', onStop, { once: true });
  });
}
