/**
 * PKCE (RFC 7636), the server's half: the shape a code challenge or verifier must have, and
 * whether a verifier hashes to a challenge. The client's half (minting the pair) is
 * cadre-core's `provider/oauth.ts`; the two meet only on the wire.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 43 to 128 characters of RFC 7636's unreserved set (§4.1), which base64url is a subset of.
 * One rule serves both the verifier and the challenge: an S256 challenge is 43 base64url
 * characters, and a verifier is whatever the client minted within the same bounds.
 */
const PKCE_TEXT = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether `text` has the shape of a code verifier or code challenge. */
export function isPkceText(text: string): boolean {
  return PKCE_TEXT.test(text);
}

/** The S256 transform: `base64url(SHA-256(verifier))`. */
export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Whether `verifier` is the one `challenge` was made from. Compared in constant time, so a
 * wrong guess learns nothing about the stored challenge.
 */
export function verifyCodeVerifier(verifier: string, challenge: string): boolean {
  const expected = Buffer.from(codeChallengeFor(verifier));
  const presented = Buffer.from(challenge);
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
