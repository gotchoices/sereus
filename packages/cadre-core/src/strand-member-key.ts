import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString } from 'uint8arrays';

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
