/**
 * Cadre invitation redemption transport: `/sereus/cadre-invite/1.0.0`.
 *
 * A device holding a cadre invitation (an owner-signed `CadreInvite` row plus the private
 * half of the invitation keypair, see {@link CadreInvitation}) dials ANY member machine the
 * invitation names and proves possession; the member seats the row if it does not hold it
 * yet, writes the device's `CadrePeer` row (and `OwnerKey` row, when the invitation grants
 * ownership) through `ControlDatabase.redeemCadreInvite`, and answers with the party id,
 * the row and dial hints. The owner that minted the invitation need not be online.
 *
 * Same shape as the seed and wake protocols: one length-prefixed JSON frame each way over
 * the shared primitives in `control-stream.ts`. Stranger-facing by design — the device is
 * not a member when it dials — so the connection gate admits a stranger while a live
 * invitation exists (`membership-connection-gater.ts`), and the handler's own trust
 * decision is the proof of possession: nothing touches the database for a caller that
 * cannot prove it holds the invitation and is the identity it names.
 *
 * The seed protocol is left untouched so `SeedMessage` can grow independently.
 */

import debug from 'debug';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { Connection, Libp2p } from '@libp2p/interface';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { type ControlStream, withDeadline, exchangeFrame, readStreamToEnd, replyAndClose } from './control-stream.js';
import { decodeLengthPrefixedFrame } from './seed-bootstrap.js';
import { relayedRequestBudgetMs } from './link-budget.js';
import {
  cadreInviteRedeemMessage,
  cadreInviteConsentMessage,
  CadreInviteIssuerUnknownError,
  InvitationExhaustedError,
  type ControlDatabase
} from './control-database.js';
import { verifyCadreInviteRow, verifyCadreInviteRedemption } from './peer-authorization.js';
import { ed25519PublicKeyB64FromPeerId, requireEd25519PublicKeyB64 } from './ed25519-key.js';
import { trailingPeerId } from './peer-record.js';
import { nextMacrotask } from './peer-dial.js';
import { chainMessages } from './control-retry.js';
import { isRetriableControlWriteFailure } from './control-write-retry.js';
import type { CadreInviteRow, SeedPeer } from './types.js';

const log = debug('sereus:cadre:invite-proto');

/** Protocol id for cadre invitation redemption (parallel to `/sereus/seed/1.0.0`). */
export const CADRE_INVITE_PROTOCOL = '/sereus/cadre-invite/1.0.0';

/**
 * Cap on either frame. A request is one signed row, two signatures and a few addresses;
 * a reply adds a peer list of a cadre's size. Both fit in a few KB; 64 KiB is the
 * defensive bound a stranger can make the handler buffer.
 */
const MAX_CADRE_INVITE_MSG_SIZE = 64 * 1024;

/**
 * Default time the member waits for the request frame before aborting the read (ms). The
 * read only: a stranger opens the stream, so the bound is on a caller that opens one and
 * never sends. Same figure as the seed handler's.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: a receiver cap on one frame on a stream the peer already opened; it bounds a peer that opens a stream and never sends, not the dial
const DEFAULT_REDEEM_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound redemptions; over it the handler answers `busy`. */
const DEFAULT_MAX_CONCURRENT_REDEMPTIONS = 100;

/** Longest string field accepted off the wire; a stamp is 342 base64url chars, a signature 86. */
const MAX_WIRE_FIELD_LENGTH = 1024;

/** Most addresses a request may carry for the device, and a reply per peer (`sanitizeAddrs`). */
const MAX_ADDRS = 16;

/** Most machines an invitation bundle may name; the issuer caps its own list far below this. */
const MAX_BUNDLE_MEMBERS = 64;

/** Most peers a reply may carry as dial hints. */
const MAX_REPLY_PEERS = 256;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

// ── The invitation bundle ────────────────────────────────────────────────────

/**
 * What an owner hands out (QR, paste, link) and a device redeems. An invitation is an
 * ed25519 keypair: the row holds the public half, `invitePrivateKey` is the proof of
 * possession, and whoever holds this bundle can redeem it — treat it as a bearer
 * credential for the row's lifetime (an untargeted owner-granting one defaults to a
 * 15-minute expiry for that reason).
 *
 * Carrying the signed row is what makes redemption work at a member that has not received
 * the row by replication: the member seats it from the bundle under its stored issuer
 * signature. The row's own signature covers every column, so a bundle whose row was
 * altered cannot be seated anywhere.
 */
export interface CadreInvitation {
  v: 1;
  /** The cadre the invitation joins; a device refuses one for another party. */
  partyId: string;
  /** The invitation's ed25519 seed, base64url: the proof of possession. */
  invitePrivateKey: string;
  /** The owner-signed row exactly as issued (`ControlDatabase.insertCadreInvite`). */
  invite: CadreInviteRow;
  /**
   * The issuer's anchored owner keys. The redeeming device pins them before it dials
   * (`CadreNode.trustOwnerKeys`) and checks the member's reply against them. Sourced from
   * the issuer's node-local anchor only, never the replicated `OwnerKey` table, for the
   * reason the seed invite gives: the device anchors whatever arrives here.
   */
  ownerKeys: string[];
  /**
   * Multiaddrs ending in `/p2p/<peerId>`: the issuer's own first, then up to
   * `INVITATION_SIBLING_MACHINES` other members (`invitation-bootstrap.ts`). The device
   * tries them in order.
   */
  members: string[];
}

/** Encode a bundle for out-of-band delivery: base64url over JSON, as seeds and open invitations are. */
export function encodeCadreInvitation(invitation: CadreInvitation): string {
  return uint8ArrayToString(new TextEncoder().encode(JSON.stringify(invitation)), 'base64url');
}

/**
 * Decode a bundle, refusing anything that is not a well-formed version-1
 * {@link CadreInvitation}. Standalone so a client without a node (a settings screen that
 * wants to show which cadre an invitation joins) can decode one.
 *
 * @throws on a string that is not base64url JSON, or decodes to another shape or version.
 */
export function decodeCadreInvitation(encoded: string): CadreInvitation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(encoded.trim(), 'base64url')));
  } catch (error) {
    throw new Error('Cadre invitation does not decode as base64url JSON', { cause: error });
  }
  if (!isWellFormedCadreInvitation(parsed)) {
    throw new Error('Cadre invitation is malformed or of an unsupported version');
  }
  return parsed;
}

function isWellFormedCadreInvitation(value: unknown): value is CadreInvitation {
  if (typeof value !== 'object' || value === null) return false;
  const { v, partyId, invitePrivateKey, invite, ownerKeys, members } = value as Record<string, unknown>;
  return v === 1
    && isBoundedString(partyId)
    && isEd25519KeyB64(invitePrivateKey)
    && isWellFormedCadreInviteRow(invite)
    && Array.isArray(ownerKeys) && ownerKeys.length > 0 && ownerKeys.every((key) => isEd25519KeyB64(key))
    && Array.isArray(members) && members.length <= MAX_BUNDLE_MEMBERS && members.every((addr) => isBoundedString(addr));
}

// ── Wire messages ────────────────────────────────────────────────────────────

/** Device → member: one frame, the whole redemption. */
export interface CadreInviteRedeemRequest {
  v: 1;
  /** The cadre the device believes it is joining; a machine serving another party refuses by name. */
  partyId: string;
  /** The owner-signed row from the bundle. */
  invite: CadreInviteRow;
  /** The device's ed25519 public key, base64url; must be the key behind the connecting peer id. */
  peerKey: string;
  /** The device's dialable addresses; empty for a phone. Stored on its `CadrePeer` row. */
  multiaddrs: string[];
  /** Single-use nonce the device minted (`generateStampId`); both signatures cover it. */
  usageStampId: string;
  /** By `invitePrivateKey` over the `'redeem'` digest. */
  inviteSig: string;
  /** By the device's identity key over the `'consent'` digest. */
  peerSig: string;
}

/**
 * Why a member refused a redemption. Retryability is {@link CADRE_INVITE_REJECTION_RETRYABLE}'s;
 * a retryable code moves the device to the next address the bundle names.
 */
export type CadreInviteRejectionCode =
  /**
   * The issuer's `OwnerKey` row is not on this member (not replicated yet), or the issuer was
   * removed; the member cannot tell which, so the device tries the next address.
   */
  | 'issuer-unknown'
  /**
   * A signature does not verify, the peer key is not the connecting identity, the request or
   * the row is malformed, or the invitation names another device.
   */
  | 'invite-invalid'
  /** Expired, withdrawn, exhausted, or issued by a key that is no longer an owner here. */
  | 'invite-spent'
  /** This machine serves another cadre than the one the invitation names. */
  | 'party-mismatch'
  /** The member is at its cap on concurrent redemptions. */
  | 'busy'
  /** The write failed transiently (the write retry gave up); nothing was recorded. */
  | 'conflict'
  /**
   * An unexpected member-side failure, or a request frame the member could not read (timed
   * out, oversized, not JSON): nothing was proved either way, so the device tries the next
   * address, as the formation responder's `internal` is read.
   */
  | 'internal';

/** Which refusals are worth repeating at the next address — the one place that says so. */
export const CADRE_INVITE_REJECTION_RETRYABLE: Readonly<Record<CadreInviteRejectionCode, boolean>> = {
  'issuer-unknown': true,
  'invite-invalid': false,
  'invite-spent': false,
  'party-mismatch': false,
  'busy': true,
  'conflict': true,
  'internal': true
};

/** Is `value` a code this build knows? Own keys only, so a peer's `'constructor'` does not pass. */
export function isCadreInviteRejectionCode(value: unknown): value is CadreInviteRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CADRE_INVITE_REJECTION_RETRYABLE, value);
}

/** Member → device. */
export interface CadreInviteRedeemReply {
  accepted: boolean;
  /** Present iff `!accepted`. */
  code?: CadreInviteRejectionCode;
  /** Human-facing text; present iff `!accepted`. */
  reason?: string;
  /** The member's party id; present iff `accepted`. */
  partyId?: string;
  /** The invitation row as this member holds it; present iff `accepted`. */
  invite?: CadreInviteRow;
  /**
   * Dial hints for the rest of the cadre, unsigned: the member's own projection of its
   * `CadrePeer` rows (`ControlDatabase.querySeedPeers`). `isOwner` is a dial hint only, as
   * the seed's NOTE says; the device derives trust from its anchor, never from this.
   */
  peers?: SeedPeer[];
}

/** An accepting reply, every optional field present. */
export interface CadreInviteAccepted extends CadreInviteRedeemReply {
  accepted: true;
  partyId: string;
  invite: CadreInviteRow;
  peers: SeedPeer[];
}

/** A refusal as the member sends it: a code, a reason, nothing else. */
interface CadreInviteRejection extends CadreInviteRedeemReply {
  accepted: false;
  code: CadreInviteRejectionCode;
  reason: string;
}

/**
 * A refusal as the device reads it: the code and reason verbatim off the wire, untyped, so
 * {@link CadreInviteRejectedError} is the one place that classifies a code this build does
 * not know (as `'unrecognized'`, retryable) rather than the decoder folding it into a code
 * it does.
 */
interface CadreInviteRefusalFrame {
  accepted: false;
  code: unknown;
  reason: unknown;
}

function rejection(code: CadreInviteRejectionCode, reason: string): CadreInviteRejection {
  return { accepted: false, code, reason };
}

// ── Errors the device sees ───────────────────────────────────────────────────

/**
 * A member answered and refused. `code` is `'unrecognized'` when the frame carried none this
 * build knows (the two machines may run different versions), and such a refusal counts as
 * retryable: trying the next address on an unknown answer is safe, giving up is not.
 */
export class CadreInviteRejectedError extends Error {
  readonly code: CadreInviteRejectionCode | 'unrecognized';
  readonly reason: string;
  readonly retryable: boolean;

  /** Both arguments come straight off the wire, so neither is trusted to have its declared type. */
  constructor(code: unknown, reason: unknown) {
    const text = typeof reason === 'string' ? reason : 'no reason provided';
    super(`Cadre invitation refused: ${text}`);
    this.name = 'CadreInviteRejectedError';
    this.code = isCadreInviteRejectionCode(code) ? code : 'unrecognized';
    this.reason = text;
    this.retryable = this.code === 'unrecognized' || CADRE_INVITE_REJECTION_RETRYABLE[this.code];
  }
}

/** What one address the bundle named came to. */
export interface CadreInviteAddressOutcome {
  addr: string;
  /** A dial or exchange failure, or a retryable {@link CadreInviteRejectedError}. */
  error: Error;
}

/**
 * Every address the bundle names was tried and none accepted: each failed to dial, answered
 * malformed, or refused retryably. Always retryable; `outcomes` says what each address did.
 */
export class CadreInviteUnreachableError extends Error {
  readonly retryable = true;

  constructor(readonly outcomes: readonly CadreInviteAddressOutcome[]) {
    super(outcomes.length === 0
      ? 'Cadre invitation names no dialable member'
      : `Cadre invitation could not be redeemed at any of its ${outcomes.length} address(es): `
        + outcomes.map((outcome) => `${outcome.addr}: ${outcome.error.message}`).join('; '));
    this.name = 'CadreInviteUnreachableError';
  }
}

/**
 * A member accepted but its reply does not check out: another party id, another invitation
 * key, or a row not signed by one of the pinned owner keys. Final: a machine that answers
 * like this is not a member of the cadre the invitation names, and the row it wrote (if any)
 * is in a database the device will never trust.
 */
export class CadreInviteReplyInvalidError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(`Cadre invitation reply refused: ${message}`);
    this.name = 'CadreInviteReplyInvalidError';
  }
}

// ── Shape checks (both directions) ───────────────────────────────────────────

function isBoundedString(value: unknown, max = MAX_WIRE_FIELD_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isEd25519KeyB64(value: unknown): value is string {
  if (!isBoundedString(value) || !BASE64URL.test(value)) return false;
  try {
    requireEd25519PublicKeyB64(value, 'key');
    return true;
  } catch {
    return false;
  }
}

/** Is `value` a {@link CadreInviteRow} with every column in its stored form and bounded? */
export function isWellFormedCadreInviteRow(value: unknown): value is CadreInviteRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return isEd25519KeyB64(row.key)
    && (row.peerId === null || isBoundedString(row.peerId))
    && typeof row.grantsOwner === 'boolean'
    && (row.expiresAt === null || isBoundedString(row.expiresAt))
    && (row.totalUses === null || (Number.isInteger(row.totalUses) && (row.totalUses as number) >= 1))
    && isBoundedString(row.stampId)
    && isEd25519KeyB64(row.issuerKey)
    && isBoundedString(row.issuerSig);
}

function isWellFormedRedeemRequest(value: unknown): value is CadreInviteRedeemRequest {
  if (typeof value !== 'object' || value === null) return false;
  const { v, partyId, invite, peerKey, multiaddrs, usageStampId, inviteSig, peerSig } = value as Record<string, unknown>;
  return v === 1
    && isBoundedString(partyId)
    && isWellFormedCadreInviteRow(invite)
    && isEd25519KeyB64(peerKey)
    && Array.isArray(multiaddrs)
    && isBoundedString(usageStampId)
    && isBoundedString(inviteSig)
    && isBoundedString(peerSig);
}

/**
 * Keep only parsable, distinct multiaddr strings, capped at {@link MAX_ADDRS}, order kept.
 * Applied on both sides: the member bounds what it stores on the device's row, the device
 * bounds what it merges into its peer store. A malformed entry is skipped, not fatal.
 */
export function sanitizeAddrs(addrs: unknown): string[] {
  if (!Array.isArray(addrs)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of addrs) {
    if (out.length >= MAX_ADDRS) break;
    if (!isBoundedString(entry) || seen.has(entry)) continue;
    try {
      multiaddr(entry);
    } catch (error) {
      log('addrs: skipping unparsable entry: %o', error);
      continue;
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** The reply's peer list, bounded and each entry's addresses sanitized; anything else dropped. */
function sanitizePeers(peers: unknown): SeedPeer[] {
  if (!Array.isArray(peers)) return [];
  const out: SeedPeer[] = [];
  for (const entry of peers) {
    if (out.length >= MAX_REPLY_PEERS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { peerId, multiaddrs, isOwner, publicKey } = entry as Record<string, unknown>;
    if (!isBoundedString(peerId)) continue;
    out.push({
      peerId,
      multiaddrs: sanitizeAddrs(multiaddrs),
      isOwner: isOwner === true,
      ...(isEd25519KeyB64(publicKey) ? { publicKey } : {})
    });
  }
  return out;
}

/**
 * Read a reply frame into a typed reply, sanitizing the attacker-influenced fields of an
 * acceptance. A refusal keeps only its code and reason, as sent. Throws on a frame that is
 * neither.
 */
function decodeReply(value: unknown): CadreInviteAccepted | CadreInviteRefusalFrame {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Cadre invitation reply is not an object');
  }
  const reply = value as Record<string, unknown>;
  if (reply.accepted !== true) {
    return { accepted: false, code: reply.code, reason: reply.reason };
  }
  if (!isBoundedString(reply.partyId) || !isWellFormedCadreInviteRow(reply.invite)) {
    throw new Error('Cadre invitation acceptance is missing its party id or a well-formed row');
  }
  return { accepted: true, partyId: reply.partyId, invite: reply.invite, peers: sanitizePeers(reply.peers) };
}

// ── Request construction (device side) ───────────────────────────────────────

/** What the device signs with: its identity keypair in the crypto plugin's base64url form. */
export interface RedeemSigner {
  /** The device's ed25519 public key, base64url — the key behind its peer id. */
  peerKey: string;
  /** The device's ed25519 seed, base64url. */
  peerPrivateKey: string;
}

/**
 * Build and sign the request for `invitation`: the holder's `'redeem'` signature with the
 * invitation's private key and the device's `'consent'` signature with its own, both over
 * (invitation key, `usageStampId`, device key). The same bytes the schema verifies at the
 * member (`cadreInviteRedeemMessage` / `cadreInviteConsentMessage`).
 */
export function signRedeemRequest(
  invitation: CadreInvitation,
  signer: RedeemSigner,
  usageStampId: string,
  multiaddrs: string[]
): CadreInviteRedeemRequest {
  const fields = { inviteKey: invitation.invite.key, usageStampId, peerKey: signer.peerKey };
  const signB64 = (message: Uint8Array, privateKey: string): string =>
    sign(message, privateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
  return {
    v: 1,
    partyId: invitation.partyId,
    invite: invitation.invite,
    peerKey: signer.peerKey,
    multiaddrs: sanitizeAddrs(multiaddrs),
    usageStampId,
    inviteSig: signB64(cadreInviteRedeemMessage(fields), invitation.invitePrivateKey),
    peerSig: signB64(cadreInviteConsentMessage(fields), signer.peerPrivateKey)
  };
}

/**
 * The device's check on an acceptance: the same party, the same invitation key, and a row
 * signed by an issuer the device pinned from the bundle. Throws
 * {@link CadreInviteReplyInvalidError} naming the first failure.
 *
 * What it proves is bounded: the request already carried the owner-signed row, so a machine
 * that is not a member can echo it. The check catches a reply for another party or
 * invitation and a row the pinned owners never signed; whether the answering machine is a
 * member is settled afterwards, when the device syncs the control database and judges every
 * row against its anchor (`CadreNode.listAuthorizedMembers`).
 */
export function verifyRedeemReply(
  reply: CadreInviteAccepted,
  invitation: CadreInvitation,
  isTrustedIssuer: (ownerKey: string) => boolean
): void {
  if (reply.partyId !== invitation.partyId) {
    throw new CadreInviteReplyInvalidError(`the member serves party ${reply.partyId}, the invitation names ${invitation.partyId}`);
  }
  if (reply.invite.key !== invitation.invite.key) {
    throw new CadreInviteReplyInvalidError('the member answered for a different invitation');
  }
  if (!isTrustedIssuer(reply.invite.issuerKey)) {
    throw new CadreInviteReplyInvalidError('the row the member holds is not issued by one of the invitation\'s owner keys');
  }
  if (!verifyCadreInviteRow(reply.invite)) {
    throw new CadreInviteReplyInvalidError('the row the member holds is not signed by its issuer');
  }
}

// ── Member side (handler) ────────────────────────────────────────────────────

/** The control-database surface a redemption needs; a `ControlDatabase` satisfies it. */
export type CadreInviteStore = Pick<ControlDatabase, 'seatCadreInvite' | 'isCadreInviteLive' | 'redeemCadreInvite' | 'querySeedPeers'>;

export interface CadreInviteHandlerOptions {
  /** This member's party id; a request for another party is refused by name. */
  partyId: string;
  store: CadreInviteStore;
  /**
   * Push this member's control store to the device and resolve once the push has finished,
   * called after the request verified and before the row is seated and the admission is
   * written. Absent, the writes go ahead with the device holding nothing; see
   * `catchUpDeviceIfLive` for why that tears on a member alone with the device.
   */
  catchUpDevice?: (peerId: string) => Promise<void>;
  /** Time to wait for the request frame; default {@link DEFAULT_REDEEM_READ_TIMEOUT_MS}. */
  redeemReadTimeoutMs?: number;
  /** Cap on concurrent inbound redemptions; default {@link DEFAULT_MAX_CONCURRENT_REDEMPTIONS}. */
  maxConcurrentRedemptions?: number;
}

/** Constraint names the schema refuses a redemption with, and the code each maps to. */
const REDEEM_CONSTRAINT_CODES: ReadonlyArray<[RegExp, CadreInviteRejectionCode, string]> = [
  [/CHECK constraint failed: Authorized\b/, 'invite-spent', 'The invitation is expired, withdrawn, exhausted, or its issuer is no longer an owner'],
  [/CHECK constraint failed: (InvitePossessed|PeerConsented|PeerExists|OwnerExists)\b/, 'invite-invalid', 'The redemption does not satisfy the invitation'],
  [/CHECK constraint failed: NotRevoked\b/, 'invite-spent', 'The invitation was withdrawn'],
];

/** Which named constraint, if any, refused the write — read off the error's cause chain. */
function constraintRejection(error: unknown): CadreInviteRejection | null {
  if (!(error instanceof Error)) return null;
  const messages = chainMessages(error);
  for (const [pattern, code, reason] of REDEEM_CONSTRAINT_CODES) {
    if (messages.some((message) => pattern.test(message))) return rejection(code, reason);
  }
  return null;
}

/** A write failure that is not a refusal: the retry gave up (`conflict`), or something else (`internal`). */
function writeFailureRejection(error: unknown): CadreInviteRejection {
  // NOTE: a seat torn on a member alone with an uncaught-up device was measured answering
  // `internal`, not `conflict` (cadre-invite-redeemed-at-a-member-without-the-row). Both are
  // retryable, so the device is unaffected; if the two codes ever diverge in retryability,
  // find which tear `isRetriableControlWriteFailure` does not recognise.
  return isRetriableControlWriteFailure(error)
    ? rejection('conflict', 'The redemption write failed transiently; nothing was recorded')
    : rejection('internal', 'Internal redemption error');
}

/**
 * Member side: registers the handler and drives each inbound stream through the checks in
 * cost order — shape, connecting identity, both signatures, target device — so no database
 * work happens for a stranger that cannot prove anything, then hands the device the control
 * store (`catchUpDevice`), seats the row and redeems.
 * Hardened as the seed handler is: a concurrency cap (over it, `busy`) and a read timeout.
 *
 * Registered only by a started `CadreNode`, after its control database is up, like the
 * formation responder; nothing here is reachable on a node without one.
 */
export class CadreInviteHandler {
  private readonly options: CadreInviteHandlerOptions;
  private readonly readTimeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly registered = new Set<Libp2p>();
  private active = 0;

  constructor(options: CadreInviteHandlerOptions) {
    this.options = options;
    this.readTimeoutMs = options.redeemReadTimeoutMs ?? DEFAULT_REDEEM_READ_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrentRedemptions ?? DEFAULT_MAX_CONCURRENT_REDEMPTIONS;
  }

  /** In-flight inbound redemptions. */
  get activeCount(): number {
    return this.active;
  }

  /**
   * Register on `node`; rejects when libp2p refuses the registration. `runOnLimitedConnection`
   * because a phone redeems through a relay, whose connection libp2p marks limited; the
   * exchange is two small frames, well inside any relay's cap.
   */
  async register(node: Libp2p, protocolId: string = CADRE_INVITE_PROTOCOL): Promise<void> {
    if (this.registered.has(node)) return;
    await node.handle(protocolId, async (rawStream: unknown, rawConnection: unknown) => {
      await this.handleStream(rawStream as ControlStream, (rawConnection as Connection).remotePeer.toString());
    }, { runOnLimitedConnection: true });
    this.registered.add(node);
    log('cadre invitation handler registered (%s)', protocolId);
  }

  async unregister(node: Libp2p, protocolId: string = CADRE_INVITE_PROTOCOL): Promise<void> {
    if (!this.registered.has(node)) return;
    await node.unhandle(protocolId);
    this.registered.delete(node);
    log('cadre invitation handler unregistered (%s)', protocolId);
  }

  /**
   * One inbound redemption: read the frame, decide, reply, close. Public as the seam the
   * protocol spec drives directly; `remotePeerId` is the connection's authenticated peer.
   */
  async handleStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    if (this.active >= this.maxConcurrent) {
      log('refusing redemption from %s: %d in flight at cap %d', remotePeerId, this.active, this.maxConcurrent);
      await replyAndClose(stream, rejection('busy', 'Too many concurrent redemptions'), 'Cadre invite');
      return;
    }
    this.active++;
    try {
      const reply = await this.decide(stream, remotePeerId);
      log('redemption from %s: %s', remotePeerId, reply.accepted ? 'accepted' : `refused (${reply.code})`);
      await replyAndClose(stream, reply, 'Cadre invite');
    } catch (error) {
      log('redemption from %s failed: %o', remotePeerId, error);
      await replyAndClose(stream, rejection('internal', 'Internal redemption error'), 'Cadre invite');
    } finally {
      this.active--;
    }
  }

  /**
   * Read the request frame to EOF, bounded and size-capped; JSON only, shape is `decide`'s.
   * Throws on a frame that cannot be read, which {@link handleStream} answers `internal`:
   * a read timeout or a cut frame proves nothing about the invitation, so the device must
   * stay free to try the next address.
   */
  private async readRequest(stream: ControlStream): Promise<unknown> {
    const data = await readStreamToEnd(stream, { maxBytes: MAX_CADRE_INVITE_MSG_SIZE, timeoutMs: this.readTimeoutMs, label: 'Cadre invite' });
    return JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data, MAX_CADRE_INVITE_MSG_SIZE)));
  }

  private async decide(stream: ControlStream, remotePeerId: string): Promise<CadreInviteRedeemReply> {
    const request = await this.readRequest(stream);
    const refused = this.checkRequest(request, remotePeerId);
    if (refused) return refused;
    return await this.seatAndRedeem(request as CadreInviteRedeemRequest, remotePeerId);
  }

  /**
   * The checks that cost no database work, in order: shape, party, connecting identity (an
   * ed25519 peer id is an identity multihash of the very key, and this is the only layer that
   * can check the pair), both signatures, and a targeted invitation's device.
   */
  private checkRequest(request: unknown, remotePeerId: string): CadreInviteRejection | null {
    if (!isWellFormedRedeemRequest(request)) {
      return rejection('invite-invalid', 'Malformed redemption request');
    }
    if (request.partyId !== this.options.partyId) {
      return rejection('party-mismatch', 'This machine serves another cadre');
    }
    if (ed25519PublicKeyB64FromPeerId(remotePeerId) !== request.peerKey) {
      return rejection('invite-invalid', 'The peer key is not the connecting identity');
    }
    const fields = { inviteKey: request.invite.key, usageStampId: request.usageStampId, peerKey: request.peerKey };
    if (!verifyCadreInviteRedemption(fields, request.inviteSig, request.peerSig)) {
      return rejection('invite-invalid', 'The redemption signatures do not verify');
    }
    if (request.invite.peerId !== null && request.invite.peerId !== remotePeerId) {
      return rejection('invite-invalid', 'The invitation names another device');
    }
    return null;
  }

  /**
   * Hand the device this member's control store, seat the row from the bundle (its own
   * transaction; a no-op when held), then redeem. The push comes first because the seat is
   * already a write the device takes part in (see {@link catchUpDeviceIfLive}). An issuer this
   * member does not know as an owner is the one retryable refusal left: the device tries the
   * next address, which may hold the issuer's row.
   */
  private async seatAndRedeem(request: CadreInviteRedeemRequest, remotePeerId: string): Promise<CadreInviteRedeemReply> {
    const { store } = this.options;
    await this.catchUpDeviceIfLive(request.invite, remotePeerId);
    try {
      await store.seatCadreInvite(request.invite);
    } catch (error) {
      if (error instanceof CadreInviteIssuerUnknownError) {
        return rejection('issuer-unknown', 'The invitation\'s issuer is not known as an owner here');
      }
      log('seating invitation %s from %s failed: %o', request.invite.key, remotePeerId, error);
      return constraintRejection(error) ?? writeFailureRejection(error);
    }
    try {
      const result = await store.redeemCadreInvite({
        inviteKey: request.invite.key,
        peerId: remotePeerId,
        peerKey: request.peerKey,
        multiaddrs: sanitizeAddrs(request.multiaddrs),
        usageStampId: request.usageStampId,
        inviteSig: request.inviteSig,
        peerSig: request.peerSig
      });
      log('invitation %s redeemed by %s (alreadyMember=%s)', request.invite.key, remotePeerId, result.alreadyMember);
    } catch (error) {
      if (error instanceof InvitationExhaustedError) {
        return rejection('invite-spent', 'The invitation has no uses left');
      }
      log('redeeming invitation %s for %s failed: %o', request.invite.key, remotePeerId, error);
      return constraintRejection(error) ?? writeFailureRejection(error);
    }
    // The row as held: the seat inserted this copy verbatim, or found the same row (its key
    // is the primary key and every column is under the issuer's signature).
    return { accepted: true, partyId: this.options.partyId, invite: request.invite, peers: await this.peersBestEffort() };
  }

  /**
   * Push this member's control store to the device before the first write of the exchange
   * (the seat, when this member does not hold the row; otherwise the admission). The device
   * joined this member's control write cohort when it connected, and a cohort node with no
   * base revision of a block refuses a commit to it; a member alone with the device then has
   * half its cohort refusing, and the write tears instead of committing. With the store in
   * hand the device holds the write too.
   *
   * Only for an invitation still live here, judged on the row this member holds or, before
   * the seat, on the bundle's copy once its issuer signature verifies
   * (`ControlDatabase.isCadreInviteLive`): the holder of a withdrawn, expired or spent one,
   * or of a forged copy naming a real owner, is refused without being sent anything. The
   * retry of an admission already written can read as spent too and is sent nothing; it
   * needs nothing, since the device is a member and the ordinary catch-up reaches it.
   * Best-effort: a failed check or push is logged and the writes go ahead, then commit or are
   * answered retryably.
   */
  private async catchUpDeviceIfLive(invite: CadreInviteRow, remotePeerId: string): Promise<void> {
    const { catchUpDevice, store } = this.options;
    if (!catchUpDevice) return;
    try {
      if (!await store.isCadreInviteLive(invite)) {
        log('invitation %s is not live here; %s is not caught up before the write', invite.key, remotePeerId);
        return;
      }
      // NOTE: accepted tradeoff — when a write then fails (the seat refused, the last use
      // taken by a race, the row expiring between this check and the write), the device keeps
      // a copy of a control store it was not admitted to. It holds a live owner-signed
      // invitation and proved possession and consent, and a seed hands an un-enrolled machine
      // the same information. Revisit if a control table ever carries data a non-member must not see.
      await catchUpDevice(remotePeerId);
    } catch (error) {
      log('catching up %s before its admission failed (writing anyway): %o', remotePeerId, error);
    }
  }

  /** Dial hints are an optimization; a failed read costs the device its hints, not its membership. */
  private async peersBestEffort(): Promise<SeedPeer[]> {
    try {
      return await this.options.store.querySeedPeers();
    } catch (error) {
      log('peer projection for the reply failed (continuing without hints): %o', error);
      return [];
    }
  }
}

// ── Device side (dialer) ─────────────────────────────────────────────────────

export interface RedeemAtMembersOptions {
  /** The bundle: its `members` are dialed in order. */
  invitation: CadreInvitation;
  /** The signed request ({@link signRedeemRequest}); the same one goes to every address. */
  request: CadreInviteRedeemRequest;
  /** Is this owner key one the device pinned from the bundle? The reply check's input. */
  isTrustedIssuer: (ownerKey: string) => boolean;
  /**
   * This machine's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
   * the per-address deadline derives: a dial that may need a relay plus one request
   * (`relayedRequestBudgetMs`, 28.5 s at the default declaration), as seed delivery's is.
   */
  linkRoundTripMs?: number;
  /** Per-address deadline override; default derived from `linkRoundTripMs`. */
  addressBudgetMs?: number;
  protocolId?: string;
}

/** What a successful redemption yields the device. */
export interface CadreInviteRedemption {
  reply: CadreInviteAccepted;
  /** The answering member's peer id, from the address's trailing `/p2p/`; null when it named none. */
  memberPeerId: string | null;
  /** The address that answered. */
  memberAddr: string;
}

/**
 * Open one stream to `addr`, send the request, half-close, read the one reply frame.
 * `signal` is the per-address deadline: it cancels the dial and resets a live stream.
 */
async function exchangeRedemption(
  node: Libp2p,
  addr: Multiaddr,
  request: CadreInviteRedeemRequest,
  signal: AbortSignal,
  budgetMs: number,
  protocolId: string
): Promise<CadreInviteAccepted | CadreInviteRefusalFrame> {
  // `runOnLimitedConnection`: a member may be reachable only through a relay (see `register`).
  const rawStream = await node.dialProtocol(addr, protocolId, { runOnLimitedConnection: true, signal });
  return await exchangeFrame(
    rawStream as unknown as ControlStream,
    signal,
    request,
    async (stream) => {
      const data = await readStreamToEnd(stream, { maxBytes: MAX_CADRE_INVITE_MSG_SIZE, timeoutMs: budgetMs, label: 'Cadre invite reply' });
      return decodeReply(JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data, MAX_CADRE_INVITE_MSG_SIZE))));
    },
    'Cadre invitation redemption aborted by its deadline'
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Device side: try the bundle's addresses one at a time, each under its own deadline, and
 * stop at the first acceptance or the first final refusal. A dial failure, a malformed
 * reply or a retryable refusal moves to the next address.
 *
 * Every address gets the SAME request, with one `usageStampId`: `CadreInviteUsage` is keyed
 * by it, so a member the device gave up on that was still committing cannot admit it twice,
 * and a retry at the next member after a dropped reply is answered as already a member.
 *
 * @throws {CadreInviteRejectedError} on a final refusal (its `retryable` is false).
 * @throws {CadreInviteReplyInvalidError} on an acceptance that fails {@link verifyRedeemReply}.
 * @throws {CadreInviteUnreachableError} when every address was tried and none accepted.
 */
export async function redeemAtMembers(node: Libp2p, options: RedeemAtMembersOptions): Promise<CadreInviteRedemption> {
  const protocolId = options.protocolId ?? CADRE_INVITE_PROTOCOL;
  const budgetMs = options.addressBudgetMs ?? relayedRequestBudgetMs(options.linkRoundTripMs);
  const outcomes: CadreInviteAddressOutcome[] = [];
  for (const addr of options.invitation.members) {
    // Between attempts: libp2p's dial queue needs a macrotask to drop an aborted job.
    if (outcomes.length > 0) await nextMacrotask();
    let parsed: Multiaddr;
    try {
      parsed = multiaddr(addr);
    } catch (error) {
      outcomes.push({ addr, error: new Error('not a multiaddr', { cause: error }) });
      continue;
    }
    try {
      const reply = await withDeadline(budgetMs, `Cadre invitation redemption via ${addr}`,
        (signal) => exchangeRedemption(node, parsed, options.request, signal, budgetMs, protocolId));
      if (!reply.accepted) {
        const refusal = new CadreInviteRejectedError(reply.code, reply.reason);
        if (!refusal.retryable) throw refusal;
        log('redemption via %s refused retryably (%s); trying the next address', addr, refusal.code);
        outcomes.push({ addr, error: refusal });
        continue;
      }
      verifyRedeemReply(reply, options.invitation, options.isTrustedIssuer);
      return { reply, memberPeerId: trailingPeerId(parsed), memberAddr: addr };
    } catch (error) {
      if (error instanceof CadreInviteRejectedError || error instanceof CadreInviteReplyInvalidError) throw error;
      log('redemption via %s failed before an answer (%s); trying the next address', addr, asError(error).message);
      outcomes.push({ addr, error: asError(error) });
    }
  }
  throw new CadreInviteUnreachableError(outcomes);
}
