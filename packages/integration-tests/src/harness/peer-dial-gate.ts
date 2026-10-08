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
 *
 * With `inbound: true` the gate also refuses inbound connections from a denied
 * peer (`denyInboundEncryptedConnection`), so one side can sever a pair in both
 * directions. The denied dialer may see its connection open and close a moment
 * later: the refusal runs after its upgrade completes (see the composition notes
 * in cadre-core's `membership-connection-gater.ts`).
 */

import type { ConnectionGater } from '@libp2p/interface';

export interface PeerDialGate {
	/** Pass as `network.connectionGater` (cadre-core composes it under its membership gate). */
	gater: ConnectionGater;
	/** Deny every future dial to `peerId` (and, with `inbound`, every connection from it). Idempotent. */
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
export function peerDialGate(options: { inbound?: boolean } = {}): PeerDialGate {
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
			denyOutboundConnection: (peerId, _maConn) => check(peerId.toString()),
			...(options.inbound ? { denyInboundEncryptedConnection: (peerId, _maConn) => check(peerId.toString()) } : {})
		},
		deny: (peerId) => { denied.add(peerId); },
		allow: (peerId) => { denied.delete(peerId); },
		deniedCount: (peerId) => denials.get(peerId) ?? 0
	};
}
