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
 * The exchange shape — one frame each way, the member's hardening and admission of the
 * device, the device's address-by-address dialing in passes — is `member-redemption.ts`'s,
 * shared with the owner-grant protocol; this module supplies the invitation's bundle, request,
 * checks, writes and refusal codes. Stranger-facing by design — the device is not a member
 * when it dials — so the connection gate admits a stranger while a live invitation exists
 * (`membership-connection-gater.ts`), and the handler's own trust decision is the proof of
 * possession: nothing touches the database for a caller that cannot prove it holds the
 * invitation and is the identity it names.
 *
 * The seed protocol is left untouched so `SeedMessage` can grow independently.
 */

import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';
import type { Libp2p } from '@libp2p/interface';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { sign } from '@optimystic/quereus-plugin-crypto';
import {
  cadreInviteRedeemMessage,
  cadreInviteConsentMessage,
  CadreInviteIssuerUnknownError,
  InvitationExhaustedError,
  type ControlDatabase
} from './control-database.js';
import { verifyCadreInviteRow, verifyCadreInviteRedemption } from './peer-authorization.js';
import { ed25519PublicKeyB64FromPeerId } from './ed25519-key.js';
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
import type { CadreInviteRow, CadreJoinProgress, SeedPeer } from './types.js';

const log = debug('sereus:cadre:invite-proto');

/** Protocol id for cadre invitation redemption (parallel to `/sereus/seed/1.0.0`). */
export const CADRE_INVITE_PROTOCOL = '/sereus/cadre-invite/1.0.0';

/** What the dialer calls the credential in log lines, deadline labels and error text. */
const LABEL = 'Cadre invitation';

/** Most addresses a request may carry for the device, and a reply per peer (`sanitizeAddrs`). */
const MAX_ADDRS = 16;

/** Most machines an invitation bundle may name; the issuer caps its own list far below this. */
const MAX_BUNDLE_MEMBERS = 64;

/** Most peers a reply may carry as dial hints. */
const MAX_REPLY_PEERS = 256;

// ── The invitation bundle ────────────────────────────────────────────────────

/**
 * What an owner hands out (QR, paste, link) and a device redeems. An invitation is an
 * ed25519 keypair: the row holds the public half, `invitePrivateKey` is the proof of
 * possession, and whoever holds this bundle can redeem it — treat it as a bearer
 * credential for the row's lifetime. It admits a machine and grants nothing else; an owner
 * grant (`owner-grant-protocol.ts`) is the credential that makes a key an owner.
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
   * Multiaddrs ending in `/p2p/<peerId>`: the issuer's own first, then other members', at
   * most `CADRE_INVITATION_MAX_ADDRS` in all (`selectCadreInvitationMembers` in
   * `invitation-bootstrap.ts`). The device tries them in order.
   */
  members: string[];
}

/**
 * Encode a bundle for out-of-band delivery: {@link CADRE_INVITATION_PREFIX}, then base64url
 * over JSON. The prefix lets an app tell an invitation from a join request
 * (`cadre-join-request.ts`) or an owner grant (`owner-grant-protocol.ts`) and name the mistake
 * when one is pasted for the other.
 */
export function encodeCadreInvitation(invitation: CadreInvitation): string {
  return `${CADRE_INVITATION_PREFIX}${uint8ArrayToString(new TextEncoder().encode(JSON.stringify(invitation)), 'base64url')}`;
}

/**
 * Decode a bundle, refusing anything that is not a well-formed version-1
 * {@link CadreInvitation} behind {@link CADRE_INVITATION_PREFIX}. Standalone so a client
 * without a node (a settings screen that wants to show which cadre an invitation joins) can
 * decode one.
 *
 * @throws on an owner key, an owner grant or a join request, a string without the prefix or
 *   that is not base64url JSON after it, or one that decodes to another shape or version.
 */
export function decodeCadreInvitation(encoded: string): CadreInvitation {
  const trimmed = encoded.trim();
  if (trimmed.startsWith(OWNER_KEY_EXPORT_STEM)) {
    throw new Error('This is an owner key, not a cadre invitation; it is private, so import it only where the app asks for an owner key');
  }
  if (trimmed.startsWith(OWNER_GRANT_PREFIX)) {
    throw new Error('This is an owner grant, not a cadre invitation; paste it where the app asks for an owner grant');
  }
  if (trimmed.startsWith(CADRE_JOIN_REQUEST_PREFIX)) {
    throw new Error('This is a join request, not a cadre invitation; paste it into the app that manages your cadre');
  }
  if (!trimmed.startsWith(CADRE_INVITATION_PREFIX)) {
    throw new Error(`Cadre invitation must start with "${CADRE_INVITATION_PREFIX}" (this one starts with "${trimmed.slice(0, CADRE_INVITATION_PREFIX.length)}")`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(uint8ArrayFromString(trimmed.slice(CADRE_INVITATION_PREFIX.length), 'base64url')));
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
   * `CadrePeer` rows (`ControlDatabase.querySeedPeers`), the answering member and every
   * always-on machine marked `preferred`. The device derives trust from its anchor, never
   * from this.
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
type CadreInviteRejection = RedemptionRejection<CadreInviteRejectionCode>;

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

/** What one address the bundle named came to; the owner-grant redemption reports the same shape. */
export type CadreInviteAddressOutcome = RedemptionAddressOutcome;

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

/** Is `value` a {@link CadreInviteRow} with every column in its stored form and bounded? */
export function isWellFormedCadreInviteRow(value: unknown): value is CadreInviteRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return isEd25519KeyB64(row.key)
    && isNullableBoundedString(row.peerId)
    && isNullableBoundedString(row.expiresAt)
    && isNullableUseCap(row.totalUses)
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
    const { peerId, multiaddrs, preferred } = entry as Record<string, unknown>;
    if (!isBoundedString(peerId)) continue;
    out.push({ peerId, multiaddrs: sanitizeAddrs(multiaddrs), preferred: preferred === true });
  }
  return out;
}

/** An acceptance frame's fields, the attacker-influenced ones sanitized. Throws on a malformed one. */
function decodeAccepted(reply: Record<string, unknown>): CadreInviteAccepted {
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
 * (invitation key, `usageStampId`, device key) for the invitation's party. The same bytes
 * the schema verifies at the member (`cadreInviteRedeemMessage` / `cadreInviteConsentMessage`),
 * whose own `party_id()` must therefore be the party the bundle names.
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
    inviteSig: signB64(cadreInviteRedeemMessage(invitation.partyId, fields), invitation.invitePrivateKey),
    peerSig: signB64(cadreInviteConsentMessage(invitation.partyId, fields), signer.peerPrivateKey)
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
  if (!verifyCadreInviteRow(invitation.partyId, reply.invite)) {
    throw new CadreInviteReplyInvalidError('the row the member holds is not signed by its issuer');
  }
}

// ── Member side (handler) ────────────────────────────────────────────────────

/** The control-database surface a redemption needs; a `ControlDatabase` satisfies it. */
export type CadreInviteStore = Pick<ControlDatabase, 'seatCadreInvite' | 'isCadreInviteLive' | 'redeemCadreInvite' | 'querySeedPeers'>;

export interface CadreInviteHandlerOptions extends MemberRedemptionHandlerOptions {
  /** This member's peer id: the reply's peer list marks it preferred, since the device just reached it. */
  peerId: string;
  store: CadreInviteStore;
}

/** Constraint names the schema refuses a redemption with, and the code each maps to. */
const REDEEM_CONSTRAINT_CODES: ReadonlyArray<ConstraintRefusalRow<CadreInviteRejectionCode>> = [
  [/CHECK constraint failed: Authorized\b/, 'invite-spent', 'The invitation is expired, withdrawn, exhausted, or its issuer is no longer an owner'],
  [/CHECK constraint failed: (InvitePossessed|PeerConsented|PeerExists)\b/, 'invite-invalid', 'The redemption does not satisfy the invitation'],
  [/CHECK constraint failed: NotRevoked\b/, 'invite-spent', 'The invitation was withdrawn'],
];

/**
 * Member side of the invitation protocol (`MemberRedemptionHandler` has the shape): after the
 * request's shape, it checks the party, the connecting identity (an ed25519 peer id is an
 * identity multihash of the very key, and this is the only layer that can check the pair),
 * both signatures and a targeted invitation's device, then seats the row from the bundle and
 * redeems. An issuer this member does not know as an owner is the one retryable refusal left:
 * the device tries the next address, which may hold the issuer's row.
 */
export class CadreInviteHandler extends MemberRedemptionHandler<CadreInviteRedeemRequest, CadreInviteRedeemReply> {
  private readonly peerId: string;
  private readonly store: CadreInviteStore;
  protected readonly busyRefusal = rejection('busy', 'Too many concurrent redemptions');
  protected readonly internalRefusal = rejection('internal', 'Internal redemption error');
  protected readonly malformedRefusal = rejection('invite-invalid', 'Malformed redemption request');

  constructor(options: CadreInviteHandlerOptions) {
    super('Cadre invite', CADRE_INVITE_PROTOCOL, options);
    this.peerId = options.peerId;
    this.store = options.store;
  }

  protected isWellFormedRequest(value: unknown): value is CadreInviteRedeemRequest {
    return isWellFormedRedeemRequest(value);
  }

  protected checkRequest(request: CadreInviteRedeemRequest, remotePeerId: string): CadreInviteRejection | null {
    if (request.partyId !== this.partyId) {
      return rejection('party-mismatch', 'This machine serves another cadre');
    }
    if (ed25519PublicKeyB64FromPeerId(remotePeerId) !== request.peerKey) {
      return rejection('invite-invalid', 'The peer key is not the connecting identity');
    }
    const fields = { inviteKey: request.invite.key, usageStampId: request.usageStampId, peerKey: request.peerKey };
    if (!verifyCadreInviteRedemption(this.partyId, fields, request.inviteSig, request.peerSig)) {
      return rejection('invite-invalid', 'The redemption signatures do not verify');
    }
    if (request.invite.peerId !== null && request.invite.peerId !== remotePeerId) {
      return rejection('invite-invalid', 'The invitation names another device');
    }
    return null;
  }

  protected isLive(request: CadreInviteRedeemRequest): Promise<boolean> {
    return this.store.isCadreInviteLive(request.invite);
  }

  /** The two writes — the seat (its own transaction; a no-op when held) and the redemption — each answered by name when it fails. */
  protected async redeemAdmitted(request: CadreInviteRedeemRequest, remotePeerId: string): Promise<CadreInviteRedeemReply> {
    try {
      await this.store.seatCadreInvite(request.invite);
    } catch (error) {
      if (error instanceof CadreInviteIssuerUnknownError) {
        return rejection('issuer-unknown', 'The invitation\'s issuer is not known as an owner here');
      }
      log('seating invitation %s from %s failed: %o', request.invite.key, remotePeerId, error);
      return constraintRefusal(error, REDEEM_CONSTRAINT_CODES) ?? writeFailureRefusal(error);
    }
    try {
      const result = await this.store.redeemCadreInvite({
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
      return constraintRefusal(error, REDEEM_CONSTRAINT_CODES) ?? writeFailureRefusal(error);
    }
    // The row as held: the seat inserted this copy verbatim, or found the same row (its key
    // is the primary key and every column is under the issuer's signature).
    return { accepted: true, partyId: this.partyId, invite: request.invite, peers: await this.peersBestEffort() };
  }

  /** Dial hints are an optimization; a failed read costs the device its hints, not its membership. */
  private async peersBestEffort(): Promise<SeedPeer[]> {
    try {
      return await this.store.querySeedPeers(this.peerId);
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
  /** See `MemberRedemptionOptions.linkRoundTripMs`. */
  linkRoundTripMs?: number;
  /** Per-address deadline override; default derived from `linkRoundTripMs`. */
  addressBudgetMs?: number;
  protocolId?: string;
  /** Cancels the dial or stream in flight and ends the pass; the call throws the signal's reason. */
  signal?: AbortSignal;
}

/** What a successful redemption yields the device. */
export type CadreInviteRedemption = MemberRedemption<CadreInviteAccepted>;

/** The invitation's half of the shared dial loop: its label, protocol, bundle, codec, checks and errors. */
function inviteRedemption(options: RedeemAtMembersOptions): MemberRedemptionOptions<CadreInviteAccepted> {
  return {
    label: LABEL,
    protocolId: options.protocolId ?? CADRE_INVITE_PROTOCOL,
    members: options.invitation.members,
    request: options.request,
    decodeAccepted,
    refusal: (code, reason) => new CadreInviteRejectedError(code, reason),
    verifyAccepted: (reply) => verifyRedeemReply(reply, options.invitation, options.isTrustedIssuer),
    unreachable: (outcomes) => new CadreInviteUnreachableError(outcomes),
    ...(options.linkRoundTripMs !== undefined ? { linkRoundTripMs: options.linkRoundTripMs } : {}),
    ...(options.addressBudgetMs !== undefined ? { addressBudgetMs: options.addressBudgetMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * Device side: try the bundle's addresses one at a time, each under its own deadline, and
 * stop at the first acceptance or the first final refusal (`dialRedemption` in
 * `member-redemption.ts`). Every address gets the SAME request, with one `usageStampId`:
 * `CadreInviteUsage` is keyed by it, so a member the device gave up on that was still
 * committing cannot admit it twice, and a retry at the next member after a dropped reply is
 * answered as already a member.
 *
 * @throws {CadreInviteRejectedError} on a final refusal (its `retryable` is false).
 * @throws {CadreInviteReplyInvalidError} on an acceptance that fails {@link verifyRedeemReply}.
 * @throws {CadreInviteUnreachableError} when every address was tried and none accepted.
 * @throws the reason of `options.signal` once it aborts.
 */
export function redeemAtMembers(node: Libp2p, options: RedeemAtMembersOptions): Promise<CadreInviteRedemption> {
  return dialRedemption(node, inviteRedemption(options));
}

export interface RedeemInPassesOptions extends RedeemAtMembersOptions {
  /** Keep making passes while every answer is retryable; false makes exactly one. */
  waitForMember: boolean;
  /** Called at each pass and each pause; an exception it throws is logged and ignored. */
  onProgress?: (progress: CadreJoinProgress) => void;
}

/**
 * Device side, in passes (`dialRedemptionInPasses` in `member-redemption.ts`): one
 * {@link redeemAtMembers} pass, or, with `waitForMember`, as many as it takes, pausing between
 * them and never past the invitation's expiry, which by this device's clock is thrown as the
 * `invite-spent` refusal a member would give.
 */
export function redeemInPasses(node: Libp2p, options: RedeemInPassesOptions): Promise<CadreInviteRedemption> {
  const passes: MemberRedemptionPassOptions<CadreInviteAccepted> = {
    ...inviteRedemption(options),
    waitForMember: options.waitForMember,
    expiresAt: options.invitation.invite.expiresAt,
    expired: () => new CadreInviteRejectedError('invite-spent', 'the invitation expired before a member accepted it'),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
  return dialRedemptionInPasses(node, passes);
}
