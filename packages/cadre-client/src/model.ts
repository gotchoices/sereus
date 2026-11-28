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
	/**
	 * This device holds a control-network connection to it right now (any kind, relayed included).
	 * Reliable for an always-on cadron, which every machine dials; two phones are rarely connected
	 * to each other even while both run, so for a phone read `lastSeenAt` too (`cadronPresence`).
	 * For this device: its own node is running.
	 */
	connected: boolean;
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
	/** The cadre it would join: this device's network id, for the approval prompt. Null before the node starts. */
	partyId: string | null;
	/** This device's owner key fingerprint, which the node shows as its owner once it joins. Null when none is enrolled. */
	ownerFingerprint: string | null;
};

/** What removing a cadron would do, for the confirmation (`CadreModel.planRemoval`). */
export type RemovalPlan = {
	/** Why it would be refused, or null: `not-an-owner` (no owner key here), `self` (this device). */
	refusal: 'not-an-owner' | 'self' | null;
	/** No live record names it here: already removed. */
	alreadyRemoved: boolean;
	/** Invitations it could come back through, which the removal withdraws. */
	invitations: number;
	/**
	 * Each closed strand the party holds a key for, where that key is replaced so the removed cadron
	 * reads nothing new there: `here` (by this removal), `later` (by a machine that runs the strand),
	 * `another-party` (the strand's host must re-invite the party).
	 */
	closedStrands: Array<{ strandId: string; replaced: 'here' | 'later' | 'another-party' }>;
};

/** What a removal did (`CadreModel.removeMachine`). */
export type RemovalOutcome = {
	/** Invitations withdrawn, which the removed cadron could have come back through. */
	withdrawnInvitations: number;
	/** Per closed strand: `rotated` (done), `pending` (finishes on a machine that runs it), `needs-another-party`. */
	closedStrands: Array<{ strandId: string; outcome: 'rotated' | 'pending' | 'needs-another-party' }>;
};

/** What connecting to a node by its address did (`CadreModel.connectNode`). */
export type ConnectNodeOutcome = {
	peerId: string;
	/** The node took the seed over the network. */
	delivered: boolean;
	/** Why it did not (the node's refusal, or no answer), when not delivered. */
	reason?: string;
	/**
	 * When not delivered: the seed to hand the node another way (`cadre start --seed …`). The node is
	 * already authorized either way. Not a secret, but there is no reason to log it.
	 */
	seed?: string;
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
	/**
	 * Add a node by its address (`/…/p2p/<peerId>`), for a node started to listen for seeds: authorize
	 * it (an owner-signed record), then deliver the seed. When the node does not take it over the
	 * network, the outcome carries the seed to deliver another way. Fails `invalid-address`,
	 * `unavailable`, or `not-supported` with no owner key here.
	 */
	connectNode(address: string): Promise<CadreResult<ConnectNodeOutcome>>;
	/**
	 * A seed for a node not created yet (a provider-hosted node made from it), as text. It carries the
	 * cadre's addresses but does NOT authorize anything: once the node exists, add it with
	 * `connectNode` or a claim, or its traffic is refused.
	 */
	createSeed(): Promise<CadreResult<string>>;
	/** What removing a cadron would do: for the confirmation ("this also closes 2 invitations"). */
	planRemoval(peerId: string): Promise<CadreResult<RemovalPlan>>;
	/**
	 * Take a cadron out of the cadre completely: its record, the invitations it could come back
	 * through, and the party's key in each closed strand (so it reads nothing new there). Fails
	 * `removal-refused` with `reason` `not-an-owner` or `self`.
	 */
	removeMachine(peerId: string): Promise<CadreResult<RemovalOutcome>>;
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

/**
 * How recently a cadron was alive, for a status dot:
 * - `connected`: this device holds a connection to it now (`CadreMachine.connected`);
 * - `recent`: not connected, but it published its record within `RECENT_RECORD_MS`, so it is
 *   running somewhere (a phone usually reads this way);
 * - `quiet`: heard from, longer ago;
 * - `unknown`: never heard from (its record has not reached this device).
 */
export type CadronPresence = 'connected' | 'recent' | 'quiet' | 'unknown';

/**
 * A running machine re-publishes its record every 7.5 minutes, and a record older than 15 is
 * stale: cadre-core's `DEFAULT_PEER_RECORD_HEARTBEAT_MS` and `DEFAULT_PEER_RECORD_MAX_AGE_MS`
 * (repeated here; this entry point loads no cadre-core).
 */
export const RECENT_RECORD_MS = 15 * 60 * 1000;

export function cadronPresence(machine: Pick<CadreMachine, 'connected' | 'lastSeenAt'>, now: number = Date.now()): CadronPresence {
	if (machine.connected) return 'connected';
	if (machine.lastSeenAt === null) return 'unknown';
	return now - machine.lastSeenAt < RECENT_RECORD_MS ? 'recent' : 'quiet';
}

/** First 8 characters of an owner key: the fingerprint a claimed node shows as its owner. */
export function ownerFingerprint(publicKeyB64: string): string {
	return publicKeyB64.slice(0, 8);
}

/** `…` + the last 8 characters: enough to match the peer id a node prints. */
export function shortPeerId(peerId: string): string {
	return peerId.length > 12 ? `…${peerId.slice(-8)}` : peerId;
}
