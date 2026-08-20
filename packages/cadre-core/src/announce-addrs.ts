/**
 * Translate `network.announceAddrs` / `network.appendAnnounceAddrs` — the operator-facing
 * "advertise these addresses" settings — into the two `@optimystic/db-p2p` `NodeOptions`
 * fields of the same names, which reach libp2p's `addresses.announce` /
 * `addresses.appendAnnounce`.
 *
 * Two jobs, both of which the control node and every strand node need identically, hence
 * one module rather than the same conditional spread written twice:
 *
 * - **Empty means unset.** libp2p treats `announce: []` as "no override", and forwarding
 *   `[]` would still be forwarding a field. An empty config array is dropped so it cannot
 *   land as an explicit empty announce set.
 * - **Validate the multiaddrs here, at start.** libp2p does NOT validate announce addrs
 *   at construction: `AddressManager` stores them as raw strings and only parses them on
 *   the first `getAnnounceAddrs()`. A typo therefore produces a node that starts
 *   cleanly, then throws `InvalidMultiaddrError` out of every `getMultiaddrs()` call —
 *   including an UNHANDLED one from the debounced peer-store update libp2p runs on
 *   `transport:listening`. Verified against libp2p's `address-manager` (its constructor
 *   does `announce.map(ma => ma.toString())`; `getAnnounceAddrs()` does `multiaddr(a)`).
 *   Parsing each entry up front converts that into a loud failure at node start, which is
 *   what {@link relayCircuitAddrs} already does for `network.relayAddrs`.
 */

import { multiaddr } from '@multiformats/multiaddr';
import type { NetworkConfig } from './types.js';

/**
 * The announce fields to spread into `createLibp2pNode` options. A field is present
 * only when the operator configured a non-empty list for it, so a node that configures
 * neither passes neither.
 */
export interface ResolvedAnnounceAddrs {
  announceAddrs?: string[];
  appendAnnounceAddrs?: string[];
}

/**
 * Resolve both announce fields off a `NetworkConfig`. Throws — naming the offending
 * config field and entry — when any entry is not a parsable multiaddr.
 */
export function resolveAnnounceAddrs(network: NetworkConfig | undefined): ResolvedAnnounceAddrs {
  const announceAddrs = configuredAddrs('network.announceAddrs', network?.announceAddrs);
  const appendAnnounceAddrs = configuredAddrs('network.appendAnnounceAddrs', network?.appendAnnounceAddrs);
  return {
    ...(announceAddrs && { announceAddrs }),
    ...(appendAnnounceAddrs && { appendAnnounceAddrs })
  };
}

/**
 * Whether this node's advertised set will be REPLACED rather than extended — i.e.
 * whether {@link ResolvedAnnounceAddrs.announceAddrs} is in play at all. The single
 * predicate behind `CadreNode.start()`'s operator warning, kept here so the warning
 * and the forwarding agree on what "set" means (non-empty, not merely present).
 */
export function replacesAdvertisedAddrs(network: NetworkConfig | undefined): boolean {
  return (network?.announceAddrs?.length ?? 0) > 0;
}

/** The entries to forward for one announce field, or `undefined` when it is unset or empty. */
function configuredAddrs(field: string, addrs: readonly string[] | undefined): string[] | undefined {
  if (!addrs || addrs.length === 0) {
    return undefined;
  }
  return addrs.map((addr) => validated(field, addr));
}

/** `addr` unchanged, having proved it parses — with the config field named on failure. */
function validated(field: string, addr: string): string {
  try {
    multiaddr(addr);
  } catch (err) {
    throw new Error(`${field} entry is not a valid multiaddr: ${addr}`, { cause: err });
  }
  return addr;
}
