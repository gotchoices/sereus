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
 * Two provisioning modes are preserved from strand-proto:
 * - `responderCreates` (2 messages): responder provisions and returns the result.
 * - `initiatorCreates` (3 messages): initiator provisions after approval and echoes
 *   the strand/db back. Unlike the deprecated transport (which opened a fresh stream
 *   for the echo and thereby lost session correlation), the echo stays on the same
 *   live stream so the responder validates it against the session it approved.
 *
 * Cadre-disclosure timing (see docs/strand-proto.md "Security & Privacy"): the
 * responder reveals its own party id + cadre addresses ONLY after the token and
 * disclosure validate; a rejection discloses neither.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';
import type { StrandFormationDisclosure } from './types.js';

const log = debug('sereus:cadre:formation-proto');

/** Protocol id for the native formation transport (parallel to `/sereus/seed/1.0.0`). */
export const FORMATION_PROTOCOL = '/sereus/formation/1.0.0';

/** Maximum formation message size (1MB). */
const MAX_FORMATION_MSG_SIZE = 1024 * 1024;

/** Default whole-session timeout (ms). */
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
/** Default per-step (single read/write) timeout (ms). */
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
/** Default cap on concurrent inbound formation sessions. */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 100;

// ── Roles / modes ────────────────────────────────────────────────────────────

export type FormationParty = 'initiator' | 'responder';

/**
 * Who provisions the strand:
 * - `responderCreates`: responder provisions and returns it in the result (2 messages).
 * - `initiatorCreates`: initiator provisions after approval and echoes it back (3 messages).
 */
export type FormationMode = 'responderCreates' | 'initiatorCreates';

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
  dbConnectionInfo: FormationDbConnectionInfo;
}

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
  /** Present for `responderCreates` mode. */
  provisionResult?: FormationProvisionResult;
}

/** Initiator → Responder (`initiatorCreates`): the strand/db the initiator provisioned. */
export interface FormationDatabaseMessage {
  strand: FormationStrandInfo;
  dbConnectionInfo: FormationDbConnectionInfo;
}

// ── Stream framing helpers ───────────────────────────────────────────────────

/**
 * Minimal libp2p stream surface (libp2p 3.x): AsyncIterable for reads,
 * `send()` for writes. Mirrors the shape used in `seed-bootstrap.ts`.
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

/** Reject if `op` does not settle within `ms`. */
function withTimeout<T>(ms: number, label: string, op: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Formation ${label} timed out after ${ms}ms`)), ms);
    op().then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// ── Result validation ────────────────────────────────────────────────────────

/** Matches the deprecated strand-proto placeholder cadre addrs (`cadre-a-1.local`, …). */
const PLACEHOLDER_CADRE_ADDR = /^cadre-[ab]-\d+\.local$/;

/**
 * Structural check on a `responderCreates` result: the responder must have approved,
 * disclosed a non-empty real identity + cadre (not the deprecated `cadre-*.local`
 * placeholders), and returned a strand it (the responder) created with a real id.
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

// ── Responder (listener) ─────────────────────────────────────────────────────

export interface FormationListenerOptions {
  /** Validate the invitation token; returns whether it is valid and which mode applies. */
  validateToken(token: string): Promise<{ valid: boolean; mode: FormationMode }>;
  /** Validate the initiator's disclosure with the REAL token + disclosure. */
  validateDisclosure(token: string, disclosure: StrandFormationDisclosure): Promise<boolean>;
  /** Provision a strand (`responderCreates`) for the given initiator. */
  provisionStrand(initiatorPartyId: string, disclosure: StrandFormationDisclosure): Promise<FormationProvisionResult>;
  /** Validate the db result echoed back by the initiator (`initiatorCreates`). */
  validateDatabaseResult?(message: FormationDatabaseMessage): Promise<boolean>;
  /** Responder identity, disclosed only AFTER token + disclosure validation passes. */
  getResponderIdentity(): { partyId: string; cadrePeerAddrs: string[] };
  sessionTimeoutMs?: number;
  stepTimeoutMs?: number;
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
  private readonly maxConcurrentSessions: number;
  private readonly registered = new Set<Libp2p>();
  private activeSessions = 0;
  private sessionCounter = 0;

  constructor(options: FormationListenerOptions) {
    this.options = options;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
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
      await this.handleStream(rawStream as LibP2PStream);
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

  private async handleStream(stream: LibP2PStream): Promise<void> {
    if (this.activeSessions >= this.maxConcurrentSessions) {
      const rejection: FormationResultMessage = { approved: false, reason: 'Too many concurrent formation sessions' };
      try { writeFrame(stream, rejection); } catch { /* best effort */ }
      try { await stream.close(); } catch { /* ignore */ }
      return;
    }
    const id = ++this.sessionCounter;
    this.activeSessions++;
    try {
      await withTimeout(this.sessionTimeoutMs, `session#${id}`, () => this.runSession(id, stream));
    } catch (err) {
      log('formation session #%d failed: %o', id, err);
    } finally {
      this.activeSessions--;
      try { await stream.close(); } catch { /* ignore */ }
    }
  }

  private async runSession(id: number, stream: LibP2PStream): Promise<void> {
    const reader = new FrameReader(stream);
    const contact = await withTimeout(this.stepTimeoutMs, `await-contact#${id}`, () => reader.read<FormationContactMessage>());
    log('formation session #%d contact: token=%s party=%s', id, contact.token, contact.partyId);

    const tokenResult = await this.options.validateToken(contact.token);
    if (!tokenResult.valid) {
      const rejection: FormationResultMessage = { approved: false, reason: 'Invalid token' };
      writeFrame(stream, rejection);
      return;
    }

    const disclosureOk = await this.options.validateDisclosure(contact.token, contact.disclosure);
    if (!disclosureOk) {
      const rejection: FormationResultMessage = { approved: false, reason: 'Invalid disclosure' };
      writeFrame(stream, rejection);
      return;
    }

    // Validation passed → safe to disclose responder identity/cadre.
    const identity = this.options.getResponderIdentity();

    if (tokenResult.mode === 'responderCreates') {
      const provisionResult = await this.options.provisionStrand(contact.partyId, contact.disclosure);
      const result: FormationResultMessage = {
        approved: true,
        partyId: identity.partyId,
        cadrePeerAddrs: identity.cadrePeerAddrs,
        provisionResult
      };
      writeFrame(stream, result);
      return;
    }

    // initiatorCreates: approve (no provisionResult yet), then await the initiator's db result.
    const approval: FormationResultMessage = {
      approved: true,
      partyId: identity.partyId,
      cadrePeerAddrs: identity.cadrePeerAddrs
    };
    writeFrame(stream, approval);
    const dbResult = await withTimeout(this.stepTimeoutMs, `await-database#${id}`, () => reader.read<FormationDatabaseMessage>());
    const dbValid = this.options.validateDatabaseResult ? await this.options.validateDatabaseResult(dbResult) : true;
    if (!dbValid) throw new Error('Invalid database result from initiator');
  }
}

// ── Initiator (dialer) ───────────────────────────────────────────────────────

export interface FormationDialOptions {
  /** The contact message to send (real token, partyId, disclosure, initiator cadre). */
  contact: FormationContactMessage;
  /** Responder multiaddrs to dial. */
  responderAddrs: string[];
  /** Expected provisioning mode (defaults to `responderCreates`). */
  mode?: FormationMode;
  /** Validate the responder's result; a false return aborts the formation. */
  validateResponse(response: FormationResultMessage): Promise<boolean>;
  /** `initiatorCreates` only: provision the strand locally after approval. */
  provisionStrand?(responderPartyId: string): Promise<FormationProvisionResult>;
  sessionTimeoutMs?: number;
  stepTimeoutMs?: number;
  protocolId?: string;
}

/**
 * Initiator side of the native formation protocol. Dials the responder, sends the
 * contact (carrying the real disclosure/token/cadre), validates the responder's
 * result, and — for `initiatorCreates` — provisions and echoes the strand back.
 */
export async function dialFormation(node: Libp2p, options: FormationDialOptions): Promise<FormationProvisionResult> {
  if (options.responderAddrs.length === 0) {
    throw new Error('No responder addresses available for formation');
  }
  const mode = options.mode ?? 'responderCreates';
  const protocolId = options.protocolId ?? FORMATION_PROTOCOL;
  const sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const addr = multiaddr(options.responderAddrs[0]);

  return withTimeout(sessionTimeoutMs, 'dial', async () => {
    const rawStream = await withTimeout(stepTimeoutMs, 'dial-connect', async () => node.dialProtocol(addr, protocolId));
    const stream = rawStream as unknown as LibP2PStream;
    try {
      const reader = new FrameReader(stream);
      writeFrame(stream, options.contact);

      const response = await withTimeout(stepTimeoutMs, 'await-response', () => reader.read<FormationResultMessage>());
      if (!response.approved) {
        throw new Error(`Formation rejected: ${response.reason ?? 'no reason provided'}`);
      }
      const ok = await options.validateResponse(response);
      if (!ok) throw new Error('Responder result failed validation');

      if (mode === 'responderCreates') {
        if (!response.provisionResult) throw new Error('Missing provision result for responderCreates mode');
        return response.provisionResult;
      }

      // initiatorCreates: provision locally and echo the strand/db back on the same stream.
      if (!options.provisionStrand) throw new Error('provisionStrand callback required for initiatorCreates mode');
      const provision = await options.provisionStrand(response.partyId ?? '');
      const dbMessage: FormationDatabaseMessage = {
        strand: provision.strand,
        dbConnectionInfo: provision.dbConnectionInfo
      };
      writeFrame(stream, dbMessage);
      return provision;
    } finally {
      try { await stream.close(); } catch { /* ignore */ }
    }
  });
}
