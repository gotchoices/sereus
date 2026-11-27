/**
 * The cadre as an app sees it: this party's own machines, the owner key that binds them,
 * and whether anybody can reach this device to answer an invitation.
 *
 * Machines join the way sereus 1.14 has them join: a node waiting to be claimed shows a
 * node code (`sereus-join:1.…`, as a QR code, a link or text); the owner's device reads
 * it, the person approves, and the device claims the node. A code carries the node's
 * one-time claim secret: it is never logged, and only the peer id appears in logs.
 *
 * These are interfaces. `@serfab/cadre-client/sereus` implements them over a running
 * cadre-core node; an app's mock implements them over sample data.
 */
import type { CadreResult } from './result.js';
import type { BootstrapPlan, CadronPreferences } from './bootstrap.js';
import type { InvitationText } from './invitation-text.js';

export type CadreMachine = {
	peerId: string;
	/** This device. */
	thisDevice: boolean;
	/** Where the cadre last recorded it as reachable; may be empty. */
	addresses: string[];
	/** The machine says it stays on (a server, a cadre-host node); null until it has said, or for this device. */
	alwaysOn: boolean | null;
	/** When the machine last re-published its own record (epoch ms): roughly when it was last heard from. Null when unknown. */
	lastSeenAt: number | null;
	/** The person's own name for it (`CadronPreferences.names`), or null. */
	name?: string | null;
	/** Named first in invitations (`CadronPreferences.preferred`). */
	preferred?: boolean;
};

/**
 * A cadron: one machine of a person's cadre (a phone, a home server, a rented node). The term
 * this package introduces; sereus's own APIs say machine, node or peer.
 */
export type Cadron = CadreMachine;

export type CadreStatus = {
	running: boolean;
	partyId: string | null;
	peerId: string | null;
	/** This device is an enrolled owner of its cadre, so it can claim and remove machines. */
	ownerEnrolled: boolean;
	/** First characters of the owner key: the fingerprint a claimed node shows as its owner. */
	ownerFingerprint: string | null;
	/** This device first, then the others. */
	machines: CadreMachine[];
};

/** Where this device can reach a node from: `anywhere` (a public address or name) or `home-network`. */
export type NodeReach = 'anywhere' | 'home-network';

/** What a node code says, shown for approval before a claim. Never includes the secret. */
export type NodeCodePreview = {
	peerId: string;
	addresses: string[];
	reach: NodeReach;
};

export interface CadreModel {
	status(): Promise<CadreResult<CadreStatus>>;
	/** Read scanned or pasted text. Fails `invalid-node-code` with the problem as `reason`. */
	inspectNodeCode(text: string): Promise<CadreResult<NodeCodePreview>>;
	/**
	 * Claim the node the code names, after the person approved (a link can be sent by
	 * anyone, so a code never claims on its own). Can take two minutes when no address
	 * answers. Fails `invalid-node-code`, `node-unreachable`, `claim-refused` (`retryable`
	 * says whether the same code can still work) or `claim-failed`.
	 */
	claimNode(text: string): Promise<CadreResult<void>>;
	/** Take a machine out of the cadre. */
	removeMachine(peerId: string): Promise<CadreResult<void>>;
	/**
	 * The owner key's private half, for an offline backup. It is the secret that controls
	 * the cadre: only behind an explicit, confirmed action, and never logged.
	 */
	exportOwnerKey(): Promise<CadreResult<string>>;
}

/**
 * Who answers an invitation from this device:
 * - `this-device`: it has an address of its own (a relay reservation, on a phone);
 * - `own-machine`: one of the party's always-on machines has a public address, and an
 *   invitation names it, so a relay is not needed.
 */
export type ReachedVia = 'this-device' | 'own-machine';

export type Reachability = {
	/** Can anybody answer an invitation from this device right now? */
	reachable: boolean;
	/** How, when reachable; null when not. */
	via: ReachedVia | null;
	/**
	 * Not reachable, but a relay is chosen and still connecting. Must not be shown as
	 * "nowhere to be reached": the user has just done what that screen asked of them.
	 */
	relayPending: boolean;
	/** The relays this device is configured with. */
	relays: string[];
	/**
	 * The relay reservation, read live: a configured relay is not a working one. `null`
	 * when there is no node (a mock, or before start).
	 */
	relayStatus: 'none' | 'dialing' | 'reserved' | 'retrying' | 'error' | (string & {}) | null;
};

export interface ReachabilityModel {
	get(): Promise<Reachability>;
}

export interface RelaysModel {
	get(): Promise<string[]>;
	/**
	 * Replace the relays. Applying them restarts the node, so this returns at once and the
	 * node reconnects behind it; watch reachability for the reservation.
	 */
	set(addrs: string[]): Promise<CadreResult<void>>;
}

/**
 * Whether a new invitation can be handed out with this device about to go quiet:
 * - `ready`: another cadron holds the invitation's strand (one of its commits is held
 *   elsewhere), so it can answer a join without this device;
 * - `waiting`: not yet (a new strand's copy reaches a cadron a second or two after the
 *   invitation is made);
 * - `no-cadron`: no other cadron serves the party's strands; only this device answers.
 */
export type InvitationReadiness = 'ready' | 'waiting' | 'no-cadron';

/**
 * What goes into an invitation, and whether it is ready to hand out. The app mints the
 * invitation (cadre-core's `createOpenInvitation`), passes it through `withBootstrap` before
 * encoding it, and shows `readiness` and `describe` on its invitation screen.
 */
export interface InvitationsModel {
	preferences(): Promise<CadronPreferences>;
	/** Merge and keep; returns what is kept (made whole and in range). */
	setPreferences(changes: Partial<CadronPreferences>): Promise<CadreResult<CadronPreferences>>;
	/** The addresses an invitation made now would name, and what to warn about. */
	bootstrapPlan(): Promise<CadreResult<BootstrapPlan>>;
	/**
	 * The invitation with its bootstrap list replaced by the plan's. Never fails: on any problem,
	 * or an empty plan, it returns the invitation as it came.
	 */
	withBootstrap<T extends { bootstrap: string[] }>(invitation: T): Promise<T>;
	/**
	 * `newStrand`: the invitation founded this strand just now. Its copy reaches a cadron only once
	 * a commit of it is held there (the signal waited for). An established strand counts as ready
	 * when another cadron serves it.
	 */
	readiness(strandId: string, opts?: { newStrand?: boolean }): InvitationReadiness;
	/**
	 * An invitation in words, from its encoded form. `link`: the text actually shared (the URL the
	 * QR code carries), for its length; the token's length otherwise.
	 */
	describe(token: string, link?: string): Promise<CadreResult<InvitationText>>;
}

/** What an invitation screen needs. */
export interface InvitationsView {
	invitations: InvitationsModel;
	changes: { invitations(onChange: () => void): () => void };
}

/** What a cadre screen needs: its operations, and a signal to re-read on. An app's whole model can be passed if it has both. */
export interface CadreView {
	cadre: CadreModel;
	changes: { cadre(onChange: () => void): () => void };
}

/** What a reachability display needs. */
export interface ReachabilityView {
	reachability: ReachabilityModel;
	changes: { reachability(onChange: () => void): () => void };
}

/** First 8 characters of an owner key: the fingerprint a claimed node shows as its owner. */
export function ownerFingerprint(publicKeyB64: string): string {
	return publicKeyB64.slice(0, 8);
}

/** `…` + the last 8 characters: enough to match the peer id a node prints. */
export function shortPeerId(peerId: string): string {
	return peerId.length > 12 ? `…${peerId.slice(-8)}` : peerId;
}
