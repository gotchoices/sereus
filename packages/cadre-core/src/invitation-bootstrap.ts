/**
 * Which of the inviting party's other machines an open invitation names, so a joiner can still
 * form while the machine that minted it is offline. The minting machine's own addresses go
 * first and are not chosen here (`CadreNode.createOpenInvitation`).
 */

/**
 * At most this many of the party's other machines are named, each with at most
 * {@link INVITATION_ADDRS_PER_SIBLING} addresses: 12 extra addresses of roughly 100–200
 * characters, base64url-encoded into an invitation shared as text.
 *
 * NOTE: if invitations are ever carried in a QR code, lower these caps or name the machines by
 * peer id only.
 * NOTE: the per-machine cap keeps the record's order (relay first, then direct addresses as the
 * machine published them, loopback included). If a sibling with many interfaces is seen to have
 * its reachable address cut, rank loopback and private addresses last before slicing.
 */
export const INVITATION_SIBLING_MACHINES = 3;
export const INVITATION_ADDRS_PER_SIBLING = 4;

/** One other machine of the party whose signed address record resolved. */
export interface InvitationSibling {
	peerId: string;
	/** The record's `UpdatedAt`: when the machine last published its addresses. */
	updatedAt: number;
	/** Relay (signaling) addresses first, each ending in `/p2p/<peerId>`. */
	addrs: string[];
}

/**
 * The addresses of the siblings an invitation names. Machines this node is connected to right
 * now come first, since a live connection is the best evidence that a machine is up; a record
 * shows only that it was up within the freshness window. Within each half, newest record first.
 */
export function selectInvitationSiblingAddrs(siblings: InvitationSibling[], connected: ReadonlySet<string>): string[] {
	return [...siblings]
		.sort((a, b) => Number(connected.has(b.peerId)) - Number(connected.has(a.peerId)) || b.updatedAt - a.updatedAt)
		.slice(0, INVITATION_SIBLING_MACHINES)
		.flatMap((sibling) => sibling.addrs.slice(0, INVITATION_ADDRS_PER_SIBLING));
}
