import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { digest } from '@optimystic/quereus-plugin-crypto';
import { ed25519KeyPairFromLibp2p } from './ed25519-key.js';

/**
 * Domain-separation tag for the strand-transport-key derivation. Versioned so a
 * future change to the derivation (different KDF, different inputs) can bump to
 * `.v2` and be recognized as a deliberate identity migration rather than silent
 * peerId churn — a strand node's transport peerId must stay stable across
 * process restarts, or any peer-store entry or `MemberPeer` row that names it
 * goes stale on every boot.
 */
const STRAND_TRANSPORT_KEY_DOMAIN = 'sereus.strand-transport-key.v1';

/**
 * Derive a strand node's libp2p transport key from the cadre identity key and
 * the strand id.
 *
 * A `CadreNode` runs its control node and each strand node as separate libp2p
 * instances. Handing them all the same private key gives them all the same
 * peerId, and `@libp2p/circuit-relay-v2` keys reservations and hop-connects by
 * peerId — so a control node and a strand node reserving through one shared
 * relay collide, and relayed streams for one land on the other
 * (https://github.com/gotchoices/sereus/issues/1). Each strand node therefore
 * gets its own transport identity. Cadre *authority* is untouched: the control
 * node keeps the identity key, and every peerId→authority derivation
 * (`ed25519PublicKeyB64FromPeerId`) is a control-network path.
 *
 * The derivation is deterministic — `sha256(domain, identity seed, strandId)`
 * as an Ed25519 seed — rather than a fresh random key per launch, so the
 * strand's transport peerId survives restarts. The identity *private* seed is
 * an input (not the public key) so that no third party can enumerate a member's
 * strand peerIds from public data; only the key holder can compute them.
 *
 * NOTE: nothing on the strand mesh gates admission by peerId today — strand
 * nodes deliberately keep the raw configured connection gater because their
 * peers are legitimately cross-party — so this derived peerId is unattested and
 * that breaks nothing. If strand-mesh admission control is ever added, the
 * binding it needs is a `MemberPeer(MemberKey, PeerId)` row: the table and its
 * self-signed `Authorized` constraint already exist in `schemas/strand.qsql`;
 * production code simply never writes one.
 *
 * @param identityKey - The cadre's Ed25519 identity key (the control node's key).
 * @param strandId - The strand whose transport key to derive.
 * @returns A stable, per-strand Ed25519 libp2p private key, distinct from the
 *   identity key and from every other strand's.
 * @throws If the identity key is not Ed25519.
 */
export async function strandTransportKey(identityKey: PrivateKey, strandId: string): Promise<PrivateKey> {
  const { privateKeyB64 } = ed25519KeyPairFromLibp2p(identityKey);
  const seed = digest([STRAND_TRANSPORT_KEY_DOMAIN, privateKeyB64, strandId], 'sha256', 'bytes') as Uint8Array;
  return generateKeyPairFromSeed('Ed25519', seed);
}
