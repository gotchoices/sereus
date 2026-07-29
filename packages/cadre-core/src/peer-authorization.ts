import debug from 'debug';
import { digest, verify } from '@optimystic/quereus-plugin-crypto';
import { controlAuthorizationFields } from './control-authorization.js';
import type { ControlAction, ControlDomain } from './control-authorization.js';

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
 * Canonical digest an owner signs to authorize a `DeviceToken` INSERT. SQL mirror:
 * `digest('CadreControl.DeviceToken', 'add', new.PeerId)` in `DeviceToken.AuthorizedInsert`.
 * Distinct from {@link deviceTokenRemoveDigest} so a captured insert approval can never
 * be replayed to delete the token, and vice versa.
 */
export function deviceTokenAddDigest(peerId: string): string {
  return taggedDigest('CadreControl.DeviceToken', 'add', [peerId]);
}

/**
 * Canonical digest an owner signs to authorize a `DeviceToken` DELETE. SQL mirror:
 * `digest('CadreControl.DeviceToken', 'remove', old.PeerId)` in `DeviceToken.AuthorizedDelete`.
 */
export function deviceTokenRemoveDigest(peerId: string): string {
  return taggedDigest('CadreControl.DeviceToken', 'remove', [peerId]);
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
