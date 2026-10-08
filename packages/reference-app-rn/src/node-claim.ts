/**
 * node-claim.ts — read the code a cadre-host shows for a node waiting to be claimed, and
 * put a failed claim into words for the person holding the phone.
 *
 * The code is `sereus-join:1.<…>` (docs/cadre-host.md → "Join by QR code"); decoded, it is
 * what `CadreNode.claimNode` takes. No React and no native imports, so
 * `test/node-claim.spec.ts` runs these in Node.
 *
 * The code carries the node's claim secret: never log the code text or a decoded payload.
 * Log the peer id only.
 */

import { isPrivateIp } from '@libp2p/utils';
import {
	CODE_DNS,
	CODE_DNS4,
	CODE_DNS6,
	CODE_DNSADDR,
	CODE_IP4,
	CODE_IP6,
	CODE_IP6ZONE,
	multiaddr,
} from '@multiformats/multiaddr';
import {
	ClaimRefusedError,
	NODE_CLAIM_PAYLOAD_PREFIX,
	PeerUnreachableError,
	decodeNodeClaimPayload,
	type NodeClaimPayload,
} from '@serfab/cadre-core';

/** What every node code starts with, whatever its version. The scanner latches on it. */
export const NODE_CODE_SCHEME = 'sereus-join:';

/** A node code with a version this app does not read: `sereus-join:<n>.` with `n` not 1. */
const VERSIONED_NODE_CODE = /^sereus-join:(\d+)\./;

export type NodeCodeReading =
	| { ok: true; payload: NodeClaimPayload }
	| { ok: false; message: string; detail?: string };

/** Decode scanned or pasted text, or say in plain words why it is not a usable node code. */
export function readNodeCode(text: string): NodeCodeReading {
	const trimmed = text.trim();
	if (!trimmed.startsWith(NODE_CODE_SCHEME)) {
		return { ok: false, message: `That is not a node code from cadre-host. It starts with ${NODE_CODE_SCHEME}.` };
	}
	if (!trimmed.startsWith(NODE_CLAIM_PAYLOAD_PREFIX) && VERSIONED_NODE_CODE.test(trimmed)) {
		return { ok: false, message: 'This code comes from a newer cadre-host than this app understands. Update the app.' };
	}
	try {
		return { ok: true, payload: decodeNodeClaimPayload(trimmed) };
	} catch (err) {
		// The decoder never echoes the secret, so its message is safe to show.
		return {
			ok: false,
			message: 'This node code is damaged or incomplete. Scan it again, or copy the whole text.',
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Where the phone can reach the node from: `anywhere` when at least one address names a
 * public IP or a DNS name, else `home-network`.
 */
export type NodeReach = 'anywhere' | 'home-network';

export function nodeReach(multiaddrs: readonly string[]): NodeReach {
	return multiaddrs.some(isPublicAddress) ? 'anywhere' : 'home-network';
}

/**
 * The address's host is a DNS name or a public IP. The host is the first IP or DNS
 * component, so a relayed address is judged by its relay. `isPrivateIp` counts loopback,
 * link-local and 100.64.0.0/10 (shared address space, which Tailscale uses) as private, and
 * returns undefined only for text that is not an IP.
 *
 * NOTE: a global IPv6 address counts as public, though most home routers drop unsolicited
 * inbound IPv6. Hosted nodes listen on IPv4 only today; if they ever listen on IPv6 too, a
 * home-network-only code would read "reachable from anywhere" here.
 */
function isPublicAddress(addr: string): boolean {
	for (const { code, value } of multiaddr(addr).getComponents()) {
		switch (code) {
			case CODE_DNS:
			case CODE_DNS4:
			case CODE_DNS6:
			case CODE_DNSADDR:
				return true;
			case CODE_IP4:
			case CODE_IP6:
				return value !== undefined && isPrivateIp(value) === false;
			case CODE_IP6ZONE:
				// A zone names a local interface: only link-local addresses carry one.
				return false;
		}
	}
	return false;
}

/** The first 8 characters of an owner key: the form cadre-host shows as a claimed node's owner. */
export function ownerFingerprint(publicKeyB64: string): string {
	return publicKeyB64.slice(0, 8);
}

export interface ClaimFailureDescription {
	/** What to tell the person holding the phone. */
	message: string;
	/** The underlying error's own words, for bug reports. */
	detail?: string;
	/** Whether claiming again with the same code can succeed, so the app keeps it. */
	canRetrySameCode: boolean;
}

type RefusalCode = NonNullable<ClaimRefusedError['code']>;

/** Keyed by the error's own code type, so a code added to cadre-core fails typecheck here until it has words. */
const REFUSAL: Record<RefusalCode, Omit<ClaimFailureDescription, 'detail'>> = {
	'already-claimed': {
		message: 'This node already belongs to another cadre. On the machine, Reset the node to get a new code, and scan that.',
		canRetrySameCode: false,
	},
	'claim-proof-invalid': {
		message: 'The node did not accept this code. Scan the code the machine shows now; it changes when the node is reset.',
		canRetrySameCode: false,
	},
	'claim-rate-limited': {
		message: 'The node is refusing claims for a while after several wrong codes. Wait a minute, then try again.',
		canRetrySameCode: true,
	},
	'claim-not-persisted': {
		message: 'The node could not save its new owner. Check the machine\'s disk space, then try again.',
		canRetrySameCode: true,
	},
};

const UNREACHABLE: Record<NodeReach, string> = {
	'home-network': 'The node can only be reached on the machine\'s home network so far, and this phone could not reach it. '
		+ 'Connect to the same Wi-Fi as the machine and try again. '
		+ 'To reach it from anywhere, see Reachability on the machine\'s Join page.',
	anywhere: 'This phone could not reach the node at any of its addresses. Check that the machine is on and online. '
		+ 'On the same Wi-Fi, also check that the machine\'s firewall allows incoming connections.',
};

/** What to tell the user about `error`, thrown by claiming the node `payload` names. */
export function describeClaimFailure(error: unknown, payload: NodeClaimPayload): ClaimFailureDescription {
	const detail = error instanceof Error ? error.message : String(error);
	if (error instanceof PeerUnreachableError) {
		return { message: UNREACHABLE[nodeReach(payload.multiaddrs)], detail, canRetrySameCode: true };
	}
	if (error instanceof ClaimRefusedError) {
		// The code arrives over the wire, so a newer node may send one this build has no words for.
		const known = error.code ? REFUSAL[error.code] : undefined;
		return known
			? { ...known, detail }
			: { message: 'The node refused to join this cadre.', detail: error.reason, canRetrySameCode: false };
	}
	// Reached, then the exchange or a local step failed. The node accepts a repeat claim from
	// the same owner, so the same code is safe to send again.
	return { message: 'Adding the node did not finish. Trying again with the same code is safe.', detail, canRetrySameCode: true };
}
