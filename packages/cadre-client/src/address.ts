/**
 * Judging an address for a phone dialing it: from anywhere, only on the same network, or not at
 * all. Parsed with `@multiformats/multiaddr`; the private-range check is a small built-in one, so
 * this entry point loads no stack code.
 */
import { multiaddr } from '@multiformats/multiaddr';
import type { NodeReach } from './model.js';

/**
 * How far an address reaches for a phone dialing it, as cadre-core's `classifyDialAddress` judges
 * it, with one difference (below):
 *
 * - `relay`: through a relay (`/p2p-circuit`) reached over a WebSocket, from anywhere while the
 *   reservation holds;
 * - `webrtc`: a relay hop then WebRTC, from anywhere only if ICE finds a path;
 * - `name` / `public`: a DNS name or public IP with a WebSocket, from anywhere;
 * - `private`: a private-network IP, only from the same network;
 * - `loopback`: the machine itself, never from another one.
 *
 * Null when no phone can dial it at all: plain TCP (phones dial WebSocket and relays only), a
 * relay reached over plain TCP, the unspecified address, or anything unparsable. The relay hop is
 * the difference: `classifyDialAddress` calls any relayed address `relay`.
 */
export type CadronAddressKind = 'relay' | 'webrtc' | 'name' | 'public' | 'private' | 'loopback';

interface Component { name: string; value?: string }

/** The address's components, or null when it does not parse. */
export function addressComponents(addr: string): Component[] | null {
	try {
		return multiaddr(addr).getComponents().map(c => ({ name: c.name, value: c.value }));
	} catch {
		return null;
	}
}

const DNS = new Set(['dns', 'dns4', 'dns6', 'dnsaddr']);
const hasWebSocket = (components: Component[]) => components.some(c => c.name === 'ws' || c.name === 'wss');

export function addressKind(addr: string): CadronAddressKind | null {
	const components = addressComponents(addr);
	if (!components) return null;
	const circuit = components.findIndex(c => c.name === 'p2p-circuit');
	if (circuit >= 0) {
		// The hop to the relay is dialed like any other address: a phone reaches a relay over a
		// WebSocket only, never plain TCP.
		if (!hasWebSocket(components.slice(0, circuit))) return null;
		return components.slice(circuit + 1).some(c => c.name === 'webrtc') ? 'webrtc' : 'relay';
	}
	if (!hasWebSocket(components)) return null;
	return hostKind(components[0]);
}

function hostKind(host: Component | undefined): CadronAddressKind | null {
	if (!host?.value) return null;
	if (DNS.has(host.name)) return host.value === 'localhost' ? 'loopback' : 'name';
	if (host.name === 'ip4') {
		if (host.value === '0.0.0.0') return null;
		if (host.value.startsWith('127.')) return 'loopback';
		return isPrivateIp4(host.value) ? 'private' : 'public';
	}
	if (host.name === 'ip6') {
		const ip = host.value.toLowerCase();
		if (ip === '::') return null;
		if (ip === '::1') return 'loopback';
		return isPrivateIp6(ip) ? 'private' : 'public';
	}
	return host.name === 'ip6zone' ? 'private' : null;
}

/** Reaches from anywhere: what an invitation should name. */
export function reachesAnywhere(kind: CadronAddressKind | null): boolean {
	return kind === 'name' || kind === 'public' || kind === 'relay' || kind === 'webrtc';
}

/** Best first for an invitation: a direct name or public address, then a relay, then WebRTC, then private. */
export const ADDRESS_KIND_RANK: Record<CadronAddressKind, number> = { name: 0, public: 0, relay: 1, webrtc: 2, private: 3, loopback: 4 };

/** `anywhere` when at least one address names a public IP or a DNS name, else `home-network`. */
export function nodeReach(multiaddrs: readonly string[]): NodeReach {
	return multiaddrs.some(isPublicAddress) ? 'anywhere' : 'home-network';
}

/**
 * The address's host is a DNS name or a public IP. The host is its first component, so a relayed
 * address is judged by its relay.
 */
export function isPublicAddress(addr: string): boolean {
	const kind = hostKind(addressComponents(addr)?.[0]);
	return kind === 'name' || kind === 'public';
}

function isPrivateIp4(ip: string): boolean {
	const o = ip.split('.').map(Number);
	if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparsable: not public
	const [a, b] = o;
	return a === 10 || a === 127 || a === 0
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 169 && b === 254)
		|| (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT, Tailscale
}

function isPrivateIp6(ip: string): boolean {
	if (ip.startsWith('::ffff:')) return isPrivateIp4(ip.slice(7));
	const first = parseInt(ip.split(':')[0] || '0', 16);
	return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
		|| (first & 0xffc0) === 0xfe80; // fe80::/10 link local
}
