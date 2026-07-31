import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generatePrivateKey, sign } from '@optimystic/quereus-plugin-crypto';
import { canonicalJson } from '../src/canonical-json.js';
import { generateStampId, formationConsentMessage } from '../src/control-database.js';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';
import type { FormationContactMessage } from '../src/strand-formation-protocol.js';

/** A throwaway joining peer: base64url ed25519 seed + its public key. */
export interface TestJoiner {
  privateKey: string;
  peerKey: string;
}

export function mintJoiner(): TestJoiner {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  return { privateKey, peerKey: ed25519PublicKeyFromPrivate(privateKey) };
}

/** Spreadable into redeemInvitation / recordFormationUsage / recordUsage calls. */
export interface JoinerConsent {
  peerKey: string;
  usageStampId: string;
  peerSignature: string;
}

/** Sign the 'consent' digest over the EXACT token/nonce/disclosure the insert will carry. */
export function signJoinerConsent(
  joiner: TestJoiner,
  fields: { token: string; usageStampId: string; disclosure?: string },
): string {
  return sign(
    formationConsentMessage({
      token: fields.token,
      usageStampId: fields.usageStampId,
      peerKey: joiner.peerKey,
      disclosure: fields.disclosure ?? '',
    }),
    joiner.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url',
  ) as string;
}

/** Fresh joiner + fresh nonce + consent signature, in one spreadable object. */
export function mintConsent(token: string, disclosure = '', joiner: TestJoiner = mintJoiner()): JoinerConsent {
  const usageStampId = generateStampId(joiner.peerKey);
  return {
    peerKey: joiner.peerKey,
    usageStampId,
    peerSignature: signJoinerConsent(joiner, { token, usageStampId, disclosure }),
  };
}

/** A joiner with a REAL libp2p identity: partyId embeds peerKey (the listener pins them). */
export interface TestContactJoiner extends TestJoiner { partyId: string; }

export async function mintContactJoiner(): Promise<TestContactJoiner> {
  const libp2pKey = await generateKeyPair('Ed25519');
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(libp2pKey);
  return { privateKey: privateKeyB64, peerKey: publicKeyB64, partyId: peerIdFromPrivateKey(libp2pKey).toString() };
}

/** Consent triple for a strand-layer contact: signs over canonicalJson(disclosure). */
export function mintContactConsent(joiner: TestContactJoiner, token: string, disclosure: unknown): JoinerConsent {
  const usageStampId = generateStampId(joiner.partyId);
  return {
    peerKey: joiner.peerKey,
    usageStampId,
    peerSignature: signJoinerConsent(joiner, { token, usageStampId, disclosure: canonicalJson(disclosure) }),
  };
}

/** Corrupt the leading base64url character — enough to break any signature. */
function flipFirstChar(text: string): string {
  return (text[0] === 'A' ? 'B' : 'A') + text.slice(1);
}

/**
 * Every way a contact's joiner consent can fail, derived from one good contact —
 * shared so the protocol-layer pre-check and the recorder-backed responder assert the
 * SAME matrix. Each entry keeps the signature intact and moves one signed input, so a
 * responder that skipped any field of the `'consent'` digest fails exactly one case.
 */
export async function invalidConsentContacts(
  good: FormationContactMessage,
): Promise<Array<[string, FormationContactMessage]>> {
  const other = await mintContactJoiner();
  return [
    ['tampered peerSignature', { ...good, peerSignature: flipFirstChar(good.peerSignature) }],
    ['partyId of a different joiner', { ...good, partyId: other.partyId }],
    ['garbage peerKey', { ...good, peerKey: 'garbage-not-32-bytes' }],
    ['consent minted for another token', { ...good, token: `${good.token}-other` }],
    ['disclosure swapped after signing', { ...good, disclosure: { ...good.disclosure, purpose: 'swapped' } }],
    ['nonce swapped after signing', { ...good, usageStampId: generateStampId('swapped-nonce') }],
  ];
}
