import { describe, it, expect, beforeEach } from 'vitest';
import { generatePrivateKey, getPublicKey, digest, sign } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import {
  peerAuthorizationDigest,
  verifyPeerAuthorization,
  formationConsentDigest,
  verifyFormationConsent
} from '../src/peer-authorization.js';
import { formationConsentMessage, formationVouchMessage } from '../src/control-database.js';
import { ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';

/**
 * Sign an enrollment vouch the way an owner tool does out-of-band (in-repo the
 * digest is only VERIFIED, by `cadre enroll register` → verifyPeerAuthorization).
 */
function ownerSign(peerId: string, ownerPrivateKey: string): string {
  return sign(
    peerAuthorizationDigest(peerId),
    ownerPrivateKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
}

describe('peerAuthorizationDigest', () => {
  it('is the domain-tagged sha256/base64url digest of the peer ID', () => {
    // Leads with the ('Cadre.Enrollment', 'vouch') tags so an enrollment vouch can
    // never satisfy any CadreControl table rule (pre-tag it collided with the
    // DeviceToken owner digests).
    const peerId = '12D3KooWTestPeer';
    expect(peerAuthorizationDigest(peerId)).toBe(
      digest(['Cadre.Enrollment', 'vouch', peerId], 'sha256', 'base64url') as string
    );
  });

  it('is deterministic and distinct for distinct peer IDs', () => {
    expect(peerAuthorizationDigest('peer-a')).toBe(peerAuthorizationDigest('peer-a'));
    expect(peerAuthorizationDigest('peer-a')).not.toBe(peerAuthorizationDigest('peer-b'));
  });
});

describe('verifyPeerAuthorization', () => {
  let ownerPrivateKey: string;
  let ownerPublicKey: string;
  let peerId: string;

  beforeEach(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const peerKey = await generateKeyPair('Ed25519');
    peerId = peerIdFromPrivateKey(peerKey).toString();
  });

  it('round-trips: a valid owner signature over the peer ID verifies true', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, signature)).toBe(true);
  });

  it('rejects a signature made for a different peer ID', async () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    const otherKey = await generateKeyPair('Ed25519');
    const otherPeerId = peerIdFromPrivateKey(otherKey).toString();
    expect(verifyPeerAuthorization(otherPeerId, ownerPublicKey, signature)).toBe(false);
  });

  it('rejects a signature verified against a different owner key', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    const wrongPrivate = generatePrivateKey('ed25519', 'base64url') as string;
    const wrongPublic = getPublicKey(wrongPrivate, 'ed25519', 'base64url', 'base64url') as string;
    expect(verifyPeerAuthorization(peerId, wrongPublic, signature)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    // Flip the leading character to a different valid base64url char.
    const tampered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, tampered)).toBe(false);
  });

  it('returns false (does not throw) on a malformed base64url signature', () => {
    expect(() =>
      expect(verifyPeerAuthorization(peerId, ownerPublicKey, 'not valid base64url!!! ***')).toBe(false)
    ).not.toThrow();
  });

  it('returns false (does not throw) on a garbage owner key', () => {
    const signature = ownerSign(peerId, ownerPrivateKey);
    expect(() =>
      expect(verifyPeerAuthorization(peerId, 'garbage-key-not-32-bytes', signature)).toBe(false)
    ).not.toThrow();
  });

  it('returns false on an empty signature without throwing', () => {
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, '')).toBe(false);
  });

  it('regression: an inline tagged construction verifies; the legacy untagged one does not', () => {
    // Reproduce the canonical construction (tagged digest then sign) WITHOUT going
    // through peerAuthorizationDigest. If the shared digest ever drifts from this
    // construction, this fails.
    const inlineDigest = digest(['Cadre.Enrollment', 'vouch', peerId], 'sha256', 'base64url') as string;
    const signature = sign(
      inlineDigest,
      ownerPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, signature)).toBe(true);

    // The pre-domain-separation construction — a bare digest(peerId) — must no
    // longer verify: that shape collided with the DeviceToken owner digests.
    const legacyDigest = digest([peerId], 'sha256', 'base64url') as string;
    const legacySig = sign(
      legacyDigest,
      ownerPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyPeerAuthorization(peerId, ownerPublicKey, legacySig)).toBe(false);
  });
});

describe('verifyFormationConsent', () => {
  /** The four signed fields of a consent row, before the signature is attached. */
  type ConsentFields = { token: string; usageStampId: string; peerKey: string; disclosure: string };

  let joinerPrivateKey: string;
  let row: ConsentFields;

  /** Sign the base64url digest form — what a joiner does via `formationConsentDigest`. */
  function signConsentDigest(fields: ConsentFields, privateKey: string): string {
    return sign(
      formationConsentDigest(fields.token, fields.usageStampId, fields.peerKey, fields.disclosure),
      privateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
  }

  beforeEach(() => {
    joinerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    row = {
      token: 'invite-token',
      usageStampId: 'stamp-1',
      peerKey: ed25519PublicKeyFromPrivate(joinerPrivateKey),
      disclosure: 'disclosure text'
    };
  });

  it('round-trips: the joiner signing over its own key verifies true', () => {
    const peerSig = signConsentDigest(row, joinerPrivateKey);
    expect(verifyFormationConsent({ ...row, peerSig })).toBe(true);
  });

  it('rejects a signature checked against a different peer key', () => {
    // The identity IS the key on the row, so swapping it is both "wrong key" and
    // "claiming to be someone else" — one check covers both.
    const peerSig = signConsentDigest(row, joinerPrivateKey);
    const otherPublicKey = ed25519PublicKeyFromPrivate(generatePrivateKey('ed25519', 'base64url') as string);
    expect(verifyFormationConsent({ ...row, peerKey: otherPublicKey, peerSig })).toBe(false);
  });

  it.each(['token', 'usageStampId', 'disclosure'] as const)(
    'rejects consent lifted onto a row with a different %s',
    (field) => {
      // Every signed field is bound, so one joiner's consent cannot be re-filed under
      // another invitation, another redemption nonce, or other disclosure text.
      const peerSig = signConsentDigest(row, joinerPrivateKey);
      expect(verifyFormationConsent({ ...row, [field]: 'something-else', peerSig })).toBe(false);
    }
  );

  it('rejects a tampered signature', () => {
    const peerSig = signConsentDigest(row, joinerPrivateKey);
    const tampered = (peerSig[0] === 'A' ? 'B' : 'A') + peerSig.slice(1);
    expect(verifyFormationConsent({ ...row, peerSig: tampered })).toBe(false);
  });

  it('rejects an approver vouch signature presented as joiner consent', () => {
    // The action tag is the whole point of a separate `'consent'` digest: an approver's
    // sign-off over the same table must never double as the joiner's agreement to join.
    const vouchSig = sign(
      formationVouchMessage({
        token: row.token,
        usageStampId: row.usageStampId,
        strandId: 'strand-1',
        peerId: row.peerKey,
        disclosure: row.disclosure
      }),
      joinerPrivateKey,
      'ed25519',
      'bytes',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyFormationConsent({ ...row, peerSig: vouchSig })).toBe(false);
  });

  it('returns false (does not throw) on malformed input', () => {
    const peerSig = signConsentDigest(row, joinerPrivateKey);
    expect(() => {
      expect(verifyFormationConsent({ ...row, peerSig: 'not valid base64url!!! ***' })).toBe(false);
      expect(verifyFormationConsent({ ...row, peerSig: '' })).toBe(false);
      expect(verifyFormationConsent({ ...row, peerKey: 'garbage-key-not-32-bytes', peerSig })).toBe(false);
    }).not.toThrow();
  });

  it('agrees with formationConsentMessage: signing the raw bytes verifies via the digest', () => {
    // The joiner signs `formationConsentMessage` (raw bytes, control-database.ts) while
    // this verifier rebuilds the vector through `formationConsentDigest` (base64url,
    // peer-authorization.ts). Two mirrors of one field vector in two modules: if either
    // drifts, every real consent fails closed without throwing, so pin them together.
    const peerSig = sign(
      formationConsentMessage(row),
      joinerPrivateKey,
      'ed25519',
      'bytes',
      'base64url',
      'base64url'
    ) as string;
    expect(verifyFormationConsent({ ...row, peerSig })).toBe(true);
  });
});
