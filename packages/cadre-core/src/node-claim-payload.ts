/**
 * The claim payload: what a host shows as a QR code (and as text) for a node that is
 * waiting to be claimed, and what the owner's phone scans to claim it.
 *
 * `sereus-join:1.<base64url of canonical JSON>` where the JSON is
 * `{ multiaddrs, peerId, secret }`: the node's peer id, every address the phone may
 * dial it at (each ending in `/p2p/<peerId>`), and the node's one-time claim secret
 * (`claim-proof.ts`). The phone hands all three to `CadreNode.claimNode`. The payload
 * carries no party id: the claim supplies it, and the node records it.
 *
 * The decoder lives here, beside the encoder, because the phone and the host both need
 * it and neither depends on the other. Imports only `@multiformats/multiaddr`,
 * `@libp2p/peer-id` and `uint8arrays`, so it loads on React Native and in the browser.
 */
import { peerIdFromString } from '@libp2p/peer-id';
import {
	multiaddr,
	CODE_DNS,
	CODE_DNS4,
	CODE_DNS6,
	CODE_DNSADDR,
	CODE_IP4,
	CODE_IP6,
	CODE_IP6ZONE,
	CODE_P2P,
	CODE_P2P_CIRCUIT,
	CODE_WS,
	CODE_WSS,
} from '@multiformats/multiaddr';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { canonicalJson } from './canonical-json.js';
import { parseClaimSecret } from './claim-proof.js';

/** Version 1 of the payload; the only one either side reads. */
export const NODE_CLAIM_PAYLOAD_PREFIX = 'sereus-join:1.';

export interface NodeClaimPayload {
	/** The node's peer id. */
	peerId: string;
	/** Addresses the phone may dial the node at, each ending in `/p2p/<peerId>`. */
	multiaddrs: string[];
	/** The node's claim secret, base64url (`parseClaimSecret`). */
	secret: string;
}

/** Encode a payload as the text the host shows. Refuses what {@link decodeNodeClaimPayload} would. */
export function encodeNodeClaimPayload(payload: NodeClaimPayload): string {
	const checked = requireNodeClaimPayload(payload);
	const json = canonicalJson({ multiaddrs: checked.multiaddrs, peerId: checked.peerId, secret: checked.secret });
	return `${NODE_CLAIM_PAYLOAD_PREFIX}${uint8ArrayToString(new TextEncoder().encode(json), 'base64url')}`;
}

/**
 * Decode the text a phone scanned or pasted. Refuses, naming the problem: any version but
 * 1, a body that is not base64url JSON of the right shape, a peer id that does not parse,
 * an empty address list, an address that does not parse or whose last `/p2p/` is not that
 * peer id, and a secret {@link parseClaimSecret} refuses. The secret is never echoed.
 */
export function decodeNodeClaimPayload(text: string): NodeClaimPayload {
	const trimmed = text.trim();
	if (!trimmed.startsWith(NODE_CLAIM_PAYLOAD_PREFIX)) {
		throw new Error(`A claim payload must start with "${NODE_CLAIM_PAYLOAD_PREFIX}" (this one starts with "${trimmed.slice(0, NODE_CLAIM_PAYLOAD_PREFIX.length)}")`);
	}
	let parsed: unknown;
	try {
		const json = new TextDecoder().decode(uint8ArrayFromString(trimmed.slice(NODE_CLAIM_PAYLOAD_PREFIX.length), 'base64url'));
		parsed = JSON.parse(json);
	} catch (error) {
		throw new Error('A claim payload must carry base64url-encoded JSON after its prefix', { cause: error });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('A claim payload must decode to a JSON object');
	}
	const { peerId, multiaddrs, secret } = parsed as Record<string, unknown>;
	if (typeof peerId !== 'string') throw new Error('A claim payload must name the node\'s peer id');
	if (!Array.isArray(multiaddrs) || !multiaddrs.every((a): a is string => typeof a === 'string')) {
		throw new Error('A claim payload must carry the node\'s addresses as a list of strings');
	}
	if (typeof secret !== 'string') throw new Error('A claim payload must carry the claim secret');
	return requireNodeClaimPayload({ peerId, multiaddrs, secret });
}

/** How {@link selectNodeClaimAddresses} narrows a node's addresses. */
export interface NodeClaimAddressOptions {
	/**
	 * The machine's LAN address, the one a phone at home reaches it on. A string keeps only
	 * the private addresses on that IP (dropping Docker bridges, VPN and other interfaces no
	 * phone can reach); `null` drops every private address (a machine reached only by its
	 * public name); absent keeps them all, for a caller that cannot tell.
	 */
	lan?: string | null;
	/** Keep addresses a phone cannot dial: plain TCP. Default false, since phones dial WebSocket and relay only. */
	includeTcp?: boolean;
}

/**
 * The addresses a node code should carry, from the ones a node knows it has (`/status`,
 * a NAT layer's public addresses). A phone dials them in turn, each on its own timeout, so
 * every address it cannot reach only delays a failing claim, and makes the QR code bigger.
 *
 * - Each gains `/p2p/<peerId>` when it lacks a destination; loopback, unspecified and
 *   unparsable ones are dropped, and so is plain TCP unless `includeTcp`.
 * - Public names (`/dns*`) come first: they work away from home. Public IP addresses are
 *   kept only when there is no public name, since they reach the same machine.
 * - Private addresses follow, narrowed by {@link NodeClaimAddressOptions.lan}; relay
 *   addresses last.
 *
 * Pure and dependency-light, like the codec beside it, so it loads on React Native too.
 * Finding the LAN address is the caller's (Node: `@serfab/cadre-core/primary-lan-address`).
 */
export function selectNodeClaimAddresses(reported: readonly string[], peerId: string, options: NodeClaimAddressOptions = {}): string[] {
	const names: string[] = [];
	const publicIps: string[] = [];
	const privates: string[] = [];
	const relayed: string[] = [];
	for (const raw of reported) {
		const classified = classifyClaimAddress(raw.trim(), peerId, options);
		if (!classified) continue;
		({ name: names, public: publicIps, private: privates, relay: relayed })[classified.kind].push(classified.addr);
	}
	return [...new Set([...names, ...(names.length > 0 ? [] : publicIps), ...privates, ...relayed])];
}

/**
 * `addr` as a node code carries it: with `/p2p/<peerId>` appended unless it already names a
 * destination. A relay address that ends at its hop (`…/p2p/<relay>/p2p-circuit`) names none,
 * so it gains the node's id too. Throws when `addr` does not parse. For callers that take
 * exact addresses from an operator; {@link selectNodeClaimAddresses} applies it itself.
 */
export function withClaimDestination(addr: string, peerId: string): string {
	const trimmed = addr.trim();
	return destinationPeerIdOf(trimmed) === null ? `${trimmed}/p2p/${peerId}` : trimmed;
}

/**
 * Where a phone could dial an address from: a relayed address (`/p2p-circuit`), a public name,
 * a public IP, a private (LAN, VPN, link-local) IP, or this machine's own loopback.
 */
export type DialAddressKind = 'relay' | 'name' | 'public' | 'private' | 'loopback';

/**
 * Classify `addr` for a phone dialing it, or undefined when no phone can dial it at all: it
 * does not parse, names the unspecified address, or is plain TCP without `includeTcp` (phones
 * dial WebSocket and relay only).
 */
export function classifyDialAddress(addr: string, options: { includeTcp?: boolean } = {}): DialAddressKind | undefined {
	const components = componentsOf(addr);
	return components ? classifyComponents(components, options.includeTcp ?? false)?.kind : undefined;
}

type AddressComponents = ReturnType<ReturnType<typeof multiaddr>['getComponents']>;

function componentsOf(addr: string): AddressComponents | undefined {
	try {
		return multiaddr(addr).getComponents();
	} catch {
		return undefined;
	}
}

/** {@link classifyDialAddress}, keeping the IP for a caller that narrows private addresses by it. */
function classifyComponents(components: AddressComponents, includeTcp: boolean): { kind: DialAddressKind; ip?: string } | undefined {
	if (components.some((c) => c.code === CODE_P2P_CIRCUIT)) return { kind: 'relay' };
	if (!includeTcp && !components.some((c) => c.code === CODE_WS || c.code === CODE_WSS)) return undefined;
	const host = components[0];
	if (!host?.value) return undefined;
	if (host.code === CODE_DNS || host.code === CODE_DNS4 || host.code === CODE_DNS6 || host.code === CODE_DNSADDR) {
		return { kind: host.value === 'localhost' ? 'loopback' : 'name' };
	}
	if (host.code !== CODE_IP4 && host.code !== CODE_IP6 && host.code !== CODE_IP6ZONE) return undefined;
	const ip = host.code === CODE_IP6ZONE ? components[1]?.value ?? '' : host.value;
	if (ip === '0.0.0.0' || ip === '::') return undefined;
	if (ip.startsWith('127.') || ip === '::1') return { kind: 'loopback', ip };
	if (host.code !== CODE_IP6ZONE && !isPrivateIp(ip)) return { kind: 'public', ip };
	return { kind: 'private', ip };
}

/** One address's place in {@link selectNodeClaimAddresses}, or undefined to drop it. */
function classifyClaimAddress(addr: string, peerId: string, options: NodeClaimAddressOptions): { kind: Exclude<DialAddressKind, 'loopback'>; addr: string } | undefined {
	const components = componentsOf(addr);
	if (!components) return undefined;
	const classified = classifyComponents(components, options.includeTcp ?? false);
	if (!classified || classified.kind === 'loopback') return undefined;
	if (classified.kind === 'private' && (options.lan === null || (options.lan !== undefined && classified.ip !== options.lan))) {
		return undefined;
	}
	return { kind: classified.kind, addr: destinationIn(components) === null ? `${addr}/p2p/${peerId}` : addr };
}

/** RFC 1918, carrier-grade NAT (100.64/10), link-local, and IPv6 unique-local / link-local. */
function isPrivateIp(ip: string): boolean {
	if (ip.includes(':')) return /^(f[cd]|fe[89ab])/i.test(ip);
	const [a, b] = ip.split('.').map(Number) as [number, number];
	return a === 10
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168)
		|| (a === 169 && b === 254)
		|| (a === 100 && b >= 64 && b <= 127);
}

/** The shape rules both directions apply. Returns the payload with its fields trimmed. */
function requireNodeClaimPayload(payload: NodeClaimPayload): NodeClaimPayload {
	const peerId = parsePeerId(payload.peerId);
	const multiaddrs = payload.multiaddrs.map((a) => a.trim());
	if (multiaddrs.length === 0) throw new Error('A claim payload must carry at least one address for the node');
	for (const addr of multiaddrs) requireAddressOf(addr, peerId);
	// The secret is checked, never kept in a message: see `parseClaimSecret`.
	parseClaimSecret(payload.secret);
	return { peerId: peerId.toString(), multiaddrs, secret: payload.secret.trim() };
}

function parsePeerId(text: string): ReturnType<typeof peerIdFromString> {
	try {
		return peerIdFromString(text.trim());
	} catch (error) {
		throw new Error(`A claim payload's peer id does not parse ("${text}")`, { cause: error });
	}
}

/** `addr` parses, and its destination (the last `/p2p/`, past any relay hop) is `peerId`. */
function requireAddressOf(addr: string, peerId: ReturnType<typeof peerIdFromString>): void {
	let destination: string | null;
	try {
		destination = destinationPeerIdOf(addr);
	} catch (error) {
		throw new Error(`A claim payload address does not parse ("${addr}")`, { cause: error });
	}
	if (destination === null) {
		throw new Error(`A claim payload address must end in /p2p/${peerId.toString()} ("${addr}" names no peer)`);
	}
	let named: ReturnType<typeof peerIdFromString>;
	try {
		named = peerIdFromString(destination);
	} catch (error) {
		throw new Error(`A claim payload address names a peer id that does not parse ("${addr}")`, { cause: error });
	}
	if (!named.equals(peerId)) {
		throw new Error(`A claim payload address names another peer ("${addr}" is not an address of ${peerId.toString()})`);
	}
}

/**
 * The peer an address reaches: its last `/p2p/` component. A relayed address
 * (`…/p2p/<relay>/p2p-circuit/p2p/<destination>`) names its destination after the
 * circuit hop; one that ends at the hop names nobody. Same rule as
 * `groupAddrsByPeerId` in `peer-addr-book.ts`. Throws when `addr` does not parse.
 */
export function destinationPeerIdOf(addr: string): string | null {
	return destinationIn(multiaddr(addr).getComponents());
}

function destinationIn(components: AddressComponents): string | null {
	for (let i = components.length - 1; i >= 0; i--) {
		const component = components[i]!;
		if (component.code === CODE_P2P_CIRCUIT) return null;
		if (component.code === CODE_P2P && component.value) return component.value;
	}
	return null;
}
