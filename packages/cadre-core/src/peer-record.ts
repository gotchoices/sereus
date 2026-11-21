/**
 * Peer-address record helpers: the single source of truth for the bytes a node
 * signs when publishing its own `CadrePeer` row and re-verifies when resolving
 * another peer's row.
 *
 * The signed payload is a single SHA-256 digest over the shared domain-tagged
 * field vector (see control-authorization.ts) — the crypto plugin's injective
 * multi-field encoding, so no field split is ambiguous. It is intentionally NOT
 * JSON-canonicalized (deterministic across node/browser/RN, no key ordering)
 * and — crucially — is reconstructable inside the `CadrePeer.AuthorizedUpdate`
 * SQL constraint from the row's own columns and the node-local `party_id()`:
 *
 *   digest('CadreControl.CadrePeer', 'publish', party_id(),
 *          new.PeerId, new.Multiaddr, cast(new.UpdatedAt as text),
 *          coalesce(new.Profile, ''))
 *
 * Keep {@link peerRecordSignedPayload} and that constraint byte-for-byte in
 * sync. The `'publish'` action tag marks this as a peer's SELF-signed record
 * (signed with the peer's own key, not an owner key) and keeps it disjoint from
 * every owner-signed digest; the party id keeps a record published into one
 * party's table from verifying in another's. A node signs and verifies with its
 * own party: these records come only from its own party's control database.
 *
 * `publicKey` is deliberately excluded from the payload — it is the key the
 * signature is verified *with* (so a signature already commits to exactly one
 * key), and its binding to `peerId` is checked separately at resolve time.
 */

import { multiaddr } from '@multiformats/multiaddr';
import { digest, sign, verify } from '@optimystic/quereus-plugin-crypto';
import { controlAuthorizationFields } from './control-authorization.js';
import { addrKindOfComponents, type AddrKind } from './peer-dial.js';
import type { PeerAddressRecord, PeerResolveTrustPolicy } from './types.js';
import type { PublishedProfile } from './node-class.js';

/**
 * Default freshness ceiling for resolved peer-address records (15 minutes).
 * A record older than this is treated as stale and filtered out, so a resolver
 * never hands back a dead relay reservation. The publish path re-stamps at
 * roughly half this interval (see {@link DEFAULT_PEER_RECORD_HEARTBEAT_MS}).
 */
export const DEFAULT_PEER_RECORD_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * TTL heartbeat interval for re-publishing the self record — half the freshness
 * ceiling, so a record is refreshed well before it can go stale.
 */
export const DEFAULT_PEER_RECORD_HEARTBEAT_MS = DEFAULT_PEER_RECORD_MAX_AGE_MS / 2;

/**
 * Build the base64url SHA-256 digest that the self-signature covers. Mirrors the
 * `CadrePeer.AuthorizedUpdate` constraint exactly; both sides take the default
 * base64url output of a single `digest(...)`, which round-trips cleanly (unlike
 * concatenating several base64url digests).
 *
 * @param partyId - the party whose `CadrePeer` table the record is published into
 * @param peerId - base58btc libp2p peer id (the row key)
 * @param multiaddr - the comma-joined `Multiaddr` string EXACTLY as stored
 * @param updatedAt - epoch-ms freshness stamp
 * @param profile - whether the publisher is always on, stored form; null signs as `''`, as the constraint coalesces it
 */
export function peerRecordSignedPayload(
  partyId: string, peerId: string, multiaddr: string, updatedAt: number, profile: PublishedProfile | null
): string {
  const fields = controlAuthorizationFields('CadreControl.CadrePeer', 'publish', partyId, [peerId, multiaddr, String(updatedAt), profile ?? '']);
  return digest(fields, 'sha256', 'base64url') as string;
}

/**
 * Sign a peer-address record with the ed25519 private key behind its `peerId`.
 * Returns a fully-populated {@link PeerAddressRecord} (the `addrs` order is
 * preserved and is the order signed over).
 *
 * @param partyId - the party whose `CadrePeer` table the record is published into
 * @param fields - the record fields to sign (relayed addr first by convention; see {@link orderRelayedFirst})
 * @param privateKeyB64 - base64url ed25519 seed (see `ed25519KeyPairFromLibp2p`)
 */
export function signPeerRecord(
  partyId: string,
  fields: Omit<PeerAddressRecord, 'sig'>,
  privateKeyB64: string
): PeerAddressRecord {
  const payloadDigest = peerRecordSignedPayload(partyId, fields.peerId, fields.addrs.join(','), fields.updatedAt, fields.profile);
  const sig = sign(
    payloadDigest,
    privateKeyB64,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  ) as string;
  return { peerId: fields.peerId, publicKey: fields.publicKey, addrs: [...fields.addrs], updatedAt: fields.updatedAt, profile: fields.profile, sig };
}

/**
 * Verify a record's self-signature against its own `publicKey`, for `partyId`.
 * Reconstructs the signed bytes from the record exactly as {@link signPeerRecord}
 * produced them. Returns false on a missing key/sig or any verification failure.
 */
export function verifyPeerRecordSignature(partyId: string, record: PeerAddressRecord): boolean {
  if (!record.publicKey || !record.sig) {
    return false;
  }
  const payloadDigest = peerRecordSignedPayload(partyId, record.peerId, record.addrs.join(','), record.updatedAt, record.profile);
  return verify(
    payloadDigest,
    record.sig,
    record.publicKey,
    'ed25519',
    'base64url',
    'base64url',
    'base64url'
  );
}

/**
 * Freshness predicate: true when `updatedAt` is a positive stamp within
 * `maxAgeMs` of `now`. A non-positive `updatedAt` (never self-published) is
 * never fresh.
 */
export function isPeerRecordFresh(updatedAt: number, maxAgeMs: number, now: number): boolean {
  if (!(updatedAt > 0)) {
    return false;
  }
  return now - updatedAt <= maxAgeMs;
}

/**
 * The {@link AddrKind} of a STORED address string, or `undefined` when it does not parse as a
 * multiaddr. A stored record's `addrs` are whatever its publisher signed, so an entry that does
 * not parse is an ordinary possibility and the answer, not an error worth logging; every caller
 * below either groups it with the direct addresses or drops it.
 */
function addrKindOf(addr: string): AddrKind | undefined {
  try {
    return addrKindOfComponents(multiaddr(addr).getComponents());
  } catch {
    return undefined;
  }
}

/**
 * True if `addr` reaches its peer through a relay hop — either shape: the plain relayed address
 * a reservation publishes, or the WebRTC one whose signalling the same relay carries. An address
 * that does not parse is not one.
 */
export function isSignalingAddr(addr: string): boolean {
  const kind = addrKindOf(addr);
  return kind === 'relayed' || kind === 'webrtc';
}

/**
 * Return `addrs` in three groups, each keeping its given order: every plain relayed address,
 * then every direct one (and any entry that does not parse, which every caller drops or ignores
 * downstream), then every WebRTC one.
 *
 * This is the order a machine's published `CadrePeer` record carries and the order every resolve
 * of another machine's record hands a dial, so it is where the rule in `docs/network/relay.md` →
 * "Direct connections over WebRTC" is applied to a whole address list: an address that needs ICE
 * after its relay hop ranks BELOW the plain relayed address published beside it, because it
 * answers nothing for about 23 s when ICE cannot connect. The relayed address leads because a
 * NAT'd machine is reachable at no other address at all.
 *
 * Does NOT mutate the input and must not be used before signature verification (verification
 * uses the original on-record order).
 */
export function orderRelayedFirst(addrs: readonly string[]): string[] {
  const byKind: Record<AddrKind, string[]> = { relayed: [], direct: [], webrtc: [] };
  for (const addr of addrs) {
    byKind[addrKindOf(addr) ?? 'direct'].push(addr);
  }
  return [...byKind.relayed, ...byKind.direct, ...byKind.webrtc];
}

/**
 * The one address of `addrs` that a seed should carry for this machine, or `null` when it holds
 * no relay reservation: the first address that reaches through a relay, taken in
 * {@link orderRelayedFirst} order, so the plain relayed address wins and a WebRTC one is named
 * only when there is no plain relayed address at all.
 *
 * An address that ends AT its hop (`…/p2p-circuit`, naming no destination) is skipped: it is no
 * use to whoever receives the seed. Shared by `CadreNode.getRelayAddress` and
 * `SeedBootstrapService.getRelayAddress`, which both ask this of their own announced addresses.
 */
export function firstRelayedAddr(addrs: readonly string[]): string | null {
  const throughRelay = addrs.filter((addr) => addr.includes('/p2p-circuit/') && isSignalingAddr(addr));
  return orderRelayedFirst(throughRelay)[0] ?? null;
}

/**
 * Default resolve trust gate: trust any peer that has a `CadrePeer` row.
 *
 * A row only exists because an owner signed its `AuthorizedInsert`, so row
 * presence already means "owner-vouched member". This is the seam where a
 * stricter policy (trust circle, pinned keys) plugs in — see
 * {@link PeerResolveTrustPolicy}.
 */
export function currentMemberTrustPolicy(): PeerResolveTrustPolicy {
  return {
    evaluate() {
      return true;
    },
  };
}
