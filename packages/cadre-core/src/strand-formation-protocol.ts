/**
 * Native cadre-core strand-formation transport.
 *
 * Mirrors the non-deprecated `seed-bootstrap.ts` protocol service: a dedicated
 * libp2p protocol id, length-prefixed JSON frames, and small single-purpose
 * session helpers. It replaces the deprecated `@serfab/strand-proto` transport,
 * carrying the caller's REAL invitation token + disclosure and BOTH parties'
 * real cadre peer addresses end-to-end (no `{ partyId: sessionId }` / `cadre-*.local`
 * placeholders), and validating the responder's result on the initiator side.
 *
 * Provisioning flow (`responderCreates`, 2 messages): the responder provisions (or, for
 * provision-then-record, resolves + records consent against) the strand and returns the
 * result on approval.
 *
 * Cadre-disclosure timing (see docs/strand-proto.md "Security & Privacy"): the
 * responder reveals its own party id + cadre addresses — and, for a closed strand
 * returned via provision-then-record, that strand's membership key — ONLY after the
 * token and disclosure validate; a rejection discloses none of them.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';
import type { StrandFormationDisclosure } from './types.js';
import { type ControlStream, writeFrame, withTimeout } from './control-stream.js';

const log = debug('sereus:cadre:formation-proto');

/** Protocol id for the native formation transport (parallel to `/sereus/seed/1.0.0`). */
export const FORMATION_PROTOCOL = '/sereus/formation/1.0.0';

/** Maximum formation message size (1MB). */
const MAX_FORMATION_MSG_SIZE = 1024 * 1024;

/** Default whole-session timeout (ms). */
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
/** Default per-step (single read/write) timeout (ms). */
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
/**
 * Default provisioning budget (ms) — distinct from {@link DEFAULT_STEP_TIMEOUT_MS} because
 * `provisionStrand` is real work (DB writes, and an outbound approval-hook HTTP call when
 * the invite carries a `ValidationUrl`), not a bare wire read/write.
 *
 * Ordering is deliberate — each layer must be able to fail and report before the layer above
 * it gives up:
 *
 *   approval hook (10 s, `formation-approval.ts`)
 *     < responder provisioning (12 s)
 *     < initiator await-response (15 s)
 *     < session (30 s)
 *
 * The 3 s margin between responder provisioning and initiator await-response is the wire
 * latency budget for the result frame to travel back.
 *
 * The last {@link PROVISION_SETTLE_GRACE_MS} of this budget is a settle grace, so the default
 * WORK budget (12 s − 2 s = 10 s) EQUALS the hook's own 10 s: a dead hook races 'Formation
 * approval unavailable, retry' against 'Formation provisioning timed out'. Both are retryable
 * and both leave the invite unspent, so the race is benign.
 */
const DEFAULT_PROVISION_TIMEOUT_MS = 12_000;
/**
 * Settle grace (ms), carved OUT of `provisionTimeoutMs` — never added on top, so the budget
 * ladder above is untouched. The listener aborts the provisioning hook when the remaining
 * work budget (`provisionTimeoutMs - grace`, floored at half the budget for tiny configured
 * values) expires, then waits up to this grace for the aborted work to settle anyway: once
 * the `FormationUsage` insert has been issued nothing can un-spend it (the table is
 * append-only), so a provisioning that lands late is ADOPTED and reported as a real
 * approval rather than lying "timed out" over a spent invite. A hook that observes the
 * abort before writing leaves the invite unspent.
 *
 * Exported so the listener and its tests share one definition of the split.
 */
export const PROVISION_SETTLE_GRACE_MS = 2_000;
/** Default initiator await-response budget (ms); see {@link DEFAULT_PROVISION_TIMEOUT_MS}. */
const DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS = 15_000;
/**
 * Default cap on concurrent inbound formation sessions.
 * NOTE: a longer provisioning budget holds a session's slot longer, so a slow hook can
 * exhaust this cap and make the listener reject fresh joiners with 'Too many concurrent
 * formation sessions'. Fine at the current default; revisit if `provisionTimeoutMs` is
 * raised well above its default or this cap is lowered.
 */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 100;

// ── Roles ────────────────────────────────────────────────────────────────────

export type FormationParty = 'initiator' | 'responder';

// ── Wire messages (length-prefixed JSON frames) ──────────────────────────────

export interface FormationStrandInfo {
  strandId: string;
  createdBy: FormationParty;
}

export interface FormationDbConnectionInfo {
  endpoint: string;
  credentialsRef: string;
}

export interface FormationProvisionResult {
  strand: FormationStrandInfo;
  /**
   * The strand's membership key (closed-strand read-gating secret), delivered to a
   * validated invitee for provision-then-record formation. Disclosed only AFTER token
   * + disclosure validation, exactly like the responder identity/cadre — a rejected or
   * already-used token discloses neither identity nor key. Absent for open strands.
   */
  memberPrivateKey?: string;
  dbConnectionInfo: FormationDbConnectionInfo;
}

/**
 * Outcome of the responder's provisioning hook.
 *
 * Distinct from a bare {@link FormationProvisionResult} so the hook can REJECT a
 * formation AFTER token + disclosure validation — e.g. a bound invite naming a host
 * strand this responder has not yet converged on, or a concurrent-redemption collision.
 * Without this channel such cases threw inside provisioning, the stream closed with no
 * result frame, and the initiator saw a read-error/timeout instead of a clean
 * `approved: false`. A rejection still discloses NO responder identity/cadre.
 */
export type ResponderProvisionOutcome =
  | { approved: true; result: FormationProvisionResult }
  | { approved: false; reason: string };

/** Initiator → Responder: carries the real token + disclosure + initiator cadre. */
export interface FormationContactMessage {
  /** The real invitation token. */
  token: string;
  /** Initiator's member key (peer id). */
  partyId: string;
  /** The real disclosure, carried verbatim. */
  disclosure: StrandFormationDisclosure;
  /** Initiator's real multiaddrs. */
  cadrePeerAddrs: string[];
}

/** Responder → Initiator: responder identity/cadre disclosed only after validation. */
export interface FormationResultMessage {
  approved: boolean;
  /** Present iff `approved === false`. */
  reason?: string;
  /** Responder's real party id (disclosed only after validation). */
  partyId?: string;
  /** Responder's real multiaddrs (omitted on rejection). */
  cadrePeerAddrs?: string[];
  /** The provisioned strand/db result (always present on approval). */
  provisionResult?: FormationProvisionResult;
}

// ── Stream framing helpers ───────────────────────────────────────────────────

/**
 * Reads length-prefixed JSON frames from a libp2p stream one frame at a time.
 *
 * Unlike seed delivery (which reads a stream to EOF then parses once), formation
 * is request/response on a single live stream, so reading must stop at each frame
 * boundary. The reader buffers across chunk boundaries and retains any overflow
 * (a following frame coalesced into the same chunk) for the next read.
 */
class FrameReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private readonly maxLength: number;
  private buffer = new Uint8Array(0);

  constructor(stream: AsyncIterable<Uint8Array>, maxLength = MAX_FORMATION_MSG_SIZE) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.maxLength = maxLength;
  }

  private append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  /** Pull chunks until the buffer holds ≥ `need` bytes; false if the stream ended first. */
  private async fill(need: number): Promise<boolean> {
    while (this.buffer.length < need) {
      const { value, done } = await this.iterator.next();
      if (done) return false;
      const bytes = value instanceof Uint8Array
        ? value
        : (value as { subarray(): Uint8Array }).subarray();
      this.append(bytes);
    }
    return true;
  }

  async read<T>(): Promise<T> {
    if (!(await this.fill(4))) {
      throw new Error('Formation stream closed before length prefix');
    }
    const length = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength).getUint32(0, false);
    if (length > this.maxLength) {
      throw new Error(`Formation frame declares length ${length} exceeding max ${this.maxLength}`);
    }
    if (!(await this.fill(4 + length))) {
      throw new Error(`Formation frame declares length ${length} but stream ended early`);
    }
    const json = new TextDecoder().decode(this.buffer.subarray(4, 4 + length));
    this.buffer = this.buffer.subarray(4 + length);
    return JSON.parse(json) as T;
  }
}

// ── Result validation ────────────────────────────────────────────────────────

/** Matches the deprecated strand-proto placeholder cadre addrs (`cadre-a-1.local`, …). */
const PLACEHOLDER_CADRE_ADDR = /^cadre-[ab]-\d+\.local$/;

/**
 * Structural check on a `responderCreates` result: the responder must have approved,
 * disclosed a non-empty real identity + cadre (not the deprecated `cadre-*.local`
 * placeholders), and returned a strand vouched for by the responder party with a real id.
 *
 * `createdBy: 'responder'` means "the responder party vouches for / returns this strand."
 * Under provision-then-record that strand was minted owner-signed earlier (not created
 * in-session), but it is still the responder party returning its own strand, so the marker
 * — and this structural validator — stay unchanged.
 *
 * The behavioral floor for the initiator: a responder that returns an arbitrary/empty
 * `strandId` or omits its disclosed identity is rejected, not silently accepted.
 */
export function isValidResponderCreatesResult(response: FormationResultMessage): boolean {
  if (!response.approved) return false;
  if (!response.partyId) return false;
  const addrs = response.cadrePeerAddrs;
  if (!addrs || addrs.length === 0) return false;
  if (addrs.some((a) => PLACEHOLDER_CADRE_ADDR.test(a))) return false;
  const provision = response.provisionResult;
  if (!provision?.strand?.strandId) return false;
  if (provision.strand.createdBy !== 'responder') return false;
  return true;
}

/**
 * Resolve a caller-supplied provisioning budget: `0`/negative means "unset" (use
 * `defaultMs`). If the result would let provisioning outlive the session — no result
 * frame is ever sent, exactly the failure this budget exists to prevent — clamp it to
 * `sessionTimeoutMs - stepTimeoutMs` and log a warning.
 *
 * The session budget also has to cover the wire step that PRECEDES provisioning (the
 * responder's contact read, the initiator's dial-connect), so the guard leaves a whole
 * step of headroom rather than triggering only on a literal overrun.
 */
function resolveProvisionTimeoutMs(
  configured: number | undefined,
  defaultMs: number,
  sessionTimeoutMs: number,
  stepTimeoutMs: number,
  role: string
): number {
  const requested = configured && configured > 0 ? configured : defaultMs;
  if (requested + stepTimeoutMs >= sessionTimeoutMs) {
    const clamped = Math.max(1, sessionTimeoutMs - stepTimeoutMs);
    log(
      '%s provisionTimeoutMs %dms leaves no room under sessionTimeoutMs %dms (step %dms); clamping to %dms',
      role, requested, sessionTimeoutMs, stepTimeoutMs, clamped
    );
    return clamped;
  }
  return requested;
}

// ── Responder (listener) ─────────────────────────────────────────────────────

export interface FormationListenerOptions {
  /** Validate the invitation token; returns whether it is valid. */
  validateToken(token: string): Promise<{ valid: boolean }>;
  /** Validate the initiator's disclosure with the REAL token + disclosure. */
  validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
  /**
   * Provision (or, for provision-then-record, resolve + record consent against) the
   * strand (`responderCreates`) for the given initiator. The REAL token is threaded
   * in so the hook can map it to the bound host strand and its membership key.
   *
   * Returns a {@link ResponderProvisionOutcome}: the hook may REJECT post-validation
   * (e.g. an unconverged host strand) and the listener turns that into a clean,
   * non-disclosing `approved: false` reply rather than dropping the result frame.
   *
   * `signal` is aborted when the listener's work budget expires: a hook that observes it
   * BEFORE writing abandons the redemption and leaves the invite unspent. Optional so
   * signal-unaware hooks (tests, mocks) stay assignable.
   */
  provisionStrand(token: string, initiatorPartyId: string, disclosure: StrandFormationDisclosure, signal?: AbortSignal): Promise<ResponderProvisionOutcome>;
  /** Responder identity, disclosed only AFTER token + disclosure validation passes. */
  getResponderIdentity(): { partyId: string; cadrePeerAddrs: string[] };
  sessionTimeoutMs?: number;
  stepTimeoutMs?: number;
  /**
   * Budget for the `provisionStrand` hook call — distinct from `stepTimeoutMs` because
   * provisioning is real work, not a bare wire read/write. Default 12 s; `0`/unset uses
   * the default. See {@link DEFAULT_PROVISION_TIMEOUT_MS} for the full ordering rationale.
   */
  provisionTimeoutMs?: number;
  maxConcurrentSessions?: number;
}

/**
 * Responder side of the native formation protocol. Registers a libp2p handler and
 * drives each inbound stream through token + disclosure validation, provisioning,
 * and result delivery — enforcing the cadre-disclosure timing rule (responder cadre
 * is revealed only after validation; rejections disclose nothing).
 */
export class FormationListener {
  private readonly options: FormationListenerOptions;
  private readonly sessionTimeoutMs: number;
  private readonly stepTimeoutMs: number;
  private readonly provisionTimeoutMs: number;
  private readonly maxConcurrentSessions: number;
  private readonly registered = new Set<Libp2p>();
  private activeSessions = 0;
  private sessionCounter = 0;

  constructor(options: FormationListenerOptions) {
    this.options = options;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    this.provisionTimeoutMs = resolveProvisionTimeoutMs(
      options.provisionTimeoutMs, DEFAULT_PROVISION_TIMEOUT_MS,
      this.sessionTimeoutMs, this.stepTimeoutMs, 'FormationListener'
    );
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  }

  /** Number of in-flight inbound sessions. */
  get activeCount(): number {
    return this.activeSessions;
  }

  register(node: Libp2p, protocolId: string = FORMATION_PROTOCOL): void {
    if (this.registered.has(node)) {
      log('node already registered');
      return;
    }
    void node.handle(protocolId, async (rawStream: unknown, _connection: unknown) => {
      await this.handleStream(rawStream as ControlStream);
    });
    this.registered.add(node);
    log('formation listener registered (%s)', protocolId);
  }

  unregister(node: Libp2p, protocolId: string = FORMATION_PROTOCOL): void {
    if (!this.registered.has(node)) return;
    void node.unhandle(protocolId);
    this.registered.delete(node);
    log('formation listener unregistered (%s)', protocolId);
  }

  private async handleStream(stream: ControlStream): Promise<void> {
    if (this.activeSessions >= this.maxConcurrentSessions) {
      const rejection: FormationResultMessage = { approved: false, reason: 'Too many concurrent formation sessions' };
      try { writeFrame(stream, rejection); } catch { /* best effort */ }
      try { await stream.close(); } catch { /* ignore */ }
      return;
    }
    const id = ++this.sessionCounter;
    this.activeSessions++;
    try {
      await withTimeout(this.sessionTimeoutMs, `Formation session#${id}`, () => this.runSession(id, stream));
    } catch (err) {
      log('formation session #%d failed: %o', id, err);
    } finally {
      this.activeSessions--;
      try { await stream.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Run the provisioning hook under {@link provisionTimeoutMs}, split into a WORK budget and
   * a trailing {@link PROVISION_SETTLE_GRACE_MS} settle grace (see that constant — the grace
   * is carved out of the budget, never added on top, so the nested timeout ladder holds).
   *
   * When the work budget expires the hook's signal is aborted, then
   * {@link settleWithinGrace} waits out the grace for the aborted work to settle anyway.
   * Returns `undefined` for "timed out" — which the caller turns into a retryable rejection
   * frame — and rethrows every other failure so it reaches the internal-error path.
   *
   * Deliberately not `withDeadline`: that exposes neither the timed-out flag nor the signal
   * outside its `op`, and both are needed here.
   */
  private async provision(id: number, contact: FormationContactMessage): Promise<ResponderProvisionOutcome | undefined> {
    const graceMs = Math.min(PROVISION_SETTLE_GRACE_MS, Math.floor(this.provisionTimeoutMs / 2));
    const workMs = Math.max(1, this.provisionTimeoutMs - graceMs);
    const controller = new AbortController();
    let timedOut = false;
    const pending = this.options.provisionStrand(contact.token, contact.partyId, contact.disclosure, controller.signal);
    try {
      return await withTimeout(
        workMs,
        `Formation provisioning#${id}`,
        () => pending,
        () => { timedOut = true; controller.abort(); }
      );
    } catch (err) {
      if (!timedOut) throw err;
      log(
        'formation session #%d provisioning work budget expired after %dms; aborted, settling up to %dms',
        id, workMs, graceMs
      );
      return await this.settleWithinGrace(id, pending, graceMs);
    }
  }

  /**
   * Wait out the settle grace for an ABORTED provisioning, adopting a late success.
   *
   * A hook that observed the abort before issuing its `FormationUsage` insert rejects (with
   * `FormationAbortedError`) and leaves the invite unspent → reported as a timeout. A hook
   * that had already written cannot be un-written (the table is append-only), so if it lands
   * inside the grace its outcome is ADOPTED — the joiner is told the truth (approved, or the
   * hook's own rejection reason) rather than "timed out" over a spent invite.
   *
   * NOTE: one window stays open — a work budget that expires after the `FormationUsage`
   * insert was issued AND a commit that outlasts the grace. The joiner is told 'timed out'
   * while its one-time invite is in fact spent, and since every retry mints a fresh keypair
   * no recovery path can match it. Nothing can un-spend an append-only row, so the late-settle
   * logging below is the observability for it; widen the grace only if it is seen in the wild.
   */
  private async settleWithinGrace(
    id: number,
    pending: Promise<ResponderProvisionOutcome>,
    graceMs: number
  ): Promise<ResponderProvisionOutcome | undefined> {
    let stillPending = false;
    try {
      const outcome = await withTimeout(
        graceMs,
        `Formation settle#${id}`,
        () => pending,
        () => { stillPending = true; }
      );
      log('formation session #%d provisioning settled within its grace: approved=%s — adopting', id, outcome.approved);
      return outcome;
    } catch (err) {
      if (!stillPending) {
        log('formation session #%d provisioning failed after its abort: %o', id, err);
        return undefined;
      }
      log('formation session #%d provisioning still pending after its %dms grace', id, graceMs);
      // Log how it eventually settled so a late failure is not swallowed by the two
      // abandoned `withTimeout` calls.
      void pending.then(
        (late) => log('formation session #%d provisioning settled after its grace: approved=%s', id, late.approved),
        (err2) => log('formation session #%d provisioning failed after its grace: %o', id, err2)
      );
      return undefined;
    }
  }

  private async runSession(id: number, stream: ControlStream): Promise<void> {
    // Track whether ANY frame has been written so the catch below can convert an
    // unexpected internal error into a non-disclosing rejection ONLY when nothing has
    // gone out yet. This closes the "stream closed with no result frame" class of bug.
    let wroteFrame = false;
    const send = (msg: FormationResultMessage): void => {
      writeFrame(stream, msg);
      wroteFrame = true;
    };

    try {
      const reader = new FrameReader(stream);
      const contact = await withTimeout(this.stepTimeoutMs, `Formation await-contact#${id}`, () => reader.read<FormationContactMessage>());
      log('formation session #%d contact: token=%s party=%s', id, contact.token, contact.partyId);

      const tokenResult = await this.options.validateToken(contact.token);
      if (!tokenResult.valid) {
        send({ approved: false, reason: 'Invalid token' });
        return;
      }

      const disclosureOk = await this.options.validateDisclosure(contact.token, contact.disclosure);
      if (!disclosureOk) {
        send({ approved: false, reason: 'Invalid disclosure' });
        return;
      }

      const outcome = await this.provision(id, contact);
      if (!outcome) {
        // Reported as its own retryable reason rather than falling through to the generic
        // catch below, which would report the misleading 'Internal formation error'.
        send({ approved: false, reason: 'Formation provisioning timed out' });
        return;
      }
      if (!outcome.approved) {
        // A post-validation rejection still discloses NEITHER identity NOR cadre,
        // exactly like the token/disclosure rejections above.
        send({ approved: false, reason: outcome.reason });
        return;
      }
      // Validation + provisioning passed → safe to disclose responder identity/cadre.
      const identity = this.options.getResponderIdentity();
      send({
        approved: true,
        partyId: identity.partyId,
        cadrePeerAddrs: identity.cadrePeerAddrs,
        provisionResult: outcome.result
      });
    } catch (err) {
      // Defense-in-depth: if an unexpected internal error escapes BEFORE any frame was
      // written (e.g. a future provisionStrand-hook bug), convert it into a non-disclosing
      // protocol rejection so the initiator sees a clean error instead of a read-error/
      // timeout. If a frame was already sent, leave the stream as-is and let handleStream
      // log + close. Re-throw either way so the failure is still recorded — this is a
      // deliberate, logged conversion, not silent.
      if (!wroteFrame) {
        const internalError: FormationResultMessage = { approved: false, reason: 'Internal formation error' };
        try { writeFrame(stream, internalError); } catch { /* stream already broken */ }
      }
      throw err;
    }
  }
}

// ── Initiator (dialer) ───────────────────────────────────────────────────────

export interface FormationDialOptions {
  /** The contact message to send (real token, partyId, disclosure, initiator cadre). */
  contact: FormationContactMessage;
  /** Responder multiaddrs to dial. */
  responderAddrs: string[];
  /** Validate the responder's result; a false return aborts the formation. */
  validateResponse(response: FormationResultMessage): Promise<boolean>;
  sessionTimeoutMs?: number;
  stepTimeoutMs?: number;
  /**
   * Budget for the `await-response` read only (the responder's provisioning + reply travel
   * time) — `dial-connect` keeps using `stepTimeoutMs`. Default 15 s; `0`/unset uses the
   * default. See {@link DEFAULT_PROVISION_TIMEOUT_MS} for the full ordering rationale.
   */
  provisionTimeoutMs?: number;
  protocolId?: string;
}

/**
 * Initiator side of the native formation protocol. Dials the responder, sends the
 * contact (carrying the real disclosure/token/cadre), validates the responder's
 * result, and returns the strand the responder provisioned.
 */
export async function dialFormation(node: Libp2p, options: FormationDialOptions): Promise<FormationProvisionResult> {
  if (options.responderAddrs.length === 0) {
    throw new Error('No responder addresses available for formation');
  }
  const protocolId = options.protocolId ?? FORMATION_PROTOCOL;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const provisionTimeoutMs = resolveProvisionTimeoutMs(
    options.provisionTimeoutMs, DEFAULT_INITIATOR_PROVISION_TIMEOUT_MS,
    sessionTimeoutMs, stepTimeoutMs, 'dialFormation'
  );
  const addr = multiaddr(options.responderAddrs[0]);

  return withTimeout(sessionTimeoutMs, 'Formation dial', async () => {
    const rawStream = await withTimeout(stepTimeoutMs, 'Formation dial-connect', async () => node.dialProtocol(addr, protocolId));
    const stream = rawStream as unknown as ControlStream;
    try {
      const reader = new FrameReader(stream);
      writeFrame(stream, options.contact);

      const response = await withTimeout(provisionTimeoutMs, 'Formation await-response', () => reader.read<FormationResultMessage>());
      if (!response.approved) {
        throw new Error(`Formation rejected: ${response.reason ?? 'no reason provided'}`);
      }
      const ok = await options.validateResponse(response);
      if (!ok) throw new Error('Responder result failed validation');

      if (!response.provisionResult) throw new Error('Missing provision result for responderCreates mode');
      return response.provisionResult;
    } finally {
      try { await stream.close(); } catch { /* ignore */ }
    }
  });
}
