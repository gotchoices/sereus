/**
 * Which of the inviting party's machines an invitation names, so a joiner can still form or
 * join while the machine that minted it is offline: an open strand invitation
 * (`CadreNode.createOpenInvitation`, which puts the minting machine's own addresses first
 * itself) and a cadre invitation ({@link selectCadreInvitationMembers}). Also how far a cadre
 * invitation reaches once its minting machine is gone ({@link cadreInvitationReach}).
 */

import { classifyDialAddress, destinationPeerIdOf } from './node-claim-payload.js';
import type { CadreInvitationReach } from './types.js';

/**
 * At most this many of the party's other machines are named, each with at most
 * {@link INVITATION_ADDRS_PER_SIBLING} addresses: 12 extra addresses of roughly 100–200
 * characters, base64url-encoded into an invitation shared as text.
 *
 * NOTE: a cadre invitation, which may be carried in a QR code, is capped harder
 * ({@link CADRE_INVITATION_MAX_ADDRS}); an open strand invitation keeps these caps. If open
 * invitations are ever carried in a QR code too, cap them the same way.
 * NOTE: the per-machine cap keeps the record's order (relay first, then direct addresses as the
 * machine published them, loopback included). If a sibling with many interfaces is seen to have
 * its reachable address cut, rank loopback and private addresses last before slicing.
 */
export const INVITATION_SIBLING_MACHINES = 3;
export const INVITATION_ADDRS_PER_SIBLING = 4;

/**
 * Most addresses a cadre invitation names in total, so its text fits one QR code. Measured
 * with relay addresses of about 150 characters and direct WebSocket addresses of about 85,
 * alternating, and three owner keys: 1,972 characters encoded at 6 addresses, against 2,953
 * bytes in the largest QR code at error-correction level L. Each further address costs about
 * 170 characters, each further owner key about 60.
 */
export const CADRE_INVITATION_MAX_ADDRS = 6;

/** Most addresses a cadre invitation names for each of the party's other machines. */
export const CADRE_INVITATION_ADDRS_PER_SIBLING = 2;

/** One other machine of the party whose signed address record resolved. */
export interface InvitationSibling {
	peerId: string;
	/** The record's `UpdatedAt`: when the machine last published its addresses. */
	updatedAt: number;
	/** Relay (signaling) addresses first, each ending in `/p2p/<peerId>`. */
	addrs: string[];
}

/**
 * The addresses of the siblings an invitation names, at most `perSibling` each. Machines this
 * node is connected to right now come first, since a live connection is the best evidence that
 * a machine is up; a record shows only that it was up within the freshness window. Within each
 * half, newest record first.
 */
export function selectInvitationSiblingAddrs(
	siblings: InvitationSibling[],
	connected: ReadonlySet<string>,
	perSibling: number = INVITATION_ADDRS_PER_SIBLING
): string[] {
	return [...siblings]
		.sort((a, b) => Number(connected.has(b.peerId)) - Number(connected.has(a.peerId)) || b.updatedAt - a.updatedAt)
		.slice(0, INVITATION_SIBLING_MACHINES)
		.flatMap((sibling) => sibling.addrs.slice(0, perSibling));
}

/**
 * The `members` of a cadre invitation: the minting machine's own addresses first (at most
 * {@link INVITATION_ADDRS_PER_SIBLING}), then the other machines' in
 * {@link selectInvitationSiblingAddrs} order (at most {@link CADRE_INVITATION_ADDRS_PER_SIBLING}
 * each), the whole list cut to {@link CADRE_INVITATION_MAX_ADDRS}.
 *
 * NOTE: accepted tradeoff — with two or more other machines, only the first two addresses of
 * each survive, connected machines first, so a reachable address of a sibling can be cut. Size
 * was weighed over completeness, so the text fits a QR code; revisit if redemptions are seen
 * failing for want of a sibling address the record held.
 */
export function selectCadreInvitationMembers(
	own: readonly string[],
	siblings: InvitationSibling[],
	connected: ReadonlySet<string>
): string[] {
	return [
		...own.slice(0, INVITATION_ADDRS_PER_SIBLING),
		...selectInvitationSiblingAddrs(siblings, connected, CADRE_INVITATION_ADDRS_PER_SIBLING),
	].slice(0, CADRE_INVITATION_MAX_ADDRS);
}

/**
 * Where a phone could redeem an invitation naming `members` from, judged on the machines other
 * than `issuerPeerId`: in the app flows the minting app is the one closed or in the background
 * when the other app redeems, and two apps on one phone cannot reach each other. An address
 * names its machine by its last `/p2p/`.
 */
export function cadreInvitationReach(members: readonly string[], issuerPeerId: string): CadreInvitationReach {
	const others = members.flatMap((addr) => {
		const kind = classifyDialAddress(addr);
		// Classified, so it parses and `destinationPeerIdOf` cannot throw.
		return kind === undefined || destinationPeerIdOf(addr) === issuerPeerId ? [] : [kind];
	});
	if (others.some((kind) => kind === 'relay' || kind === 'name' || kind === 'public')) return 'anywhere';
	return others.length > 0 ? 'local-network' : 'issuer-only';
}
