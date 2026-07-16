import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { ed25519KeyPairFromLibp2p, type Ed25519KeyPair } from './ed25519-key.js';

/**
 * Mint a fresh ed25519 strand member private key, encoded as base64 protobuf.
 *
 * Closed strands (`Type:'c'`) gate membership on a `MemberPrivateKey` column
 * (see the `Strand` control-schema table). This produces one in the SAME
 * encoding {@link StrandSolicitationService.formStrand} uses for its
 * `invitePrivateKey`, so a host-minted key and a formation-issued key are
 * interchangeable when attaching a closed strand.
 */
export async function generateStrandMemberKey(): Promise<string> {
  const privateKey = await generateKeyPair('Ed25519');
  return uint8ArrayToString(privateKeyToProtobuf(privateKey), 'base64');
}

/**
 * Bridge a strand's `MemberPrivateKey` (base64 protobuf libp2p ed25519 key, as
 * minted by {@link generateStrandMemberKey} or issued by formation) into the
 * base64url keypair the strand RBAC constraints consume.
 *
 * The `Strand` control-layer `MemberPrivateKey` is the closed-strand read-gating
 * secret; the founding `Member.Key`/`Authority.MemberKey` (the strand RBAC layer)
 * are *derived from it* — they are the `publicKeyB64` of the keypair this returns.
 * Decode the protobuf to a libp2p private key, then reuse
 * {@link ed25519KeyPairFromLibp2p} so the same seed→public derivation used for node
 * authority keys yields a stable `{ privateKeyB64, publicKeyB64 }` whose public
 * key a later strand signature verifies against.
 *
 * @param memberPrivateKey - The strand's `MemberPrivateKey` (base64 protobuf).
 * @returns The base64url seed/public-key pair for founding membership/authority.
 * @throws If the decoded key is not Ed25519 or the raw bytes are malformed.
 */
export function strandMemberKeyPair(memberPrivateKey: string): Ed25519KeyPair {
  const privateKey = privateKeyFromProtobuf(uint8ArrayFromString(memberPrivateKey, 'base64'));
  return ed25519KeyPairFromLibp2p(privateKey);
}
