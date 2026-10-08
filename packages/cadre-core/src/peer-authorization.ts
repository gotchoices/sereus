import debug from 'debug';
import { digest, verify } from '@optimystic/quereus-plugin-crypto';
import { controlAuthorizationFields, cadreInviteRowFields } from './control-authorization.js';
import type { CadreInviteSignedFields, ControlAction, ControlDomain, RevocableTable } from './control-authorization.js';
import { ed25519PublicKeyB64FromPeerId } from './ed25519-key.js';
import type { CadreInviteRow, CadreInviteUsageRow, CadrePeerVoucherFields, OwnerKeyRow, RevocationRow } from './types.js';

const log = debug('sereus:cadre:peer-authorization');

/**
 * base64url SHA-256 digest over the shared domain-tagged field vector (see
 * control-authorization.ts). The base64url twin of
 * control-database.ts:buildAuthorizationMessage (which returns the same digest as raw
 * bytes): sign either encoding with input encoding to match and the signed bytes agree.
 */
function taggedDigest(domain: ControlDomain, action: ControlAction, rowFields: string[]): string {
  return digest(controlAuthorizationFields(domain, action, rowFields), 'sha256', 'base64url') as string;
}

/**
 * Canonical digest an owner signs to vouch a peer's ENROLLMENT — the offline
 * credential `cadre enroll register` verifies. No table checks this digest, so it
 * carries its own `'Cadre.Enrollment'` domain tag to stay disjoint from every
 * CadreControl table rule (pre-tag it collided with the `DeviceToken` owner digests,
 * so an enrollment vouch doubled as a push-token delete approval).
 *
 * Factored into one place so the producer (owner signing) and the verifier (the
 * offline `cadre enroll register` check) can never drift apart — change the digest
 * here and both move together.
 */
export function peerAuthorizationDigest(peerId: string): string {
  return taggedDigest('Cadre.Enrollment', 'vouch', [peerId]);
}

/**
 * The `CadreControl.DeviceToken` columns {@link deviceTokenAddDigest} binds, in the
 * schema's order. A whole-row struct rather than six positional strings, so a caller
 * cannot silently transpose `platform` and `token` (both opaque strings) and mint a
 * signature over a row it did not mean to approve.
 *
 * Structurally satisfied by a `DeviceTokenRecord` spread with the row's `stampId`;
 * `types.ts:DeviceTokenRecord` deliberately does NOT carry the stamp — it is the
 * SELF-signed record shape, and the peer's own `Sig` does not cover `StampId`.
 * `updatedAt` / `sig` are nullable because the columns are: both sign as `''` when
 * absent, mirroring the schema's `coalesce(...)`.
 */
export interface DeviceTokenAuthorizedRow {
  peerId: string;
  platform: string;
  token: string;
  updatedAt: number | null;
  sig: string | null;
  stampId: string;
}

/**
 * Canonical digest an owner signs to authorize a `DeviceToken` INSERT — the WHOLE row,
 * ending in its single-use `StampId` nonce. SQL mirror:
 * `digest('CadreControl.DeviceToken', 'add', new.PeerId, new.Platform, new.Token,
 * coalesce(cast(new.UpdatedAt as text), ''), coalesce(new.Sig, ''), new.StampId)` in
 * `DeviceToken.AuthorizedInsert`.
 *
 * Binding every column means a captured approval can only ever reproduce the exact row
 * it approved — never one carrying attacker-chosen `Platform`/`Token`/`UpdatedAt` — and
 * binding the stamp makes it single-use: while the row lives the `unique` column blocks
 * a replay, and after a clear the stamp is retired permanently into
 * `CadreControl.Revocation` (`DeviceToken.NotRevoked`). This matters more here than for
 * `CadrePeer`: a resurrected push token has NO freshness ceiling to retire it
 * (`CadreNode.resolveDeviceToken` defaults `maxAgeMs` to infinity by design), so stamp
 * retirement is the only thing that sticks.
 *
 * Distinct from {@link deviceTokenRemoveDigest} so a captured insert approval can never
 * be replayed to delete the token, and vice versa.
 */
export function deviceTokenAddDigest(row: DeviceTokenAuthorizedRow): string {
  return taggedDigest('CadreControl.DeviceToken', 'add', [
    row.peerId,
    row.platform,
    row.token,
    row.updatedAt === null ? '' : String(row.updatedAt),
    row.sig ?? '',
    row.stampId,
  ]);
}

/**
 * Canonical digest an owner signs to authorize a `DeviceToken` DELETE, bound to the
 * STORED row's (PeerId, StampId). SQL mirror:
 * `digest('CadreControl.DeviceToken', 'remove', old.PeerId, old.StampId)` in
 * `DeviceToken.AuthorizedDelete`.
 *
 * A narrower vector than {@link deviceTokenAddDigest} on purpose (the same split
 * `CadrePeer` makes): the clear approval names only which row is being retired, so it
 * cannot be re-cut into an insert approval, and it is dead the moment the stamp it
 * names is tombstoned.
 */
export function deviceTokenRemoveDigest(peerId: string, stampId: string): string {
  return taggedDigest('CadreControl.DeviceToken', 'remove', [peerId, stampId]);
}

/**
 * Canonical digest an owner signs to VOUCH a `CadrePeer` membership row (insert
 * and the owner re-touch update — same semantics, deliberately the same digest).
 * Binds the peer id to the row's single-use `StampId` nonce, so a captured signed
 * insert cannot be replayed — while the row lives the `unique` column blocks it, and
 * after a removal the stamp is retired permanently into `CadreControl.Revocation`
 * (`CadrePeer.NotRevoked`) — and, because {@link cadrePeerRemoveDigest} scopes a
 * DIFFERENT payload, the stored voucher (`VouchSig`) cannot be replayed to authorize
 * a delete. The domain tag keeps the stored, replicated `VouchSig` useless against
 * every OTHER table's rules.
 *
 * SQL mirror: `digest('CadreControl.CadrePeer', 'vouch', new.PeerId, new.StampId)`.
 */
export function cadrePeerVoucherDigest(peerId: string, stampId: string): string {
  return taggedDigest('CadreControl.CadrePeer', 'vouch', [peerId, stampId]);
}

/**
 * Canonical digest an owner signs to REMOVE a `CadrePeer` row. Deliberately a
 * distinct payload from {@link cadrePeerVoucherDigest} (the `'remove'` action tag)
 * so the row's stored voucher — a signature over the voucher digest — can never
 * satisfy this delete check. The signature is supplied in write context and never
 * stored, so no reader can replay it; a captured remove is also dead after the
 * delete lands, because a re-added row carries a FRESH `StampId` (the removed row's
 * stamp is retired into `CadreControl.Revocation` and never reused).
 *
 * SQL mirror: `digest('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId)`.
 */
export function cadrePeerRemoveDigest(peerId: string, stampId: string): string {
  return taggedDigest('CadreControl.CadrePeer', 'remove', [peerId, stampId]);
}

/**
 * Canonical digest an owner signs to APPEND a `CadreControl.Revocation` tombstone —
 * the row retiring `stampId` for the named guarded table, and recording `rowKey`
 * (the removed row's primary key: OwnerKey.Key / ValidationKey.Key /
 * CadrePeer.PeerId / DeviceToken.PeerId / Strand.Id) as which row was retired.
 * SQL mirror:
 * `digest('CadreControl.Revocation', 'remove', new.TableName, new.RowKey, new.StampId)`
 * in `Revocation.Authorized`.
 *
 * Its own `'CadreControl.Revocation'` domain tag makes it disjoint from the
 * `'CadreControl.CadrePeer'` (or `OwnerKey` / `ValidationKey` / `Strand`)
 * `'remove'` digest the same owner signs in the SAME transaction for the delete
 * this tombstone accompanies — a removal signature is not a retirement
 * signature and cannot be replayed as one.
 */
export function revocationDigest(tableName: RevocableTable, rowKey: string, stampId: string): string {
  return taggedDigest('CadreControl.Revocation', 'remove', [tableName, rowKey, stampId]);
}

/**
 * Does a `Revocation` row's stored signer pair (`SignerKey` / `SignerSig`) verify over the
 * tombstone's own triple? The read-side mirror of `Revocation.Authorized`, for a node that
 * received the row by replication and must decide whether to honour it. Whether
 * `row.signerKey` is an owner this node trusts is the caller's question, as for
 * {@link verifyCadrePeerVoucher}. Never throws: a malformed row verifies as `false`.
 */
export function verifyRevocationSigner(row: RevocationRow): boolean {
  try {
    return verifyB64(revocationDigest(row.tableName, row.rowKey, row.stampId), row.signerSig, row.signerKey);
  } catch (error) {
    log('verifyRevocationSigner failed: %o', error);
    return false;
  }
}

/**
 * Canonical digest an owner signs to seat a further `OwnerKey` row — the signed-add branch
 * of `OwnerKey.Authorized`, which stores the pair as `VouchOwner` / `VouchSig`. SQL mirror:
 * `digest('CadreControl.OwnerKey', 'add', new.Key, new.StampId)`. The removal digest needs
 * no builder here: it is the generic guarded `'remove'` digest over (Key, StampId).
 */
export function ownerKeyAddDigest(key: string, stampId: string): string {
  return taggedDigest('CadreControl.OwnerKey', 'add', [key, stampId]);
}

/**
 * Does an owner-signed `OwnerKey` row's stored voucher verify — `vouchSig` by `vouchOwner`
 * over {@link ownerKeyAddDigest} for (`key`, `stampId`)? Whether `vouchOwner` is anchored
 * is the caller's question, as for {@link verifyCadrePeerVoucher}. Never throws.
 */
export function verifyOwnerKeyVoucher(key: string, stampId: string, vouchOwner: string, vouchSig: string): boolean {
  try {
    return verifyB64(ownerKeyAddDigest(key, stampId), vouchSig, vouchOwner);
  } catch (error) {
    log('verifyOwnerKeyVoucher failed: %o', error);
    return false;
  }
}

/**
 * Verify that `signature` is a valid owner ed25519 signature over `peerId`'s
 * authorization digest, using `ownerPublicKey` (base64url).
 *
 * This is the mirror of the signing done in
 * {@link SeedBootstrapService.authorizePeer}: it checks the signature against
 * {@link peerAuthorizationDigest}. A `true` result means the holder of the
 * owner private key vouched for this peer ID — it does NOT mean the peer is
 * registered anywhere.
 *
 * Returns a boolean and never throws: malformed base64url, a bad/garbage key, or
 * any crypto failure resolves to `false` (callers want a verdict, not an
 * exception). The catch is logged at debug.
 */
export function verifyPeerAuthorization(
  peerId: string,
  ownerPublicKey: string,
  signature: string
): boolean {
  try {
    return verify(
      peerAuthorizationDigest(peerId),
      signature,
      ownerPublicKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    );
  } catch (error) {
    log('verifyPeerAuthorization failed: %o', error);
    return false;
  }
}

/**
 * Verify that `signature` is a valid owner ed25519 signature over the
 * `CadrePeer` voucher digest for (`peerId`, `stampId`) — the read-side mirror
 * of the voucher {@link ControlDatabase.insertCadrePeer} signs and persists into
 * `VouchOwner`/`VouchSig` (see {@link cadrePeerVoucherDigest}).
 *
 * A `true` result means the holder of `ownerPublicKey` vouched THIS membership
 * row (the peer id bound to the row's single-use `StampId` nonce). It says
 * nothing about whether that owner key is itself trustworthy — the caller must
 * separately check the key against the node-local trusted-owner anchor
 * (`TrustedOwnerStore`), never the replicated `OwnerKey` table.
 *
 * Returns a boolean and never throws (same contract as
 * {@link verifyPeerAuthorization}): malformed input or any crypto failure
 * resolves to `false`, logged at debug.
 */
export function verifyCadrePeerVoucher(
  peerId: string,
  stampId: string,
  ownerPublicKey: string,
  signature: string
): boolean {
  try {
    return verify(
      cadrePeerVoucherDigest(peerId, stampId),
      signature,
      ownerPublicKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    );
  } catch (error) {
    log('verifyCadrePeerVoucher failed: %o', error);
    return false;
  }
}

/**
 * Canonical digest a JOINING peer signs to consent to ONE `FormationUsage`
 * redemption — the read-side mirror of `formationConsentMessage` in
 * control-database.ts, base64url-encoded instead of raw bytes (see
 * {@link taggedDigest}). That doc comment carries the field-vector rationale
 * (notably why `strandId` is not signed); the two vectors must not drift, which
 * peer-authorization.spec.ts pins by signing one form and verifying the other.
 */
export function formationConsentDigest(
  token: string, usageStampId: string, peerKey: string, disclosure: string
): string {
  return taggedDigest('CadreControl.FormationUsage', 'consent', [token, usageStampId, peerKey, disclosure]);
}

/**
 * Verify that `row.peerSig` is a valid ed25519 signature over the joining peer's
 * consent digest (see {@link formationConsentDigest}) — the row's OWN `peerKey`.
 *
 * Unlike {@link verifyCadrePeerVoucher} there is no separate enrolled/owner row to
 * look up: the identity IS the key carried on the row, so a forged consent would
 * need that joiner's own private key. Returns a boolean and never throws (same
 * contract as the siblings above): malformed input or any crypto failure resolves
 * to `false`, logged at debug.
 */
export function verifyFormationConsent(row: {
  token: string; usageStampId: string; peerKey: string; disclosure: string; peerSig: string;
}): boolean {
  try {
    return verify(
      formationConsentDigest(row.token, row.usageStampId, row.peerKey, row.disclosure),
      row.peerSig, row.peerKey, 'ed25519', 'base64url', 'base64url', 'base64url'
    );
  } catch (error) {
    log('verifyFormationConsent failed: %o', error);
    return false;
  }
}

/**
 * Canonical digest an owner signs to seat a `CadreInvite` row — the read-side mirror
 * of `cadreInviteAddMessage` in control-database.ts, base64url instead of raw bytes
 * (see {@link taggedDigest}). The whole row is bound, nullable columns as `''` and
 * `ExpiresAt` in its stored canonical form, through the one field builder both sides
 * share (`cadreInviteRowFields`). SQL mirror: `CadreInvite.AuthorizedInsert`.
 */
export function cadreInviteAddDigest(row: CadreInviteSignedFields): string {
  return taggedDigest('CadreControl.CadreInvite', 'add', cadreInviteRowFields(row));
}

/**
 * Canonical digest the HOLDER of a `CadreInvite`'s private key signs to redeem it once:
 * proof of possession, verified against the invitation key itself
 * (`CadreInviteUsage.InvitePossessed`). Binds the redemption's single-use nonce and the
 * device being admitted, so one redemption cannot be re-presented for another device
 * or another use. Mirror of `cadreInviteRedeemMessage` in control-database.ts.
 */
export function cadreInviteRedeemDigest(inviteKey: string, usageStampId: string, peerKey: string): string {
  return taggedDigest('CadreControl.CadreInviteUsage', 'redeem', [inviteKey, usageStampId, peerKey]);
}

/**
 * Canonical digest the DEVICE signs to consent to being admitted by one redemption
 * (`CadreInviteUsage.PeerConsented`), over the same fields as
 * {@link cadreInviteRedeemDigest} under a distinct action tag, so the holder's and
 * the device's signatures are never interchangeable. Mirror of
 * `cadreInviteConsentMessage` in control-database.ts.
 */
export function cadreInviteConsentDigest(inviteKey: string, usageStampId: string, peerKey: string): string {
  return taggedDigest('CadreControl.CadreInviteUsage', 'consent', [inviteKey, usageStampId, peerKey]);
}

/** ed25519 verify over a base64url digest, with the siblings' never-throws contract left to the caller. */
function verifyB64(digestB64: string, signature: string, publicKey: string): boolean {
  return verify(digestB64, signature, publicKey, 'ed25519', 'base64url', 'base64url', 'base64url');
}

/**
 * Does a `CadreInvite` row carry a valid `'add'` signature by its own `issuerKey`? The
 * redeeming device runs this over the row a member replies with, after checking the issuer
 * against its pinned owner keys, and a member over a bundle's copy it does not hold yet
 * (`ControlDatabase.isCadreInviteLive`); whether that issuer IS an owner is the caller's question.
 * Never throws: a malformed row verifies as `false`.
 */
export function verifyCadreInviteRow(invite: CadreInviteRow): boolean {
  try {
    return verifyB64(cadreInviteAddDigest(invite), invite.issuerSig, invite.issuerKey);
  } catch (error) {
    log('verifyCadreInviteRow failed: %o', error);
    return false;
  }
}

/**
 * The two signatures a redemption carries, checked before any database work: the holder's
 * `'redeem'` signature with the invitation key, and the device's `'consent'` signature with
 * its own key, both over (`inviteKey`, `usageStampId`, `peerKey`). The pre-check twin of
 * `CadreInviteUsage.InvitePossessed` / `PeerConsented`, as `verifyFormationConsent` is for
 * formation: the schema stays the authority, this turns a bad signature into a clean
 * refusal instead of a constraint failure at commit. Never throws.
 */
export function verifyCadreInviteRedemption(
  fields: { inviteKey: string; usageStampId: string; peerKey: string },
  inviteSig: string,
  peerSig: string,
): boolean {
  try {
    return verifyB64(cadreInviteRedeemDigest(fields.inviteKey, fields.usageStampId, fields.peerKey), inviteSig, fields.inviteKey)
      && verifyB64(cadreInviteConsentDigest(fields.inviteKey, fields.usageStampId, fields.peerKey), peerSig, fields.peerKey);
  } catch (error) {
    log('verifyCadreInviteRedemption failed: %o', error);
    return false;
  }
}

/**
 * The links of an invitation admission that do not depend on WHICH table's row was
 * admitted — shared by {@link verifyInvitationAdmission} (`CadrePeer`) and
 * {@link verifyInvitationOwnerAdmission} (`OwnerKey`), which differ only in the row
 * columns the usage must name and, for an owner row, in `grantsOwner`. The chain is
 *
 *   row --vouchUsage--> usage --inviteKey--> invitation --issuerKey--> anchored owner
 *
 * and every link here is verified: the issuer is anchored (`isAnchored`) and is the row's
 * `vouchOwner`; the usage names this invitation and is the row's `vouchUsage`; a targeted
 * invitation names the redeeming device; the stored `peerKey` really is the key behind the
 * usage's `peerId` (the schema cannot unwrap a multihash, so a writer could assert any
 * pair); the invitation's stored `'add'` signature verifies over the row rebuilt from its
 * columns; the holder's `'redeem'` signature verifies with the invitation key and the
 * device's `'consent'` signature with its own key. Throws on malformed input; the two
 * callers turn that into `false`.
 */
function verifyAdmissionChain(
  vouchOwner: string,
  vouchUsage: string,
  usage: CadreInviteUsageRow,
  invite: CadreInviteRow,
  isAnchored: (ownerKey: string) => boolean,
): boolean {
  return isAnchored(vouchOwner)
    && invite.issuerKey === vouchOwner
    && usage.usageStampId === vouchUsage
    && usage.inviteKey === invite.key
    && (invite.peerId === null || invite.peerId === usage.peerId)
    && ed25519PublicKeyB64FromPeerId(usage.peerId) === usage.peerKey
    && verifyB64(cadreInviteAddDigest(invite), invite.issuerSig, invite.issuerKey)
    && verifyB64(cadreInviteRedeemDigest(invite.key, usage.usageStampId, usage.peerKey), usage.inviteSig, invite.key)
    && verifyB64(cadreInviteConsentDigest(invite.key, usage.usageStampId, usage.peerKey), usage.peerSig, usage.peerKey);
}

/**
 * Is an invitation-admitted `CadrePeer` row (`vouchSig` null, `vouchUsage` set) a
 * member this node should trust? The read-side mirror of the consent branch of
 * `CadrePeer.AuthorizedInsert`, re-checked against THIS node's anchor because the
 * replicated `OwnerKey` table can be polluted. The usage must name this peer id and this
 * exact row incarnation (`peerStampId`); every other link is {@link verifyAdmissionChain}.
 *
 * Expiry, use count and withdrawal are deliberately NOT re-checked: they were conditions
 * at redemption (`CadreInviteUsage.Authorized`), and membership persists until an owner
 * removes the row — exactly as an owner-vouched row's membership does. Keeping a device
 * out is removing its row AND withdrawing the invitation.
 *
 * Returns a boolean and never throws (the siblings' contract): malformed input or any
 * crypto failure resolves to `false`, logged at debug.
 */
export function verifyInvitationAdmission(
  row: CadrePeerVoucherFields,
  usage: CadreInviteUsageRow,
  invite: CadreInviteRow,
  isAnchored: (ownerKey: string) => boolean,
): boolean {
  try {
    return row.stampId !== null
      && row.vouchOwner !== null
      && row.vouchUsage !== null
      && usage.peerStampId === row.stampId
      && usage.peerId === row.peerId
      && verifyAdmissionChain(row.vouchOwner, row.vouchUsage, usage, invite, isAnchored);
  } catch (error) {
    log('verifyInvitationAdmission failed: %o', error);
    return false;
  }
}

/**
 * Is an invitation-admitted `OwnerKey` row (`vouchSig` null, `vouchUsage` set) an owner
 * this node should derive into its anchor? The read-side mirror of the consent branch of
 * `OwnerKey.Authorized` (`owner-anchor-sync.ts` → `deriveOwnerAnchor`): the invitation
 * must grant ownership, and the usage must name this key (`peerKey`) and this exact row
 * incarnation (`ownerStampId`); every other link is {@link verifyAdmissionChain}. Same
 * never-throws contract and the same deliberate omissions as
 * {@link verifyInvitationAdmission}.
 */
export function verifyInvitationOwnerAdmission(
  row: OwnerKeyRow,
  usage: CadreInviteUsageRow,
  invite: CadreInviteRow,
  isAnchored: (ownerKey: string) => boolean,
): boolean {
  try {
    return row.vouchOwner !== null
      && row.vouchUsage !== null
      && invite.grantsOwner
      && usage.peerKey === row.key
      && usage.ownerStampId === row.stampId
      && verifyAdmissionChain(row.vouchOwner, row.vouchUsage, usage, invite, isAnchored);
  } catch (error) {
    log('verifyInvitationOwnerAdmission failed: %o', error);
    return false;
  }
}
