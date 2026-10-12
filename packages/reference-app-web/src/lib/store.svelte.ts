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
 * The store also runs the join of an existing cadre ({@link joinCadre}) and the removal of
 * the cadre the tab left ({@link dissolveFormerParty}): each tears down what it attached to
 * the running node, drives `web-join.ts`'s steps, and attaches to whichever node runs
 * afterwards. When the node reports that an owner removed this tab from its cadre
 * (`cadre:removed`), the store lets go of it and `web-join.ts` stops it and deletes that
 * cadre's data (status `removing`, then `removed`), never in the middle of another of these
 * transitions ({@link inTransition}).
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
	type OwnerState,
	type RelayState,
} from './cadre-web.js';
import {
	decodeInvitationForThisTab,
	finishStrandMove,
	forgetRemovedParty,
	planDissolve,
	redeemInPlace,
	recordStrandMove,
	removeFormerParty,
	switchToParty,
	returnToStoredParty,
	type JoinOptions,
	type JoinOutcome,
} from './web-join.js';
import type { StrandMoveOutcome } from './web-strand-move.js';
import type { CadreNode, CadreRemoval, StrandStatus } from '@serfab/cadre-core';
import { pushError } from './diagnostics.svelte.js';
import { resetAddDeviceCard } from './add-device.svelte.js';
import { resetMachinesCard } from './machines.svelte.js';
import { ownerFingerprint } from './cadre-format.js';

/**
 * `joining`: started in the party an invitation names and redeeming it there; not admitted yet.
 * `removing`: an owner removed this tab from the party it ran; the node is stopping and the
 * party's data being deleted. `removed`: that is done ({@link NodeState.removed}); nothing runs
 * until the next start.
 */
export type NodeStatus = 'idle' | 'starting' | 'joining' | 'running' | 'stopped' | 'removing' | 'removed' | 'error';
/** Phase 1 is a single-node cadre. Kept for the header badge + Phase-2 growth. */
export type CadreMode = 'solo';

/** The cadre an owner removed this tab from, as the Cadre page's card tells it. */
export interface RemovedFrom {
	partyId: string;
	/** The owner key that signed the removal, when it is anchored here (`CadreRemoval.signerKey`). */
	signerKey: string | null;
	/** The party this tab founded and left, which the start record names now: the next start runs it. */
	formerPartyId?: string;
}

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
	/** Set when an owner removed this tab from its cadre, until a start reaches `running` again. */
	removed: RemovedFrom | null;
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
	removed: null,
});

const events = $state<{ list: CadreEvent[] }>({ list: [] });

let subscribed = false;
let refreshPoll: ReturnType<typeof setInterval> | null = null;
/** Starts, stops, joins, dissolves and removals in progress ({@link inTransition}). */
let transitions = 0;
/** A removal a node reported that has not been acted on yet ({@link actOnReportedRemoval}). */
let removalReported: CadreRemoval | null = null;

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
	// NOTE: a tab removed while it was closed never sees its own row live after the next start, so
	// it never reports (docs/architecture.md → "The removed machine learns it"), and runs that cadre
	// while every other machine refuses it. If users meet this, persist "seen live" per party, as the
	// phone kit's note at `watchRemoval` says.
	node.on('cadre:removed', onRemoved);
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

/**
 * Start the party the start record names and attach to it. From `removed`, that is the party the
 * tab founded and left, or a fresh one of its own: the Cadre page's "Go back to your own cadre".
 */
export async function start(): Promise<void> {
	if (['starting', 'joining', 'running', 'removing'].includes(state.status)) return;
	await inTransition(async () => {
		state.status = 'starting';
		state.error = null;
		await startStoredParty('startCadre');
	});
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

		state.removed = null;
		state.status = 'running';
	} catch (err) {
		failed('startCadre', err);
	}
}

/**
 * Run `change`, a start, stop, join, dissolve or removal, as a transition: a removal a node reports
 * meanwhile is acted on once no transition runs, so it never stops the node or deletes storage under
 * one. The status checks at each entry point keep transitions from overlapping otherwise.
 */
async function inTransition<T>(change: () => Promise<T>): Promise<T> {
	transitions += 1;
	try {
		return await change();
	} finally {
		transitions -= 1;
		if (transitions === 0) actOnReportedRemoval();
	}
}

/** `cadre:removed` from a node the store attached: acted on now, or after the transition in progress. */
function onRemoved(removal: CadreRemoval): void {
	const by = removal.signerKey ? ` by ${ownerFingerprint(removal.signerKey)}` : '';
	record('cadre:removed', `${removal.partyId}${by}`);
	removalReported = removal;
	if (transitions === 0) actOnReportedRemoval();
}

/**
 * Leave the running party when a node of it reported the tab's removal: the running node itself,
 * before or after the store subscribed, or an earlier node of the party, while a transition held
 * the store. A report waits while no node runs, for the next start of its party.
 *
 * NOTE: a report for a party the tab has since left (a join was leaving it when the report came) is
 * dropped. That party's storage stays in this browser, as a joined party's does whenever the tab
 * leaves it, and a founded one is offered for removal by the join card. The phone kit deletes it; if
 * this window (a join's first steps, before it stops the old node) is ever hit, delete it here too.
 */
function actOnReportedRemoval(): void {
	const removal = removalReported ?? getCadreNode()?.removedFromCadre() ?? null;
	if (removal === null || state.status !== 'running') return;
	removalReported = null;
	if (removal.partyId === state.partyId) void leaveRemovedParty(removal);
}

/**
 * Let go of the node and have `web-join.ts` stop it, point the start record away from the party and
 * delete the party's storage, then report `removed` for the Cadre page's card. A failure reading or
 * rewriting the start record is the store's `error`, with the storage left as the record names it.
 *
 * NOTE: after that failure the next start runs the removed party again, on its storage, and its new
 * node does not report the removal. It takes an IndexedDB fault; if it is seen, keep the report and
 * act on it after that start.
 */
async function leaveRemovedParty(removal: CadreRemoval): Promise<void> {
	await inTransition(async () => {
		record('removal:leaving', removal.partyId);
		releaseNode();
		resetNodeState();
		forgetPartyCards();
		state.status = 'removing';
		try {
			const formerPartyId = await forgetRemovedParty(removal.partyId);
			state.removed = { partyId: removal.partyId, signerKey: removal.signerKey, ...(formerPartyId !== undefined && { formerPartyId }) };
			state.status = 'removed';
			record('removal:done', formerPartyId ?? '');
		} catch (err) {
			failed('forgetRemovedParty', err);
		}
	});
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

/** The cards' state that belongs to the party the node ran: a join, its rollback and a removal forget it. */
function forgetPartyCards(): void {
	resetAddDeviceCard();
	resetMachinesCard();
}

export async function stop(): Promise<void> {
	if (state.status !== 'running') return;
	await inTransition(async () => {
		try {
			releaseNode();
			await stopCadre();
			resetNodeState();
			state.status = 'stopped';
		} catch (err) {
			failed('stopCadre', err);
		}
	});
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
 * The "Add a device or app" card's minted invitation and pending approval, and an open removal
 * confirmation on "Devices and nodes", belong to the party the node ran when they were made, so
 * a switch, and a rollback, forget them.
 */
export async function joinCadre(encoded: string, options: JoinOptions = {}): Promise<JoinOutcome> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	return inTransition(async () => {
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
		forgetPartyCards();
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
	});
}

/**
 * Adopt the strands a join left waiting, on the running node (Retry on the Cadre page). The
 * owner standing is read again: the adoption needs the tab's key wired as an owner, and asks the
 * party for it first.
 */
export async function retryStrandMove(): Promise<StrandMoveOutcome | undefined> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	return inTransition(async () => {
		const outcome = await finishStrandMove();
		syncOwner();
		record('move:retried', outcome?.state ?? 'nothing waiting');
		return outcome;
	});
}

/**
 * Remove the cadre this tab founded and left (docs/architecture.md → "Dissolving the party it
 * left"); `discard` gives up the strand and join ids the running party does not hold. Refused
 * with nothing stopped when the running start names no such party or a move from it waits
 * (`StrandMovePendingError`). Otherwise the store lets go of the node, `web-join.ts` stops it,
 * reads the old party alone and removes it, and the stored party is started and attached
 * again, status `starting` meanwhile. A refusal (`FormerPartyNotEmptyError`, nothing deleted)
 * or a failure is thrown once the party has started again; a failure of that start is then the
 * store's `error` only. After a removal, a failed start is both the store's `error` and the
 * call's.
 */
export async function dissolveFormerParty(discard: readonly string[] = []): Promise<void> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	await inTransition(async () => {
		const plan = await planDissolve();
		record('dissolve:removing', plan.formerPartyId);
		releaseNode();
		resetNodeState();
		state.status = 'starting';
		try {
			await removeFormerParty(plan, discard);
		} catch (err) {
			record('dissolve:stopped', err instanceof Error ? err.message : String(err));
			await startStoredParty('dissolveFormerParty');
			throw err;
		}
		record('dissolve:removed', plan.formerPartyId);
		if (!(await startStoredParty('dissolveFormerParty'))) throw new Error(state.error ?? 'The node did not start again.');
	});
}

/**
 * Start the stored party and attach to it, as a load does. False when it did not reach
 * `running`; the failure is then the store's `error`, reported under `where`.
 */
async function startStoredParty(where: string): Promise<boolean> {
	let node: CadreNode;
	try {
		node = await startCadre();
	} catch (err) {
		failed(where, err);
		return false;
	}
	await attachRunningNode(node);
	return state.status === 'running';
}

/** After a failed join: start the party the tab left and attach to it; a failure here is the store's `error`, not the join's. */
async function startLeftPartyAgain(movingFrom: string | undefined): Promise<void> {
	resetNodeState();
	forgetPartyCards();
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
