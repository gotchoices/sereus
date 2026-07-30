import debug from 'debug';
import { digest, verify } from '@optimystic/quereus-plugin-crypto';
import { controlAuthorizationFields } from './control-authorization.js';
import type { ControlAction, ControlDomain, RevocableTable } from './control-authorization.js';

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
 * of the voucher {@link SeedBootstrapService.insertCadrePeerRow} signs and
 * persists into `VouchOwner`/`VouchSig` (see {@link cadrePeerVoucherDigest}).
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
