/**
 * Merging verified cadre addresses into a libp2p node's **address book** (its
 * peerStore), so that every layer below cadre-core which dials by bare peer id
 * — Optimystic's cluster client, repo client, FRET ping/announce, all funnelling
 * into `libp2p.dialProtocol(peerId, …)` — has an address to use for a sibling
 * whose connection has dropped, instead of failing with `NoValidAddressesError`
 * until the next reconcile pass happens to re-dial it.
 *
 * Shared by the control-cohort reconcile pass (`CadreNode`) and, in due course,
 * the strand-cohort one: both resolve a peer's signed, fresh, trust-gated
 * addresses and then need exactly this write, with exactly this workaround.
 */

import debug from 'debug';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Address, Peer, PeerId, PeerStore, TagOptions } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

const log = debug('sereus:cadre:peer-addr-book');

/** Outcome of one address-book merge, for logging and tests. */
export type MergeAddrsResult = 'merged' | 'restamped' | 'skipped' | 'failed';

/**
 * The slice of a libp2p node {@link mergePeerAddrs} touches. Structurally
 * satisfied by `Libp2p`; narrow so a caller (or a test) can pass a bare
 * peerStore holder.
 */
export interface PeerAddrBookHost {
  peerStore: PeerStore;
}

/**
 * Write `addrs` into `host`'s address book for `peerId`, best-effort. `peerId`
 * may be the string form callers hold (a `CadrePeer.PeerId` column, a strand-addr
 * RPC result); parsing it is part of the best-effort contract below, so no caller
 * has to wrap this in a second try/catch of its own.
 *
 * - **Empty `addrs` writes nothing** and reports `'skipped'`. That is how a
 *   revoked / stale / untrusted peer's existing entry is allowed to age out on
 *   its own: the caller resolves `[]` for it, and nothing here refreshes it.
 * - Otherwise the addresses are merged, and — see the timestamp trap below —
 *   re-saved when the merge alone leaves them invisible (`'restamped'`).
 * - Any throw (unparsable peer id, datastore failure, a peerStore double without
 *   `merge`) is logged and folded to `'failed'`. Callers are best-effort loops:
 *   an address-book failure must never abort a reconcile pass.
 *
 * NOTE: `peerStore.merge` cannot refresh an address's `observed` timestamp in
 * `@libp2p/peer-store` 12.0.10 — `to-peer-pb.js` shadows its own loop variable
 * (`…addresses?.find(addr => uint8ArrayEquals(addr.multiaddr, addr.multiaddr))`,
 * always true, so it returns the FIRST stored address's timestamp), and every
 * read filters out addresses older than `MAX_ADDRESS_AGE` (1 hour). So an entry
 * silently dies at the one-hour mark and no amount of re-merging revives it —
 * not even merging a brand-new address. The `save` below is the workaround:
 * `save` is the one write path that omits `existingPeer` and therefore stamps
 * `Date.now()`. Drop it once upstream stamps `Date.now()` on merge.
 *
 * NOTE: raising the store's own `maxAddressAge` (libp2p forwards `init.peerStore`
 * straight into `persistentPeerStore`) would sidestep the bug in one line, and is
 * deliberately NOT done: expiry is load-bearing here. Only *verified* addresses
 * come through this helper, and the design relies on everything else — the
 * cold-start seed entries, identify-learned addresses — still ageing out on the
 * stock schedule. A global age bump would keep those alive too.
 *
 * NOTE: if the store ever REJECTS an address we hand it, the restamp repeats
 * every pass forever — `allVisible` stays false, and `save` re-submits the same
 * rejected address. libp2p wires the store's `addressFilter` to
 * `connectionGater.filterMultiaddrForPeer`, which nothing in this repo implements
 * today (`createMembershipConnectionGater` gates dials, not addresses), so the
 * loop is unreachable. If an app ever supplies that gater hook via
 * `NetworkConfig.connectionGater`, bound the retry — the cost is one redundant
 * datastore write per gated sibling per reconcile pass.
 */
export async function mergePeerAddrs(
  host: PeerAddrBookHost,
  peerId: PeerId | string,
  addrs: Multiaddr[]
): Promise<MergeAddrsResult> {
  if (addrs.length === 0) {
    return 'skipped';
  }
  try {
    const id = typeof peerId === 'string' ? peerIdFromString(peerId) : peerId;
    const peer = await host.peerStore.merge(id, { multiaddrs: addrs });
    // The returned Peer is already expiry-filtered, so it says whether the merge
    // is actually VISIBLE — which is the only question that matters downstream.
    if (allVisible(peer.addresses, addrs, id)) {
      return 'merged';
    }
    await host.peerStore.save(id, restampData(peer, addrs, id));
    return 'restamped';
  } catch (error) {
    log('mergePeerAddrs: address-book write for %s failed: %o', peerId.toString(), error);
    return 'failed';
  }
}

/**
 * The peerStore strips a trailing `/p2p/<peerId>` from an address it stores when
 * that id is the address's FIRST `/p2p/` component (`dedupe-addresses.js`), so a
 * plain address round-trips without its suffix while a relayed one — whose first
 * `/p2p/` names the relay — keeps it. Comparing and de-duplicating on this
 * suffix-stripped form matches either shape.
 */
function addrKey(addr: string, peerId: PeerId): string {
  const suffix = `/p2p/${peerId.toString()}`;
  return addr.endsWith(suffix) ? addr.slice(0, -suffix.length) : addr;
}

/** Is every address in `addrs` readable back from the stored, expiry-filtered set? */
function allVisible(stored: Address[], addrs: Multiaddr[], peerId: PeerId): boolean {
  const keys = new Set(stored.map((a) => addrKey(a.multiaddr.toString(), peerId)));
  return addrs.every((addr) => keys.has(addrKey(addr.toString(), peerId)));
}

/**
 * The full `save` payload for a restamp: `save` re-uses the `patch` strategy with
 * no existing peer, so every field it is not handed is DROPPED — and Optimystic
 * classifies peers by their peerStore protocol list (`libp2p-key-network.ts`
 * `membershipOf`), so losing protocols here would break cluster/repo routing.
 * Everything therefore carries forward from the just-merged `peer`.
 *
 * The read-modify-write is NOT atomic against a concurrent `identify` write to
 * the same entry. The loss window is milliseconds and costs at most one identify
 * update, recovered by the next identify push — not worth a lock.
 *
 * A tag's remaining TTL is not carried: the public `Tag` type exposes only
 * `value`, so the stored expiry is unreadable from here and the tag comes back
 * non-expiring. `publicKey` is likewise not passed, which is lossless for the
 * Ed25519 peer ids a cadre uses (the key is embedded in the id).
 */
function restampData(peer: Peer, addrs: Multiaddr[], peerId: PeerId): {
  addresses: Address[];
  protocols: string[];
  metadata: Map<string, Uint8Array | undefined>;
  tags: Map<string, TagOptions | undefined>;
  peerRecordEnvelope?: Uint8Array;
} {
  const addresses = new Map<string, Address>();
  for (const address of peer.addresses) {
    addresses.set(addrKey(address.multiaddr.toString(), peerId), address);
  }
  for (const addr of addrs) {
    const key = addrKey(addr.toString(), peerId);
    if (!addresses.has(key)) {
      // Uncertified, matching what `merge`'s own `multiaddrs` path would have
      // stored; an address already present keeps whatever flag it carried.
      addresses.set(key, { multiaddr: addr, isCertified: false });
    }
  }
  return {
    addresses: [...addresses.values()],
    protocols: peer.protocols,
    metadata: new Map<string, Uint8Array | undefined>(peer.metadata),
    tags: new Map<string, TagOptions | undefined>(
      [...peer.tags].map(([name, tag]) => [name, { value: tag.value }])
    ),
    peerRecordEnvelope: peer.peerRecordEnvelope
  };
}
