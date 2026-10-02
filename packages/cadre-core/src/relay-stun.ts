import debug from 'debug';
import { multiaddr } from '@multiformats/multiaddr';

const log = debug('sereus:cadre:relay-stun');

/**
 * The UDP port a Sereus relay answers STUN on (`STUN_PORT` in `ops/docker/libp2p-infra`).
 * Fixed rather than discovered: a relay advertises only its libp2p listeners, so a relay
 * that publishes STUN elsewhere needs the app's explicit override.
 */
export const RELAY_STUN_PORT = 3478;

/** A STUN-only `RTCIceServer`, declared structurally so non-DOM builds can use it. */
export interface StunServer {
  urls: string;
}

/**
 * Multiaddr protocols that name a host a `stun:` URL can carry. For `dnsaddr` that is the
 * name the TXT records sit under, which is the relay's own host when one relay publishes
 * `_dnsaddr.<host>` for itself (`ops/docs/dnsaddr.md`). A pool published under one name
 * (`relay-1.…`, `relay-2.…`) needs that name to resolve to one of its relays, or the
 * embedder's override.
 */
const HOST_PROTOCOLS = new Set(['dns', 'dns4', 'dns6', 'dnsaddr', 'ip4', 'ip6']);

/**
 * The `stun:` URL for the relay at `relayAddr`, or `undefined` when the address names no
 * host. An unparsable address only logs: `CadreNode.start()` rejects the same `relayAddrs`
 * entry with an error naming it.
 */
export function relayStunUrl(relayAddr: string): string | undefined {
  let first;
  try {
    first = multiaddr(relayAddr).getComponents()[0];
  } catch (err) {
    log('no STUN server for unparsable relay address %s: %o', relayAddr, err);
    return undefined;
  }
  if (first?.value === undefined || !HOST_PROTOCOLS.has(first.name)) return undefined;
  const host = first.name === 'ip6' ? `[${first.value}]` : first.value;
  return `stun:${host}:${RELAY_STUN_PORT}`;
}

/**
 * The STUN servers for a node's WebRTC transport: the comma-separated `override` URLs when
 * it names any, otherwise one per distinct relay host — each Sereus relay also answers
 * STUN. Empty with no relay and no override, which leaves host/LAN candidates only and
 * tells no third party who this node talks to. No TURN: a WebRTC upgrade that fails stays
 * on the circuit relay.
 */
export function resolveStunServers(relayAddrs: readonly string[], override?: string): StunServer[] {
  const overrideUrls = (override ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const urls = overrideUrls.length > 0
    ? overrideUrls
    : relayAddrs.map(relayStunUrl).filter((url): url is string => url !== undefined);
  return [...new Set(urls)].map((url) => ({ urls: url }));
}
