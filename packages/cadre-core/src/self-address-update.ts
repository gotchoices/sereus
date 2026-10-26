import type { PeerUpdate } from '@libp2p/interface';

/**
 * Whether a libp2p `self:peer:update` changed the node's own addresses — the only part of
 * the update the self record (`CadrePeer.Multiaddr`) carries.
 *
 * libp2p emits the event for any change to the node's own peer-store entry, and registering
 * or unregistering a protocol handler is one (the registrar merges the node's protocol list).
 * Cadre registers handlers on a running control node (member redemption, strand formation,
 * the seed listener), so reacting to every event would make each of those a consensus write
 * of an unchanged record, racing whatever write the cohort is making to `CadrePeer` at the
 * time. An update with no `previous` is treated as a change: there is nothing to compare.
 */
export function selfAddressesChanged(update: PeerUpdate): boolean {
	if (update.previous === undefined) return true;
	const before = new Set(update.previous.addresses.map((address) => address.multiaddr.toString()));
	const after = update.peer.addresses.map((address) => address.multiaddr.toString());
	return after.length !== before.size || after.some((address) => !before.has(address));
}
