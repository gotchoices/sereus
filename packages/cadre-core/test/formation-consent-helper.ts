import { generatePrivateKey, sign } from '@optimystic/quereus-plugin-crypto';
import { generateStampId, formationConsentMessage } from '../src/control-database.js';
import { ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';

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
