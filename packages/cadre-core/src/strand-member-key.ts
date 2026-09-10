import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { ed25519KeyPairFromLibp2p, type Ed25519KeyPair } from './ed25519-key.js';

/**
 * Mint a fresh ed25519 strand member private key, encoded as base64 protobuf.
 *
 * Used for BOTH closed-strand key roles, which share this encoding but are
 * deliberately different keys:
 *  - the strand-wide read secret (`Strand.MemberPrivateKey`), which formation
 *    hands to every joining party — the SAME encoding
 *    {@link StrandSolicitationService.formStrand} uses for its `invitePrivateKey`,
 *    so a host-minted key and a formation-issued key are interchangeable when
 *    attaching a closed strand;
 *  - a single party's own membership identity (the control-layer `StrandPartyKey`
 *    row, minted by `CadreNode.ensureStrandPartyKey`), never shared outside the
 *    party.
 */
export async function generateStrandMemberKey(): Promise<string> {
  const privateKey = await generateKeyPair('Ed25519');
  return uint8ArrayToString(privateKeyToProtobuf(privateKey), 'base64');
}

/**
 * Bridge a strand membership private key (base64 protobuf libp2p ed25519 key, as
 * minted by {@link generateStrandMemberKey} or issued by formation) into the
 * base64url keypair the strand RBAC constraints consume.
 *
 * The founding `Member.Key`/`Manager.MemberKey` (the strand RBAC layer) are the
 * `publicKeyB64` of the keypair this returns, derived from the PARTY's own
 * `StrandPartyKey.PrivateKey` — deliberately NOT from the strand row's
 * `MemberPrivateKey`, which is the strand-wide read secret every joining party
 * receives (an identity derived from it is one every joiner can forge —
 * gotchoices/sereus#4). Both keys share this encoding, so this decoder serves
 * either. Decode the protobuf to a libp2p private key, then reuse
 * {@link ed25519KeyPairFromLibp2p} so the same seed→public derivation used for node
 * owner keys yields a stable `{ privateKeyB64, publicKeyB64 }` whose public
 * key a later strand signature verifies against.
 *
 * @param memberPrivateKey - A strand membership private key (base64 protobuf).
 * @returns The base64url seed/public-key pair for strand membership signing.
 * @throws If the decoded key is not Ed25519 or the raw bytes are malformed.
 */
export function strandMemberKeyPair(memberPrivateKey: string): Ed25519KeyPair {
  const privateKey = privateKeyFromProtobuf(uint8ArrayFromString(memberPrivateKey, 'base64'));
  return ed25519KeyPairFromLibp2p(privateKey);
}
