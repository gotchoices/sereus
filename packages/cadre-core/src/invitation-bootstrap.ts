/**
 * Which of the inviting party's machines an invitation names, and in what order, so a joiner
 * can still form or join while the machine that minted it is offline: an open strand
 * invitation ({@link selectOpenInvitationBootstrap}) and a cadre invitation
 * ({@link selectCadreInvitationMembers}). Both rank the machines the same way and differ only in
 * their caps. Also how far a cadre invitation reaches once its minting machine is gone
 * ({@link cadreInvitationReach}). See `docs/strands/formation.md` → "Which machines an
 * invitation names".
 */

import type { Connection } from '@libp2p/interface';
import { classifyDialAddress, destinationPeerIdOf, type DialAddressKind } from './node-claim-payload.js';
import { addrKind } from './peer-dial.js';
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

/**
 * What this node's own connections to a machine show about reaching it when the invitation is
 * redeemed: `2` when it accepts a plain dial ({@link invitationReachability}), `1` when connected
 * in any other way, `0` when not connected.
 */
export type InvitationReachability = 0 | 1 | 2;

/** One other machine of the party whose signed address record resolved, with the evidence it is ranked by. */
export interface InvitationSibling {
	peerId: string;
	/** The record's `UpdatedAt`: when the machine last published its addresses. */
	updatedAt: number;
	/** As the machine's record carries them — relayed first, WebRTC last — each ending in `/p2p/<peerId>`. */
	addrs: string[];
	/** The machine's own signed declaration that it is always on (its `CadrePeer.Profile`); a row without one is not. */
	alwaysOn: boolean;
	reachability: InvitationReachability;
	/** How long this node has itself watched the machine stay up (FRET's tenure, never gossiped), in ms; 0 when unknown. */
	tenureMs: number;
}

/** The machine minting the invitation. */
export interface InvitationSelf {
	/** Its own addresses, in the order the caller holds them. */
	addrs: readonly string[];
	/** Its own class (`NodeRoles.alwaysOn`). */
	alwaysOn: boolean;
}

/** The slice of a libp2p connection {@link invitationReachability} reads. */
export type ReachabilityEvidence = Pick<Connection, 'direction' | 'remoteAddr' | 'limits'>;

/**
 * The {@link InvitationReachability} of a machine this node holds `connections` to. Only a
 * connection this node opened with no relay hop and no relay's limits counts as showing the
 * machine accepts a plain dial. `addrKind` reads a WebRTC connection as `webrtc`, because libp2p
 * gives it the `/p2p-circuit/webrtc` address that was dialled, so it does not count: ICE may have
 * punched a hole the redeemer's network will not get.
 */
export function invitationReachability(connections: readonly ReachabilityEvidence[]): InvitationReachability {
	const acceptsPlainDial = (connection: ReachabilityEvidence): boolean =>
		connection.direction === 'outbound' && connection.limits === undefined && addrKind(connection.remoteAddr) === 'direct';
	if (connections.some(acceptsPlainDial)) return 2;
	return connections.length > 0 ? 1 : 0;
}

/** The caps one kind of invitation applies to the shared machine order. */
interface InvitationCaps {
	/** Addresses the minting machine contributes when it is named first. */
	ownAddrs: number;
	perSibling: number;
	total: number;
	/** How one machine's addresses are ordered before its cap cuts them. */
	orderAddrs: (addrs: readonly string[]) => string[];
}

/** A machine the selection names, with its addresses already ordered and cut to its cap. */
interface NamedMachine {
	alwaysOn: boolean;
	addrs: string[];
}

/**
 * The `members` of a cadre invitation, in {@link selectInvitationAddrs} order: at most
 * {@link INVITATION_ADDRS_PER_SIBLING} of the minting machine's addresses when it is named
 * first, at most {@link CADRE_INVITATION_ADDRS_PER_SIBLING} of each other machine's, the whole
 * list cut to {@link CADRE_INVITATION_MAX_ADDRS}. Each machine's addresses are ranked for a phone
 * before they are cut ({@link rankForPhone}): libp2p reports a machine listening on every
 * interface with its loopback and private addresses ahead of its relayed one.
 *
 * NOTE: accepted tradeoff — with two or more other machines, only the best two addresses of
 * each survive, so a reachable address of a sibling can be cut. Size was weighed over
 * completeness, so the text fits a QR code; revisit if redemptions are seen failing for want of
 * a sibling address the record held. The decision stands; what has changed since it was taken
 * is which address the cap cuts — {@link PHONE_DIAL_RANK} now ranks a machine's WebRTC address
 * below its plain relayed one, so the cap drops the WebRTC address first and a machine offering
 * WebRTC no longer fills half an invitation with addresses that connect only when ICE finds a
 * path.
 *
 * NOTE: the ranking is per machine, and the machines keep the order {@link selectInvitationAddrs}
 * gives them, so a machine's WebRTC address can still sit ahead of the next machine's relayed
 * one. A redeemer dials the list in order, so when that machine is down the WebRTC address costs
 * about 23 s before the next machine is tried. Left as is because the machine order carries
 * information an address-kind sort would discard; if redemptions are seen paying that,
 * interleave every machine's relayed addresses ahead of any WebRTC one.
 */
export function selectCadreInvitationMembers(self: InvitationSelf, siblings: readonly InvitationSibling[]): string[] {
	return selectInvitationAddrs(self, siblings, {
		ownAddrs: INVITATION_ADDRS_PER_SIBLING,
		perSibling: CADRE_INVITATION_ADDRS_PER_SIBLING,
		total: CADRE_INVITATION_MAX_ADDRS,
		orderAddrs: rankForPhone,
	});
}

/**
 * The bootstrap list of an open strand invitation, in {@link selectInvitationAddrs} order: all
 * of the minting machine's addresses when it is named first, at most
 * {@link INVITATION_ADDRS_PER_SIBLING} of each other machine's, each machine's in the order the
 * caller holds them.
 */
export function selectOpenInvitationBootstrap(self: InvitationSelf, siblings: readonly InvitationSibling[]): string[] {
	return selectInvitationAddrs(self, siblings, {
		ownAddrs: Infinity,
		perSibling: INVITATION_ADDRS_PER_SIBLING,
		total: Infinity,
		orderAddrs: (addrs) => [...addrs],
	});
}

/**
 * Up to {@link INVITATION_SIBLING_MACHINES} other machines in {@link compareSiblings} order, and
 * the minting machine placed among them:
 *
 * - **Always on, or no always-on machine named:** first, with `caps.ownAddrs` addresses. A device
 *   is ahead of other devices because it is the one machine the person handing out the
 *   invitation can keep open; with no other machine it is the only one named.
 * - **A device, with an always-on machine named:** behind every always-on machine and ahead of
 *   any other device, with its single best address for a phone ({@link rankForPhone}), whose slot
 *   is held inside `caps.total`. A phone is usually closed by the time its invitation is redeemed.
 */
function selectInvitationAddrs(self: InvitationSelf, siblings: readonly InvitationSibling[], caps: InvitationCaps): string[] {
	const named: NamedMachine[] = [...siblings]
		.sort(compareSiblings)
		.slice(0, INVITATION_SIBLING_MACHINES)
		.map((sibling) => ({ alwaysOn: sibling.alwaysOn, addrs: caps.orderAddrs(sibling.addrs).slice(0, caps.perSibling) }));
	if (self.alwaysOn || !named.some((machine) => machine.alwaysOn)) {
		return [...caps.orderAddrs(self.addrs).slice(0, caps.ownAddrs), ...named.flatMap((machine) => machine.addrs)].slice(0, caps.total);
	}
	// NOTE: the slot is held even when the device's best address reaches only its own network
	// (private, loopback, plain TCP), taking a sibling's address; if such devices are seen minting
	// QR invitations, hold the slot only for an address `cadreInvitationReach` counts as `anywhere`.
	const ownSlot = rankForPhone(self.addrs).slice(0, 1);
	const siblingAddrs = named.flatMap((machine) => machine.addrs).slice(0, caps.total - ownSlot.length);
	// The always-on machines sort first, so their addresses are a prefix of `siblingAddrs`.
	const alwaysOnAddrs = named.filter((machine) => machine.alwaysOn).reduce((count, machine) => count + machine.addrs.length, 0);
	return [...siblingAddrs.slice(0, alwaysOnAddrs), ...ownSlot, ...siblingAddrs.slice(alwaysOnAddrs)];
}

/**
 * Most likely to answer when the invitation is redeemed first: a machine that declares itself
 * always on, then higher {@link InvitationReachability}, then longer tenure, then newest record.
 * A live connection outranks tenure because tenure stops growing while a peer is silent, so an
 * hour of past tenure on a machine not connected now is weaker evidence than a connection.
 */
function compareSiblings(a: InvitationSibling, b: InvitationSibling): number {
	return Number(b.alwaysOn) - Number(a.alwaysOn)
		|| b.reachability - a.reachability
		|| b.tenureMs - a.tenureMs
		|| b.updatedAt - a.updatedAt;
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
