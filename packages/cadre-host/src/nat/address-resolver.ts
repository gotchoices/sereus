/**
 * Build the public multiaddrs of one hosted node from the host's current
 * understanding of its dialable surface.
 *
 * Pure so it's trivial to unit-test, and so `NatService` is the only place
 * that turns settings and routes into addresses. The addresses carry no
 * `/p2p/` suffix: the node appends its own (cadre-core `normalizeSelfAddrs`,
 * libp2p for announce addresses). The node's own LAN addresses are not here
 * either — libp2p reports those itself.
 */

import type { PortRoute } from './types.js';

export interface PublicAddressInput {
  ddnsHostname: string | null;
  /** Last known public IPv4; null when unknown. */
  externalIp: string | null;
  cgnatDetected: boolean;
  tcp: PortRoute;
  ws: PortRoute | null;
}

export function buildPublicAddresses(input: PublicAddressInput): string[] {
  const host = publicHost(input);
  if (!host) return [];
  const out: string[] = [];
  const tcpPort = routedPort(input.tcp, input.cgnatDetected);
  if (tcpPort !== null) out.push(`${host}/tcp/${tcpPort}`);
  const wsPort = input.ws ? routedPort(input.ws, input.cgnatDetected) : null;
  if (wsPort !== null) out.push(`${host}/tcp/${wsPort}/ws`);
  return out;
}

/**
 * `/dns4/<hostname>` when a DDNS hostname is configured (externally managed
 * included), else `/ip4/<externalIp>` when that is a public IPv4, else none.
 */
function publicHost(input: PublicAddressInput): string | null {
  if (input.ddnsHostname) return `/dns4/${input.ddnsHostname}`;
  if (input.externalIp && isPublicIpv4(input.externalIp)) return `/ip4/${input.externalIp}`;
  return null;
}

/**
 * Under CGNAT a UPnP route produces nothing: the router's mapping is on a
 * carrier-private address. A manual route still does, since the user asserted
 * the forward (the CGNAT check can misfire).
 */
function routedPort(route: PortRoute, cgnatDetected: boolean): number | null {
  if (route.externalPort === null || route.source === null) return null;
  if (cgnatDetected && route.source === 'upnp') return null;
  return route.externalPort;
}

/** Private, carrier-grade, loopback, link-local, multicast and reserved IPv4 ranges. */
const NON_PUBLIC_IPV4: ReadonlyArray<[number, number]> = [
  [0x00000000, 8],  // 0.0.0.0/8
  [0x0a000000, 8],  // 10.0.0.0/8
  [0x64400000, 10], // 100.64.0.0/10 (carrier-grade NAT)
  [0x7f000000, 8],  // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xe0000000, 4],  // 224.0.0.0/4 (multicast)
  [0xf0000000, 4],  // 240.0.0.0/4 (reserved, broadcast)
];

/** True for a dotted-quad IPv4 outside every non-public range above. */
export function isPublicIpv4(s: string): boolean {
  const octets = parseIpv4(s);
  if (!octets) return false;
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return !NON_PUBLIC_IPV4.some(([base, prefix]) => (value >>> (32 - prefix)) === (base >>> (32 - prefix)));
}

function parseIpv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}
