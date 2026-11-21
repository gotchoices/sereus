/**
 * Which of the inviting party's machines an invitation names, so a joiner can still form or
 * join while the machine that minted it is offline: an open strand invitation
 * (`CadreNode.createOpenInvitation`, which puts the minting machine's own addresses first
 * itself) and a cadre invitation ({@link selectCadreInvitationMembers}). Also how far a cadre
 * invitation reaches once its minting machine is gone ({@link cadreInvitationReach}).
 */

import { classifyDialAddress, destinationPeerIdOf, type DialAddressKind } from './node-claim-payload.js';
import type { CadreInvitationReach } from './types.js';

/**
 * At most this many of the party's other machines are named, each with at most
 * {@link INVITATION_ADDRS_PER_SIBLING} addresses: 12 extra addresses of roughly 100–200
 * characters, base64url-encoded into an invitation shared as text.
 *
 * NOTE: a cadre invitation, which may be carried in a QR code, is capped harder
 * ({@link CADRE_INVITATION_MAX_ADDRS}); an open strand invitation keeps these caps. If open
 * invitations are ever carried in a QR code too, cap them the same way.
 * NOTE: for an open strand invitation the per-machine cap keeps the record's order (relayed
 * first, then direct addresses as the machine published them, loopback included, then any that
 * needs ICE after its relay hop — `orderRelayedFirst` in `peer-record.ts`); a cadre invitation
 * ranks them itself. If an open invitation's sibling is seen to have its reachable address cut,
 * rank the same way.
 */
export const INVITATION_SIBLING_MACHINES = 3;
export const INVITATION_ADDRS_PER_SIBLING = 4;

/**
 * Most addresses a cadre invitation names in total, so its text fits one QR code. Measured
 * with three owner keys: 2,206 characters encoded at 6 relayed addresses of about 155
 * characters (the worst case, since ranking puts relayed addresses first), 1,972 with relayed
 * and direct WebSocket addresses alternating, against 2,331 bytes in the largest QR code at
 * error-correction level M (2,953 at L). Each further address costs about 170 characters, each
 * further owner key about 60.
 *
 * What the cap drops first follows from {@link PHONE_DIAL_RANK}: a machine's WebRTC address
 * goes before its plain relayed one, because a WebRTC address connects only if ICE finds a path
 * between the two networks — the case an invitation exists to cover is the one where it does
 * not.
 */
export const CADRE_INVITATION_MAX_ADDRS = 6;

/** Most addresses a cadre invitation names for each of the party's other machines. */
export const CADRE_INVITATION_ADDRS_PER_SIBLING = 2;

/** One other machine of the party whose signed address record resolved. */
export interface InvitationSibling {
	peerId: string;
	/** The record's `UpdatedAt`: when the machine last published its addresses. */
	updatedAt: number;
	/** As the machine's record carries them — relayed first, WebRTC last — each ending in `/p2p/<peerId>`. */
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
 * each), the whole list cut to {@link CADRE_INVITATION_MAX_ADDRS}. Each machine's addresses are
 * ranked for a phone before they are cut ({@link rankForPhone}): libp2p reports a machine
 * listening on every interface with its loopback and private addresses ahead of its relayed one.
 *
 * NOTE: accepted tradeoff — with two or more other machines, only the best two addresses of
 * each survive, connected machines first, so a reachable address of a sibling can be cut. Size
 * was weighed over completeness, so the text fits a QR code; revisit if redemptions are seen
 * failing for want of a sibling address the record held. The decision stands; what has changed
 * since it was taken is which address the cap cuts — {@link PHONE_DIAL_RANK} now ranks a
 * machine's WebRTC address below its plain relayed one, so the cap drops the WebRTC address
 * first and a machine offering WebRTC no longer fills half an invitation with addresses that
 * connect only when ICE finds a path.
 *
 * NOTE: the ranking is per machine, and the machines keep their own order (the minting one, then
 * siblings by how likely each is to be up), so the minting machine's WebRTC address can still
 * sit ahead of a sibling's relayed one. A redeemer dials the list in order, so when the minting
 * machine is down that costs about 23 s before the siblings are tried. Left as is because the
 * machine order carries information an address-kind sort would discard; if redemptions are seen
 * paying that, interleave every machine's relayed addresses ahead of any WebRTC one.
 */
export function selectCadreInvitationMembers(
	own: readonly string[],
	siblings: InvitationSibling[],
	connected: ReadonlySet<string>
): string[] {
	const ranked = siblings.map((sibling) => ({ ...sibling, addrs: rankForPhone(sibling.addrs) }));
	return [
		...rankForPhone(own).slice(0, INVITATION_ADDRS_PER_SIBLING),
		...selectInvitationSiblingAddrs(ranked, connected, CADRE_INVITATION_ADDRS_PER_SIBLING),
	].slice(0, CADRE_INVITATION_MAX_ADDRS);
}

/**
 * How widely a phone can reach an address: from anywhere, from anywhere when ICE finds a path,
 * on its own network, on that machine alone, not at all.
 *
 * `webrtc` sits between the kinds that reach from anywhere and the LAN-only ones on that one
 * axis: the relay carries its signalling from any network, but the connection opens only if ICE
 * finds a path between the two networks, which is less than always and more than one network
 * only. See `docs/network/relay.md` → "Direct connections over WebRTC".
 */
const PHONE_DIAL_RANK: Record<DialAddressKind, number> = { relay: 0, name: 0, public: 0, webrtc: 1, private: 2, loopback: 3 };

/** Rank of an address no phone can dial at all (plain TCP), so it sorts behind every classified kind. */
const PHONE_DIAL_RANK_UNREACHABLE = Math.max(...Object.values(PHONE_DIAL_RANK)) + 1;

/** `addrs` best first for a phone dialing them ({@link PHONE_DIAL_RANK}), ties in their given order; one a phone cannot dial (plain TCP) last. */
function rankForPhone(addrs: readonly string[]): string[] {
	const rankOf = (addr: string): number => {
		const kind = classifyDialAddress(addr);
		return kind === undefined ? PHONE_DIAL_RANK_UNREACHABLE : PHONE_DIAL_RANK[kind];
	};
	return addrs.map((addr) => ({ addr, rank: rankOf(addr) })).sort((a, b) => a.rank - b.rank).map(({ addr }) => addr);
}

/**
 * Where a phone could redeem an invitation naming `members` from, judged on the machines other
 * than `issuerPeerId`: in the app flows the minting app is the one closed or in the background
 * when the other app redeems, and two apps on one phone cannot reach each other. An address
 * names its machine by its last `/p2p/`.
 *
 * The three answers are about network scope, so a WebRTC address counts as `anywhere` alongside
 * `relay`, `name` and `public`: it is not a local-network address, and its relay carries its
 * signalling from any network. Whether ICE then finds a path is a separate matter this does not
 * judge — and since {@link PHONE_DIAL_RANK} ranks a WebRTC address below the plain relayed one,
 * such an address takes a slot only once every relayed address of that machine already has one.
 */
export function cadreInvitationReach(members: readonly string[], issuerPeerId: string): CadreInvitationReach {
	const others = members.flatMap((addr) => {
		const kind = classifyDialAddress(addr);
		// Classified, so it parses and `destinationPeerIdOf` cannot throw.
		return kind === undefined || destinationPeerIdOf(addr) === issuerPeerId ? [] : [kind];
	});
	if (others.some((kind) => kind === 'relay' || kind === 'webrtc' || kind === 'name' || kind === 'public')) return 'anywhere';
	return others.length > 0 ? 'local-network' : 'issuer-only';
}
