/**
 * Merging verified cadre addresses into a libp2p node's **address book** (its
 * peerStore), so that every layer below cadre-core which dials by bare peer id
 * — Optimystic's cluster client, repo client, FRET ping/announce, all funnelling
 * into `libp2p.dialProtocol(peerId, …)` — has an address to use for a sibling
 * whose connection has dropped, instead of failing with `NoValidAddressesError`
 * until the next reconcile pass happens to re-dial it.
 *
 * Shared by the control-cohort reconcile pass and the strand one (both in
 * `CadreNode`): each resolves a peer's addresses its own way and then needs
 * exactly this write, with exactly this workaround.
 *
 * Two exports, in the order a caller uses them: {@link groupAddrsByPeerId} turns
 * a flat address list into per-peer groups (the strand path starts from the
 * peer-agnostic union the strand-addr RPC returns), and {@link mergePeerAddrs}
 * writes one peer's group.
 */

import debug from 'debug';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Address, Peer, PeerId, PeerStore, TagOptions } from '@libp2p/interface';
import { multiaddr, CODE_P2P, CODE_P2P_CIRCUIT, type Multiaddr } from '@multiformats/multiaddr';

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
 * Group multiaddr strings by the peer id in their final `/p2p/` component — the
 * attribution step between a flat, peer-agnostic address list and the per-peer
 * writes {@link mergePeerAddrs} takes.
 *
 * The **last** `/p2p/` component is the addressed peer, not the first: a relayed
 * address (`…/p2p/<relay>/p2p-circuit/p2p/<dst>`) names the relay first and the
 * destination last, while a direct address (`…/tcp/…/p2p/<dst>`) names only the
 * destination. Taking the last therefore attributes both shapes to the peer the
 * address actually reaches.
 *
 * Three shapes are dropped rather than attributed, because none of them names a
 * peer the address reaches: one that does not parse, one carrying no `/p2p/`
 * component at all (a peer advertising a bare listen addr), and one whose
 * `p2p-circuit` comes AFTER its last `/p2p/` (`…/p2p/<relay>/p2p-circuit`) — that
 * last one is a relay hop with the destination missing, so its trailing peer id
 * is the RELAY's and filing it under the relay would claim the relay is reachable
 * at a circuit leading nowhere. Duplicates collapse within a group. Insertion
 * order is preserved, both between groups and inside one.
 */
export function groupAddrsByPeerId(addrs: string[]): Map<string, Multiaddr[]> {
  const groups = new Map<string, Multiaddr[]>();
  const seen = new Set<string>();
  for (const addr of addrs) {
    const attributed = attributeAddr(addr);
    if (!attributed) {
      continue;
    }
    const key = `${attributed.peerId}\n${addr}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const group = groups.get(attributed.peerId);
    if (group) {
      group.push(attributed.multiaddr);
    } else {
      groups.set(attributed.peerId, [attributed.multiaddr]);
    }
  }
  return groups;
}

/**
 * Parse one address and pull out the peer id it addresses (its last `/p2p/`
 * value); null when the address is unparsable or names no destination. Every case
 * is logged at the same level — an unattributable address is a sibling telling us
 * something we cannot use, which is worth seeing but never worth throwing over.
 */
function attributeAddr(addr: string): { peerId: string; multiaddr: Multiaddr } | null {
  let parsed: Multiaddr;
  try {
    parsed = multiaddr(addr);
  } catch (error) {
    log('groupAddrsByPeerId: skipping unparsable addr %s: %o', addr, error);
    return null;
  }
  const peerId = lastAddressedPeerId(parsed);
  if (peerId === null) {
    log('groupAddrsByPeerId: skipping addr naming no destination peer: %s', addr);
    return null;
  }
  return { peerId, multiaddr: parsed };
}

/**
 * The peer id a parsed address reaches: its last `/p2p/` value, or null when it
 * has none — or when a `p2p-circuit` sits after it, which makes that value the
 * relay's rather than a destination's (see {@link groupAddrsByPeerId}). Walking
 * backwards, meeting the circuit first is exactly that case.
 */
function lastAddressedPeerId(parsed: Multiaddr): string | null {
  const components = parsed.getComponents();
  for (let i = components.length - 1; i >= 0; i--) {
    const component = components[i];
    if (component.code === CODE_P2P_CIRCUIT) {
      return null;
    }
    if (component.code === CODE_P2P && component.value) {
      return component.value;
    }
  }
  return null;
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
