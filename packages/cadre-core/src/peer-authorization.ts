import debug from 'debug';
import { digest, verify } from '@optimystic/quereus-plugin-crypto';

const log = debug('sereus:cadre:peer-authorization');

/**
 * Canonical digest an owner signs to authorize a peer.
 *
 * This is the exact byte construction {@link SeedBootstrapService.authorizePeer}
 * signs over when it inserts an authorized `CadrePeer` row:
 * `digest([peerId], 'sha256', 'base64url')`. Factored into one place so the
 * producer (owner signing) and the verifier (the offline `cadre enroll
 * register` check) can never drift apart — change the digest here and both move
 * together. The SQL mirror is the bare single-field `digest(coalesce(new.PeerId, old.PeerId))`.
 */
export function peerAuthorizationDigest(peerId: string): string {
  return digest([peerId], 'sha256', 'base64url') as string;
}

/**
 * Canonical digest an owner signs to VOUCH a `CadrePeer` membership row (insert
 * and the owner re-touch update). Binds the peer id to the row's single-use
 * `StampId` nonce, so a captured signed insert cannot be replayed (the `StampId` is
 * unique) and — because {@link cadrePeerRemoveDigest} scopes a DIFFERENT payload — the
 * stored voucher (`VouchSig`) cannot be replayed to authorize a delete.
 *
 * The SQL mirror is `digest(new.PeerId, new.StampId)` (two TEXT fields), matching the
 * canonical multi-field framing in control-database.ts:buildAuthorizationMessage.
 */
export function cadrePeerVoucherDigest(peerId: string, stampId: string): string {
  return digest([peerId, stampId], 'sha256', 'base64url') as string;
}

/**
 * Canonical digest an owner signs to REMOVE a `CadrePeer` row. Deliberately a
 * distinct payload from {@link cadrePeerVoucherDigest} (adds the `'remove'` action
 * tag) so the row's stored voucher — a signature over the voucher digest — can never
 * satisfy this delete check. The signature is supplied in write context and never
 * stored, so no reader can replay it; binding the live row's `StampId` also invalidates
 * any captured remove after a delete+reinsert (the nonce rotates).
 *
 * SQL mirror: `digest(old.PeerId, old.StampId, 'remove')`.
 */
export function cadrePeerRemoveDigest(peerId: string, stampId: string): string {
  return digest([peerId, stampId, 'remove'], 'sha256', 'base64url') as string;
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
