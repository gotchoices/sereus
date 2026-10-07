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
import { multiaddr, CODE_P2P, CODE_P2P_CIRCUIT } from '@multiformats/multiaddr';
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
 * `groupAddrsByPeerId` in `peer-addr-book.ts`.
 */
function destinationPeerIdOf(addr: string): string | null {
	const components = multiaddr(addr).getComponents();
	for (let i = components.length - 1; i >= 0; i--) {
		const component = components[i]!;
		if (component.code === CODE_P2P_CIRCUIT) return null;
		if (component.code === CODE_P2P && component.value) return component.value;
	}
	return null;
}
