import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generatePrivateKey, sign } from '@optimystic/quereus-plugin-crypto';
import { canonicalJson } from '../src/canonical-json.js';
import { generateStampId, formationConsentMessage } from '../src/control-database.js';
import { ed25519KeyPairFromLibp2p, ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';

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
