/**
 * store.svelte.ts — Svelte 5 runes store owning the browser CadreNode singleton.
 *
 * Replaces the old bare-libp2p store. Exposes node status, peer id, party id,
 * control-network connection state, chat-strand status, and the owner
 * self-genesis outcome to the UI. Also owns a small ring buffer of CadreNode
 * lifecycle events (`control:*`, `strand:*`, `seed:*`) that powers the Activity
 * (`/log`) page.
 *
 * Phase 1 is a solo single-node cadre, so `mode` is always `'solo'` (one node,
 * no peers). Phase 2 introduces multi-node cadres / cross-party strands.
 *
 * The store also runs the join of an existing cadre ({@link joinCadre}): it tears down
 * what it attached to the left party's node, drives `cadre-web.ts`'s switch, and
 * attaches to whichever node runs afterwards, the joined party's or, after a failure,
 * the left party's again.
 */

import {
	startCadre,
	stopCadre,
	addChatStrand,
	getCadreNode,
	getChatStrand,
	getChatStrandId,
	getPartyId,
	getOwnerState,
	getRelayState,
	noRelayState,
	decodeInvitationForThisTab,
	redeemInPlace,
	recordStrandMove,
	switchToParty,
	returnToStoredParty,
	type JoinOptions,
	type JoinOutcome,
	type OwnerState,
	type RelayState,
} from './cadre-web.js';
import type { CadreNode, StrandStatus } from '@serfab/cadre-core';
import { pushError } from './diagnostics.svelte.js';
import { resetAddDeviceCard } from './add-device.svelte.js';

/** `joining`: started in the party an invitation names and redeeming it there; not admitted yet. */
export type NodeStatus = 'idle' | 'starting' | 'joining' | 'running' | 'stopped' | 'error';
/** Phase 1 is a single-node cadre. Kept for the header badge + Phase-2 growth. */
export type CadreMode = 'solo';

interface NodeState {
	status: NodeStatus;
	mode: CadreMode;
	peerId: string | null;
	partyId: string | null;
	error: string | null;
	controlConnected: boolean;
	strandStatus: StrandStatus | null;
	strandConnectedPeers: number | null;
	strandError: string | null;
	owner: OwnerState;
	relay: RelayState;
}

export interface CadreEvent {
	ts: number;
	type: string;
	detail: string;
}

const EVENT_LIMIT = 50;
const REFRESH_POLL_MS = 4_000;

const state = $state<NodeState>({
	status: 'idle',
	mode: 'solo',
	peerId: null,
	partyId: null,
	error: null,
	controlConnected: false,
	strandStatus: null,
	strandConnectedPeers: null,
	strandError: null,
	owner: 'pending',
	relay: noRelayState(),
});

const events = $state<{ list: CadreEvent[] }>({ list: [] });

let subscribed = false;
let refreshPoll: ReturnType<typeof setInterval> | null = null;

export function nodeState(): NodeState {
	return state;
}

export function eventsState(): { list: CadreEvent[] } {
	return events;
}

function record(type: string, detail = ''): void {
	const entry: CadreEvent = { ts: Date.now(), type, detail };
	const next = [entry, ...events.list];
	if (next.length > EVENT_LIMIT) next.length = EVENT_LIMIT;
	events.list = next;
}

export function clearEvents(): void {
	events.list = [];
}

function subscribe(node: CadreNode): void {
	if (subscribed) return;
	subscribed = true;
	node.on('control:disconnected', () => {
		state.controlConnected = false;
		record('control:disconnected');
	});
	node.on('strand:started', ({ strandId }) => {
		record('strand:started', strandId);
		syncStrand();
	});
	node.on('strand:stopped', ({ strandId }) => {
		record('strand:stopped', strandId);
		syncStrand();
	});
	node.on('strand:error', ({ strandId, error }) => {
		state.strandError = error.message;
		record('strand:error', `${strandId}: ${error.message}`);
		syncStrand();
	});
	node.on('strand:writable', ({ strandId }) => {
		record('strand:writable', strandId);
		syncStrand();
	});
	node.on('strand:idle', ({ strandId }) => record('strand:idle', strandId));
	node.on('strand:hibernating', ({ strandId }) => record('strand:hibernating', strandId));
	node.on('strand:waking', ({ strandId }) => record('strand:waking', strandId));
	node.on('strand:revoked', ({ strandId }) => record('strand:revoked', strandId));
	node.on('strand:rejoin-blocked', ({ strandId }) => record('strand:rejoin-blocked', strandId));
	node.on('seed:received', ({ peerId }) => record('seed:received', peerId));
	node.on('seed:applied', ({ peersAdded }) => record('seed:applied', `${peersAdded} peers`));
	node.on('seed:error', ({ error }) => record('seed:error', error));
}

/** Pull the current chat-strand status/peers/error into reactive state. */
function syncStrand(): void {
	const strand = getChatStrand();
	state.strandStatus = strand?.status ?? null;
	state.strandConnectedPeers = strand?.connectedPeers ?? null;
	state.strandError = strand?.error ?? state.strandError;
}

/**
 * Pull the current relay posture into reactive state, recording a transition.
 * `getRelayState()` reads the node's live circuit addresses, so a reservation
 * lost (or regained) after start shows up here — Home's dialability badge would
 * otherwise keep rendering the boot-time snapshot forever.
 */
function syncRelay(): void {
	const next = getRelayState();
	const changed = next.status !== state.relay.status || next.error !== state.relay.error;
	state.relay = next;
	if (changed && next.status !== 'none') {
		record(`relay:${next.status}`, next.error ?? next.circuitAddrs[0] ?? '');
	}
}

/** Pull the owner step's outcome into reactive state, recording it. */
function syncOwner(): void {
	state.owner = getOwnerState().state;
	if (state.owner === 'error') {
		record('owner:error', getOwnerState().error ?? 'unknown');
	} else {
		record(`owner:${state.owner}`);
	}
}

// NOTE: relay posture refreshes on this 4s tick, so a lost reservation shows up
// in the UI up to 4s late. If a formation flow ever needs it sooner, read
// `getRelayState()` directly at the decision point (createInvitation already
// does) rather than shortening the tick for everyone.
function pollTick(): void {
	syncStrand();
	syncRelay();
}

function startRefreshPoll(): void {
	if (refreshPoll) return;
	refreshPoll = setInterval(pollTick, REFRESH_POLL_MS);
}

function stopRefreshPoll(): void {
	if (refreshPoll) {
		clearInterval(refreshPoll);
		refreshPoll = null;
	}
}

export async function start(): Promise<void> {
	if (state.status === 'starting' || state.status === 'joining' || state.status === 'running') return;
	state.status = 'starting';
	state.error = null;
	let node: CadreNode;
	try {
		node = await startCadre();
	} catch (err) {
		failed('startCadre', err);
		return;
	}
	await attachRunningNode(node);
}

/**
 * Attach the page layer to a node that has just come up: subscribe to its events, fill the
 * reactive state, bring up the signed chat strand and start the refresh poll. Reports
 * `running`, or `error` when the chat strand cannot be added (a `SchemaVerificationError`
 * surfaces here).
 */
async function attachRunningNode(node: CadreNode): Promise<void> {
	try {
		subscribe(node);

		state.peerId = node.peerId?.toString() ?? null;
		state.partyId = getPartyId();
		state.controlConnected = node.isRunning;
		// control:connected fires inside start(), before we can subscribe; record
		// it synthetically so the event log opens with the real lifecycle step.
		record('control:connected', state.partyId ?? '');
		syncOwner();

		// Relay reservation (dialability for formation) settles inside start(); the
		// poll below keeps it current if the reservation is later lost or regained.
		syncRelay();

		// Bring up the signed chat strand. SchemaVerificationError surfaces here.
		await addChatStrand();
		syncStrand();
		startRefreshPoll();

		state.status = 'running';
	} catch (err) {
		failed('startCadre', err);
	}
}

function failed(where: string, err: unknown): void {
	state.error = err instanceof Error ? err.message : String(err);
	state.status = 'error';
	pushError(where, err);
	console.error(`[reference-app-web] ${where} failed:`, err);
}

/** Let go of the running node: stop polling it and forget the subscriptions, which die with it. */
function releaseNode(): void {
	stopRefreshPoll();
	subscribed = false;
}

function resetNodeState(): void {
	state.peerId = null;
	state.partyId = null;
	state.controlConnected = false;
	state.strandStatus = null;
	state.strandConnectedPeers = null;
	state.strandError = null;
	state.owner = 'pending';
	state.relay = noRelayState();
}

export async function stop(): Promise<void> {
	if (state.status !== 'running') return;
	try {
		releaseNode();
		await stopCadre();
		resetNodeState();
		state.status = 'stopped';
	} catch (err) {
		failed('stopCadre', err);
	}
}

/** Stop then re-start the cadre (Home's "Restart node"). */
export async function restart(): Promise<void> {
	if (state.status === 'running') {
		await stop();
	}
	await start();
}

/**
 * Join the cadre a pasted invitation names (docs/architecture.md → "An app joins an existing
 * cadre"). Already running in that party: redeem in place. Otherwise the running party's
 * strands are recorded for the move (refused up front when the invitation does not make the
 * tab an owner and there is something to move), the node is stopped and started in the
 * invitation's party (status `joining`), and the invitation redeemed there, waiting for a
 * member until one answers or `options.signal` aborts. Admitted: the start record names the
 * joined party, its strands are adopted, and the store attaches as after any start. Anything
 * else: the tab goes back to the party it left and the join's error is thrown; a failure
 * going back leaves the store in `error` with that message, the join's error still thrown.
 *
 * The "Add a device or app" card's minted invitation and pending approval belong to the party
 * the node ran when they were made, so a switch, and a rollback, forget them.
 */
export async function joinCadre(encoded: string, options: JoinOptions = {}): Promise<JoinOutcome> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	const invitation = decodeInvitationForThisTab(encoded);
	if (invitation.partyId === state.partyId) {
		const outcome = await redeemInPlace(invitation, options);
		record('join:admitted', invitation.partyId);
		syncOwner();
		return outcome;
	}
	const movingFrom = await recordStrandMove(invitation);
	record('join:leaving', state.partyId ?? '');
	releaseNode();
	resetNodeState();
	resetAddDeviceCard();
	state.status = 'joining';
	state.partyId = invitation.partyId;
	state.peerId = getCadreNode()?.peerId?.toString() ?? null;
	try {
		const outcome = await switchToParty(invitation, options, movingFrom);
		record('join:admitted', invitation.partyId);
		await attachRunningNode(requireNode());
		return outcome;
	} catch (err) {
		record('join:failed', err instanceof Error ? err.message : String(err));
		await startLeftPartyAgain(movingFrom);
		throw err;
	}
}

/** After a failed join: start the party the tab left and attach to it; a failure here is the store's `error`, not the join's. */
async function startLeftPartyAgain(movingFrom: string | undefined): Promise<void> {
	resetNodeState();
	resetAddDeviceCard();
	state.status = 'starting';
	let node: CadreNode;
	try {
		node = await returnToStoredParty(movingFrom);
	} catch (err) {
		failed('returnToStoredParty', err);
		return;
	}
	await attachRunningNode(node);
}

function requireNode(): CadreNode {
	const node = getCadreNode();
	if (!node) throw new Error('CadreNode not started');
	return node;
}

export function currentPeerId(): string | null {
	return getCadreNode()?.peerId?.toString() ?? null;
}

export function currentStrandId(): string | null {
	return getChatStrandId();
}
