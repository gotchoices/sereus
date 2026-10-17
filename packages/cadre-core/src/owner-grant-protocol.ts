/**
 * Owner grant redemption transport: `/sereus/owner-grant/1.0.0`.
 *
 * A holder of an owner grant (an owner-signed `OwnerGrant` row plus the private half of the
 * grant keypair, see {@link OwnerGrantBundle}) dials ANY member machine the grant names and
 * proves possession of the grant and of the key it wants seated; the member seats the row if
 * it does not hold it yet and writes the holder's `OwnerKey` row through
 * `ControlDatabase.redeemOwnerGrant`. No machine is admitted and no peer id is named: the
 * holder's network identity has nothing to do with the key it seats, so unlike the invitation
 * protocol there is no connecting-identity check — both signatures already bind the grant, the
 * nonce and the key. The owner that minted the grant need not be online.
 *
 * The exchange shape — one frame each way, the member's hardening and admission of the
 * holder, the holder's address-by-address dialing in passes — is `member-redemption.ts`'s,
 * shared with the invitation protocol; this module supplies the grant's bundle, request,
 * checks, writes and refusal codes. Stranger-facing by design, classed `stranger-open` in
 * `control-protocol-guard.ts`; the handler's own trust decision is the two signatures.
 */

import debug from 'debug';
import type { Libp2p } from '@libp2p/interface';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { sign } from '@optimystic/quereus-plugin-crypto';
import {
  ownerGrantRedeemMessage,
  ownerGrantConsentMessage,
  OwnerGrantIssuerUnknownError,
  InvitationExhaustedError,
  type ControlDatabase
} from './control-database.js';
import { verifyOwnerGrantRow, verifyOwnerGrantRedemption } from './peer-authorization.js';
import { OWNER_KEY_MAX_LABEL } from './owner-key-export.js';
import { CADRE_INVITATION_PREFIX, CADRE_JOIN_REQUEST_PREFIX, OWNER_GRANT_PREFIX, OWNER_KEY_EXPORT_STEM } from './cadre-join-request.js';
import {
  MemberRedemptionHandler,
  constraintRefusal,
  dialRedemption,
  dialRedemptionInPasses,
  isBoundedString,
  isEd25519KeyB64,
  isNullableBoundedString,
  isNullableUseCap,
  rejection,
  writeFailureRefusal,
  type ConstraintRefusalRow,
  type MemberRedemption,
  type MemberRedemptionHandlerOptions,
  type MemberRedemptionOptions,
  type MemberRedemptionPassOptions,
  type RedemptionAddressOutcome,
  type RedemptionRejection
} from './member-redemption.js';
import type { OwnerSign } from './owner-signer.js';
import type { CadreJoinProgress, OwnerGrantRow } from './types.js';

const log = debug('sereus:cadre:owner-grant-proto');

/** Protocol id for owner grant redemption (parallel to `/sereus/cadre-invite/1.0.0`). */
export const OWNER_GRANT_PROTOCOL = '/sereus/owner-grant/1.0.0';

/** What the dialer calls the credential in log lines, deadline labels and error text. */
const LABEL = 'Owner grant';

/** Most machines a grant bundle may name; the issuer caps its own list far below this. */
const MAX_BUNDLE_MEMBERS = 64;

// ── The grant bundle ─────────────────────────────────────────────────────────

/**
 * What an owner hands out (QR, paste, file) and a holder redeems. A grant is an ed25519
 * keypair: the row holds the public half, `grantPrivateKey` is the proof of possession, and
 * whoever holds this bundle can become an owner of the party — a bearer credential for admin
 * rights for the row's lifetime (15 minutes by default; a backup grant has no expiry and is
 * kept as carefully as an owner key).
 *
 * Carrying the signed row is what makes redemption work at a member that has not received
 * the row by replication: the member seats it from the bundle under its stored issuer
 * signature. The row's own signature covers every column, so a bundle whose row was altered
 * cannot be seated anywhere. `members` are the party's addresses at mint time, so a backup
 * grant can go stale if every member's address changes.
 */
export interface OwnerGrantBundle {
  v: 1;
  /** The cadre the grant makes an owner of; a holder refuses one for another party. */
  partyId: string;
  /** The grant's ed25519 seed, base64url: the proof of possession. */
  grantPrivateKey: string;
  /** The owner-signed row exactly as issued (`ControlDatabase.insertOwnerGrant`). */
  grant: OwnerGrantRow;
  /**
   * The issuer's anchored owner keys. The holder pins them before it dials
   * (`CadreNode.trustOwnerKeys`) and checks the member's reply against them. Sourced from the
   * issuer's node-local anchor only, never the replicated `OwnerKey` table, for the reason the
   * invitation gives: the holder anchors whatever arrives here.
   */
  ownerKeys: string[];
  /** As `CadreInvitation.members`: multiaddrs ending in `/p2p/<peerId>`, the issuer's first, at most six in all. */
  members: string[];
}

/**
 * Encode a bundle for out-of-band delivery: {@link OWNER_GRANT_PREFIX}, then base64url over
 * JSON. The prefix lets an app tell a grant from an invitation, a join request or an owner key
 * and name the mistake when one is pasted for the other.
 */
export function encodeOwnerGrant(bundle: OwnerGrantBundle): string {
  return `${OWNER_GRANT_PREFIX}${uint8ArrayToString(new TextEncoder().encode(JSON.stringify(bundle)), 'base64url')}`;
}

/**
 * Decode a bundle, refusing anything that is not a well-formed version-1
 * {@link OwnerGrantBundle} behind {@link OWNER_GRANT_PREFIX}. Standalone, like
 * `decodeCadreInvitation`, so a client without a node can decode one.
 *
 * @throws on an owner key, a cadre invitation or a join request, a string without the prefix
 *   or that is not base64url JSON after it, or one that decodes to another shape or version.
 */
export function decodeOwnerGrant(encoded: string): OwnerGrantBundle {
  const trimmed = encoded.trim();
  if (trimmed.startsWith(OWNER_KEY_EXPORT_STEM)) {
    throw new Error('This is an owner key, not an owner grant; it is private, so import it only where the app asks for an owner key');
  }
  if (trimmed.startsWith(CADRE_INVITATION_PREFIX)) {
    throw new Error('This is a cadre invitation, not an owner grant; paste it where the app asks for an invitation');
  }
  if (trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
    throw new Error('This is a join request, not an owner grant; paste it into the app that manages your cadre');
  }
  if (!trimmed.startsWith(OWNER_GRANT_PREFIX)) {
    throw new Error(`Owner grant must start with "${OWNER_GRANT_PREFIX}" (this one starts with "${trimmed.slice(0, OWNER_GRANT_PREFIX.length)}")`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(trimmed.slice(OWNER_GRANT_PREFIX.length), 'base64url')));
  } catch (error) {
    throw new Error('Owner grant does not decode as base64url JSON', { cause: error });
  }
  if (!isWellFormedOwnerGrantBundle(parsed)) {
    throw new Error('Owner grant is malformed or of an unsupported version');
  }
  return parsed;
}

function isWellFormedOwnerGrantBundle(value: unknown): value is OwnerGrantBundle {
  if (typeof value !== 'object' || value === null) return false;
  const { v, partyId, grantPrivateKey, grant, ownerKeys, members } = value as Record<string, unknown>;
  return v === 1
    && isBoundedString(partyId)
    && isEd25519KeyB64(grantPrivateKey)
    && isWellFormedOwnerGrantRow(grant)
    && Array.isArray(ownerKeys) && ownerKeys.length > 0 && ownerKeys.every((key) => isEd25519KeyB64(key))
    && Array.isArray(members) && members.length <= MAX_BUNDLE_MEMBERS && members.every((addr) => isBoundedString(addr));
}

/** Is `value` an {@link OwnerGrantRow} with every column in its stored form and bounded? */
export function isWellFormedOwnerGrantRow(value: unknown): value is OwnerGrantRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return isEd25519KeyB64(row.key)
    && isNullableBoundedString(row.label, OWNER_KEY_MAX_LABEL)
    && isNullableBoundedString(row.expiresAt)
    && isNullableUseCap(row.totalUses)
    && isBoundedString(row.stampId)
    && isEd25519KeyB64(row.issuerKey)
    && isBoundedString(row.issuerSig);
}

// ── Wire messages ────────────────────────────────────────────────────────────

/** Holder → member: one frame, the whole redemption. */
export interface OwnerGrantRedeemRequest {
  v: 1;
  /** The cadre the holder believes it is becoming an owner of; a machine serving another party refuses by name. */
  partyId: string;
  /** The owner-signed row from the bundle. */
  grant: OwnerGrantRow;
  /** The ed25519 public key to seat as an owner, base64url: the holder's, fresh or already held. */
  ownerKey: string;
  /** Single-use nonce the holder minted (`generateStampId`); both signatures cover it. */
  usageStampId: string;
  /** By `grantPrivateKey` over the `'redeem'` digest. */
  grantSig: string;
  /** By `ownerKey` over the `'consent'` digest. */
  ownerSig: string;
}

/**
 * Why a member refused a redemption: the invitation's codes with grant wording. Retryability
 * is {@link OWNER_GRANT_REJECTION_RETRYABLE}'s; a retryable code moves the holder to the next
 * address the bundle names.
 */
export type OwnerGrantRejectionCode =
  /** The issuer's `OwnerKey` row is not on this member (not replicated yet), or the issuer was removed; the member cannot tell which. */
  | 'issuer-unknown'
  /** A signature does not verify, or the request or the row is malformed. */
  | 'grant-invalid'
  /** Expired, withdrawn, exhausted, or issued by a key that is no longer an owner here. */
  | 'grant-spent'
  /** This machine serves another cadre than the one the grant names. */
  | 'party-mismatch'
  /** The member is at its cap on concurrent redemptions. */
  | 'busy'
  /** The write failed transiently (the write retry gave up), or the member has not synced the grant row the cadre holds; nothing was recorded. */
  | 'conflict'
  /** An unexpected member-side failure, or a request frame the member could not read: nothing was proved either way. */
  | 'internal';

/** Which refusals are worth repeating at the next address — the one place that says so. */
export const OWNER_GRANT_REJECTION_RETRYABLE: Readonly<Record<OwnerGrantRejectionCode, boolean>> = {
  'issuer-unknown': true,
  'grant-invalid': false,
  'grant-spent': false,
  'party-mismatch': false,
  'busy': true,
  'conflict': true,
  'internal': true
};

/** Is `value` a code this build knows? Own keys only, so a peer's `'constructor'` does not pass. */
export function isOwnerGrantRejectionCode(value: unknown): value is OwnerGrantRejectionCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OWNER_GRANT_REJECTION_RETRYABLE, value);
}

/** Member → holder. No dial hints: the holder is not joining the cadre's network, only seating a key. */
export interface OwnerGrantRedeemReply {
  accepted: boolean;
  /** Present iff `!accepted`. */
  code?: OwnerGrantRejectionCode;
  /** Human-facing text; present iff `!accepted`. */
  reason?: string;
  /** The member's party id; present iff `accepted`. */
  partyId?: string;
  /** The grant row as this member holds it; present iff `accepted`. */
  grant?: OwnerGrantRow;
  /** The key was already a live owner here, so nothing was written and no use was spent; present iff `accepted`. */
  alreadyOwner?: boolean;
}

/** An accepting reply, every optional field present. */
export interface OwnerGrantAccepted extends OwnerGrantRedeemReply {
  accepted: true;
  partyId: string;
  grant: OwnerGrantRow;
  alreadyOwner: boolean;
}

type OwnerGrantRejection = RedemptionRejection<OwnerGrantRejectionCode>;

// ── Errors the holder sees ───────────────────────────────────────────────────

/**
 * A member answered and refused (on `CadreNode.redeemOwnerGrant`'s local path, the member is
 * this node). `code` is `'unrecognized'` when the frame carried none this build knows, and such
 * a refusal counts as retryable, as the invitation's does.
 */
export class OwnerGrantRejectedError extends Error {
  readonly code: OwnerGrantRejectionCode | 'unrecognized';
  readonly reason: string;
  readonly retryable: boolean;

  /** Both arguments come straight off the wire, so neither is trusted to have its declared type. */
  constructor(code: unknown, reason: unknown) {
    const text = typeof reason === 'string' ? reason : 'no reason provided';
    super(`Owner grant refused: ${text}`);
    this.name = 'OwnerGrantRejectedError';
    this.code = isOwnerGrantRejectionCode(code) ? code : 'unrecognized';
    this.reason = text;
    this.retryable = this.code === 'unrecognized' || OWNER_GRANT_REJECTION_RETRYABLE[this.code];
  }
}

/** Every address the bundle names was tried and none accepted. Always retryable; `outcomes` says what each address did. */
export class OwnerGrantUnreachableError extends Error {
  readonly retryable = true;

  constructor(readonly outcomes: readonly RedemptionAddressOutcome[]) {
    super(outcomes.length === 0
      ? 'Owner grant names no dialable member'
      : `Owner grant could not be redeemed at any of its ${outcomes.length} address(es): `
        + outcomes.map((outcome) => `${outcome.addr}: ${outcome.error.message}`).join('; '));
    this.name = 'OwnerGrantUnreachableError';
  }
}

/**
 * A member accepted but its reply does not check out: another party id, another grant key, or
 * a row not signed by one of the pinned owner keys. Final, for the invitation's reason: such a
 * machine is not a member of the cadre the grant names.
 */
export class OwnerGrantReplyInvalidError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(`Owner grant reply refused: ${message}`);
    this.name = 'OwnerGrantReplyInvalidError';
  }
}

// ── Shape checks ─────────────────────────────────────────────────────────────

function isWellFormedRedeemRequest(value: unknown): value is OwnerGrantRedeemRequest {
  if (typeof value !== 'object' || value === null) return false;
  const { v, partyId, grant, ownerKey, usageStampId, grantSig, ownerSig } = value as Record<string, unknown>;
  return v === 1
    && isBoundedString(partyId)
    && isWellFormedOwnerGrantRow(grant)
    && isEd25519KeyB64(ownerKey)
    && isBoundedString(usageStampId)
    && isBoundedString(grantSig)
    && isBoundedString(ownerSig);
}

/** An acceptance frame's fields. Throws on a malformed one. */
function decodeAccepted(reply: Record<string, unknown>): OwnerGrantAccepted {
  if (!isBoundedString(reply.partyId) || !isWellFormedOwnerGrantRow(reply.grant)) {
    throw new Error('Owner grant acceptance is missing its party id or a well-formed row');
  }
  return { accepted: true, partyId: reply.partyId, grant: reply.grant, alreadyOwner: reply.alreadyOwner === true };
}

// ── Request construction (holder side) ───────────────────────────────────────

/**
 * Build and sign the request for `bundle`: the holder's `'redeem'` signature with the grant's
 * private key (held in memory for the length of this call) and the seated key's `'consent'`
 * signature through `signConsent`, the `sign` of an open owner approval on the signer that
 * holds `ownerKey`; both over (grant key, `usageStampId`, `ownerKey`) for the grant's party. The
 * same bytes the schema verifies at the member (`ownerGrantRedeemMessage` /
 * `ownerGrantConsentMessage`), and the same request goes to every member and every pass.
 */
export async function signOwnerGrantRequest(
  bundle: OwnerGrantBundle,
  ownerKey: string,
  signConsent: OwnerSign,
  usageStampId: string
): Promise<OwnerGrantRedeemRequest> {
  const fields = { grantKey: bundle.grant.key, usageStampId, seatedKey: ownerKey };
  const grantSig = sign(ownerGrantRedeemMessage(bundle.partyId, fields), bundle.grantPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
  const ownerSig = await signConsent(ownerGrantConsentMessage(bundle.partyId, fields));
  return { v: 1, partyId: bundle.partyId, grant: bundle.grant, ownerKey, usageStampId, grantSig, ownerSig };
}

/**
 * The holder's check on an acceptance: the same party, the same grant key, and a row signed by
 * an issuer the holder pinned from the bundle. Throws {@link OwnerGrantReplyInvalidError} naming
 * the first failure. Bounded as `verifyRedeemReply` is: it catches a wrong-party or wrong-row
 * answer, not a forged member, which the holder's anchor settles once its store syncs.
 */
export function verifyOwnerGrantReply(
  reply: OwnerGrantAccepted,
  bundle: OwnerGrantBundle,
  isTrustedIssuer: (ownerKey: string) => boolean
): void {
  if (reply.partyId !== bundle.partyId) {
    throw new OwnerGrantReplyInvalidError(`the member serves party ${reply.partyId}, the grant names ${bundle.partyId}`);
  }
  if (reply.grant.key !== bundle.grant.key) {
    throw new OwnerGrantReplyInvalidError('the member answered for a different grant');
  }
  if (!isTrustedIssuer(reply.grant.issuerKey)) {
    throw new OwnerGrantReplyInvalidError('the row the member holds is not issued by one of the grant\'s owner keys');
  }
  if (!verifyOwnerGrantRow(bundle.partyId, reply.grant)) {
    throw new OwnerGrantReplyInvalidError('the row the member holds is not signed by its issuer');
  }
}

// ── Member side (handler) ────────────────────────────────────────────────────

/** The control-database surface a redemption needs; a `ControlDatabase` satisfies it. */
export type OwnerGrantStore = Pick<ControlDatabase, 'seatOwnerGrant' | 'isOwnerGrantLive' | 'redeemOwnerGrant'>;

export interface OwnerGrantHandlerOptions extends MemberRedemptionHandlerOptions {
  store: OwnerGrantStore;
}

/** Constraint names the schema refuses a redemption with, and the code each maps to. */
const REDEEM_CONSTRAINT_CODES: ReadonlyArray<ConstraintRefusalRow<OwnerGrantRejectionCode>> = [
  [/CHECK constraint failed: Authorized\b/, 'grant-spent', 'The grant is expired, withdrawn, exhausted, or its issuer is no longer an owner'],
  [/CHECK constraint failed: (GrantPossessed|OwnerConsented|SeatedExists)\b/, 'grant-invalid', 'The redemption does not satisfy the grant'],
  [/CHECK constraint failed: NotRevoked\b/, 'grant-spent', 'The grant was withdrawn'],
];

/**
 * Member side of the grant protocol (`MemberRedemptionHandler` has the shape): after the
 * request's shape, it checks the party and both signatures — nothing about the connecting
 * peer, whose identity is unrelated to the key it seats — then seats the row from the bundle
 * and redeems. An issuer this member does not know as an owner is the one retryable refusal
 * left: the holder tries the next address, which may hold the issuer's row.
 */
export class OwnerGrantHandler extends MemberRedemptionHandler<OwnerGrantRedeemRequest, OwnerGrantRedeemReply> {
  private readonly store: OwnerGrantStore;
  protected readonly busyRefusal = rejection('busy', 'Too many concurrent redemptions');
  protected readonly internalRefusal = rejection('internal', 'Internal redemption error');
  protected readonly malformedRefusal = rejection('grant-invalid', 'Malformed redemption request');

  constructor(options: OwnerGrantHandlerOptions) {
    super('Owner grant', OWNER_GRANT_PROTOCOL, options);
    this.store = options.store;
  }

  protected isWellFormedRequest(value: unknown): value is OwnerGrantRedeemRequest {
    return isWellFormedRedeemRequest(value);
  }

  protected checkRequest(request: OwnerGrantRedeemRequest): OwnerGrantRejection | null {
    if (request.partyId !== this.partyId) {
      return rejection('party-mismatch', 'This machine serves another cadre');
    }
    const fields = { grantKey: request.grant.key, usageStampId: request.usageStampId, seatedKey: request.ownerKey };
    if (!verifyOwnerGrantRedemption(this.partyId, fields, request.grantSig, request.ownerSig)) {
      return rejection('grant-invalid', 'The redemption signatures do not verify');
    }
    return null;
  }

  protected isLive(request: OwnerGrantRedeemRequest): Promise<boolean> {
    return this.store.isOwnerGrantLive(request.grant);
  }

  /** The two writes — the seat (its own transaction; a no-op when held) and the redemption — each answered by name when it fails. */
  protected async redeemAdmitted(request: OwnerGrantRedeemRequest, remotePeerId: string): Promise<OwnerGrantRedeemReply> {
    try {
      await this.store.seatOwnerGrant(request.grant);
    } catch (error) {
      if (error instanceof OwnerGrantIssuerUnknownError) {
        return rejection('issuer-unknown', 'The grant\'s issuer is not known as an owner here');
      }
      log('seating grant %s from %s failed: %o', request.grant.key, remotePeerId, error);
      return constraintRefusal(error, REDEEM_CONSTRAINT_CODES) ?? writeFailureRefusal(error);
    }
    let alreadyOwner: boolean;
    try {
      const result = await this.store.redeemOwnerGrant({
        grantKey: request.grant.key,
        seatedKey: request.ownerKey,
        usageStampId: request.usageStampId,
        grantSig: request.grantSig,
        ownerSig: request.ownerSig
      });
      alreadyOwner = result.alreadyOwner;
      log('grant %s redeemed for %s by %s (alreadyOwner=%s)', request.grant.key, request.ownerKey, remotePeerId, alreadyOwner);
    } catch (error) {
      if (error instanceof InvitationExhaustedError) {
        return rejection('grant-spent', 'The grant has no uses left');
      }
      log('redeeming grant %s for %s failed: %o', request.grant.key, request.ownerKey, error);
      return constraintRefusal(error, REDEEM_CONSTRAINT_CODES) ?? writeFailureRefusal(error);
    }
    // The row as held: the seat inserted this copy verbatim, or found the same row.
    return { accepted: true, partyId: this.partyId, grant: request.grant, alreadyOwner };
  }
}

// ── Holder side (dialer) ─────────────────────────────────────────────────────

export interface RedeemOwnerGrantAtMembersOptions {
  /** The bundle: its `members` are dialed in order. */
  bundle: OwnerGrantBundle;
  /** The signed request ({@link signOwnerGrantRequest}); the same one goes to every address. */
  request: OwnerGrantRedeemRequest;
  /** Is this owner key one the holder pinned from the bundle? The reply check's input. */
  isTrustedIssuer: (ownerKey: string) => boolean;
  /** See `MemberRedemptionOptions.linkRoundTripMs`. */
  linkRoundTripMs?: number;
  /** Per-address deadline override; default derived from `linkRoundTripMs`. */
  addressBudgetMs?: number;
  protocolId?: string;
  /** Cancels the dial or stream in flight and ends the pass; the call throws the signal's reason. */
  signal?: AbortSignal;
}

/** What a successful redemption yields the holder. */
export type OwnerGrantRedemption = MemberRedemption<OwnerGrantAccepted>;

/** The grant's half of the shared dial loop: its label, protocol, bundle, codec, checks and errors. */
function grantRedemption(options: RedeemOwnerGrantAtMembersOptions): MemberRedemptionOptions<OwnerGrantAccepted> {
  return {
    label: LABEL,
    protocolId: options.protocolId ?? OWNER_GRANT_PROTOCOL,
    members: options.bundle.members,
    request: options.request,
    decodeAccepted,
    refusal: (code, reason) => new OwnerGrantRejectedError(code, reason),
    verifyAccepted: (reply) => verifyOwnerGrantReply(reply, options.bundle, options.isTrustedIssuer),
    unreachable: (outcomes) => new OwnerGrantUnreachableError(outcomes),
    ...(options.linkRoundTripMs !== undefined ? { linkRoundTripMs: options.linkRoundTripMs } : {}),
    ...(options.addressBudgetMs !== undefined ? { addressBudgetMs: options.addressBudgetMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * Holder side: try the bundle's addresses one at a time and stop at the first acceptance or
 * the first final refusal (`dialRedemption` in `member-redemption.ts`). Every address gets the
 * SAME request, with one `usageStampId`: `OwnerGrantUsage` is keyed by it, so a member the
 * holder gave up on that was still committing cannot spend a second use, and a retry after a
 * dropped reply is answered `alreadyOwner`.
 *
 * @throws {OwnerGrantRejectedError} on a final refusal (its `retryable` is false).
 * @throws {OwnerGrantReplyInvalidError} on an acceptance that fails {@link verifyOwnerGrantReply}.
 * @throws {OwnerGrantUnreachableError} when every address was tried and none accepted.
 * @throws the reason of `options.signal` once it aborts.
 */
export function redeemOwnerGrantAtMembers(node: Libp2p, options: RedeemOwnerGrantAtMembersOptions): Promise<OwnerGrantRedemption> {
  return dialRedemption(node, grantRedemption(options));
}

export interface RedeemOwnerGrantInPassesOptions extends RedeemOwnerGrantAtMembersOptions {
  /** Keep making passes while every answer is retryable; false makes exactly one. */
  waitForMember: boolean;
  /** Called at each pass and each pause; an exception it throws is logged and ignored. */
  onProgress?: (progress: CadreJoinProgress) => void;
}

/**
 * Holder side, in passes (`dialRedemptionInPasses` in `member-redemption.ts`): one
 * {@link redeemOwnerGrantAtMembers} pass, or, with `waitForMember`, as many as it takes,
 * pausing between them and never past the grant's expiry, which by this holder's clock is
 * thrown as the `grant-spent` refusal a member would give. A backup grant has no expiry, so a
 * wait on one ends only by acceptance, a final refusal, the signal or the node stopping.
 */
export function redeemOwnerGrantInPasses(node: Libp2p, options: RedeemOwnerGrantInPassesOptions): Promise<OwnerGrantRedemption> {
  const passes: MemberRedemptionPassOptions<OwnerGrantAccepted> = {
    ...grantRedemption(options),
    waitForMember: options.waitForMember,
    expiresAt: options.bundle.grant.expiresAt,
    expired: () => new OwnerGrantRejectedError('grant-spent', 'the grant expired before a member accepted it'),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  return dialRedemptionInPasses(node, passes);
}
