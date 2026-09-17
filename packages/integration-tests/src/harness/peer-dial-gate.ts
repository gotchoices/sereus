/**
 * A connection gater that denies outbound dials to a changeable set of peers,
 * for scenarios that must prove WHICH component opened a connection. Production
 * subsystems dial addressed peers on their own (FRET announces, Optimystic
 * cluster clients), so "nothing else knew the address" cannot be relied on;
 * denying the dial can.
 *
 * Covers both paths libp2p's dial queue consults — `denyDialPeer` on the
 * peer-id path and `denyDialMultiaddr` on the per-address path — plus
 * `denyOutboundConnection` at the upgrader, which also catches a dial that
 * started while the peer was allowed and finishes after it is denied again.
 * A connection that is already open is never touched: libp2p reuses it without
 * consulting the gater.
 */

import type { ConnectionGater } from '@libp2p/interface';

export interface PeerDialGate {
	/** Pass as `network.connectionGater` (cadre-core composes it under its membership gate). */
	gater: ConnectionGater;
	/** Deny every future dial to `peerId`. Idempotent. */
	deny(peerId: string): void;
	/** Stop denying dials to `peerId`. Idempotent. */
	allow(peerId: string): void;
	/**
	 * Gater checks denied for `peerId` so far. One dial is checked several times
	 * (per peer, per address, at the upgrader), so this counts checks, not dials.
	 */
	deniedCount(peerId: string): number;
}

/** A {@link PeerDialGate} that denies nothing until {@link PeerDialGate.deny} is called. */
export function peerDialGate(): PeerDialGate {
	const denied = new Set<string>();
	const denials = new Map<string, number>();
	const check = (peerId: string | undefined): boolean => {
		if (peerId === undefined || !denied.has(peerId)) return false;
		denials.set(peerId, (denials.get(peerId) ?? 0) + 1);
		return true;
	};
	return {
		gater: {
			denyDialPeer: (peerId) => check(peerId.toString()),
			// The dial target is the LAST p2p component (earlier ones name relays).
			denyDialMultiaddr: (ma) => check(ma.getComponents().filter((c) => c.name === 'p2p').pop()?.value),
			denyOutboundConnection: (peerId, _maConn) => check(peerId.toString())
		},
		deny: (peerId) => { denied.add(peerId); },
		allow: (peerId) => { denied.delete(peerId); },
		deniedCount: (peerId) => denials.get(peerId) ?? 0
	};
}
