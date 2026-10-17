/**
 * store.svelte.ts — Svelte 5 runes store over the tab's edge node (`cadre-web.ts` → `edgeNode`).
 *
 * Exposes node status, peer id, party id, control-network connection state, chat-strand status,
 * the owner step's outcome and the relay posture to the UI, and owns a small ring buffer of
 * CadreNode lifecycle events (`control:*`, `strand:*`, `seed:*`, `cadre:removed`) that powers the
 * Activity (`/log`) page.
 *
 * Phase 1 is a solo single-node cadre, so `mode` is always `'solo'` (one node,
 * no peers). Phase 2 introduces multi-node cadres / cross-party strands.
 *
 * The store subscribes once, at module load, through the edge node, which re-applies every
 * handler to each node a start, restart, join or dissolve builds before that node starts, so an
 * event raised during a start (`control:connected`, a joined strand's `strand:started`) is seen.
 * `status` follows the edge node's ({@link followStatus}); whenever a `running` report names a
 * node the store has not attached yet, the page layer (the chat strand, the refresh poll) is
 * attached to it, which covers the start after a join, the restart after a dissolve and the left
 * party coming back after a failed join, none of which the store drives itself. The actions here
 * (start, stop, restart, join, retry the move, dissolve, import an owner key) are the edge node's,
 * which runs them one at a time; an owner's removal of this tab is acted on by the edge node too
 * (it stops the node and deletes that cadre's data), and reaches the store as status `removed`.
 */

import {
	addChatStrand,
	edgeNode,
	getChatStrand,
	getChatStrandId,
	getPartyId,
	getRelayState,
	noRelayState,
	type OwnerStanding,
	type RelayState,
} from './cadre-web.js';
import { decodeInvitationForThisTab } from './web-join.js';
import { resolveRelayAddrs } from './relay-config.js';
import {
	DEFAULT_EDGE_NODE_NAMES,
	type EdgeJoinProgress,
	type EdgeNodeOptions,
	type EdgeNodeStatus,
	type JoinCadreResult,
	type OwnerGenesisResult,
} from '@serfab/cadre-core/edge-node';
import type { CadreNode, ImportedOwnerKey, StrandMoveReport, StrandStatus } from '@serfab/cadre-core';
import { pushError } from './diagnostics.svelte.js';
import { markDelivered } from './messages.svelte.js';
import { resetAddDeviceCard } from './add-device.svelte.js';
import { resetMachinesCard } from './machines.svelte.js';
import { errorMessage, ownerFingerprint } from './cadre-format.js';

/**
 * The edge node's status, plus the store's own `idle` before the first start and `error` for its
 * `failed`. `joining`: started in the party an invitation names and redeeming it there; not
 * admitted yet. `removed`: an owner removed this tab from the party it ran, and the edge node has
 * stopped the node and deleted that party's data ({@link NodeState.removed}); nothing runs until
 * the next start.
 */
export type NodeStatus = 'idle' | 'starting' | 'joining' | 'running' | 'stopped' | 'removed' | 'error';
/** Phase 1 is a single-node cadre. Kept for the header badge + Phase-2 growth. */
export type CadreMode = 'solo';

/** The cadre an owner removed this tab from, as the Cadre page's card tells it. */
export interface RemovedFrom {
	partyId: string;
	/** The owner key that signed the removal, when it is anchored here (`CadreRemoval.signerKey`). */
	signerKey: string | null;
	/** The party this tab founded and left, which the saved start names now: the next start runs it. */
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
	owner: OwnerStanding;
	relay: RelayState;
	/** Set when an owner removed this tab from its cadre, until a start reaches `running` again. */
	removed: RemovedFrom | null;
}

export interface CadreEvent {
	ts: number;
	type: string;
	detail: string;
}

/** What a join reports to its caller: the redemption's passes and pauses, then the steps after a member admitted the tab. */
export interface JoinOptions {
	/** Cancels the join while it waits for a member; the tab then goes back to the party it left. */
	signal?: AbortSignal;
	/** A listener that throws is logged and ignored. */
	onProgress?: (progress: EdgeJoinProgress) => void;
}

const EVENT_LIMIT = 50;
const REFRESH_POLL_MS = 4_000;

/** The founding owner key's name on its `OwnerKey` row; the phone kit's default is `phone`. */
const TAB_OWNER_KEY_LABEL = 'browser';

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

let refreshPoll: ReturnType<typeof setInterval> | null = null;
/** The node the page layer is attached to ({@link attach}); null while none is. */
let attached: CadreNode | null = null;
/** The last {@link attach} begun, settled or not, so an action can resolve once the store has caught up with the edge node ({@link attachSettled}). */
let attaching: Promise<void> | null = null;
/** Joins, dissolves and restarts the store is running ({@link midTransition}): a stop inside one is a step, not an outcome. */
let midTransitions = 0;

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

// ── The edge node's events and status ─────────────────────────────────────────
// Subscribed once, for the life of the edge node: it attaches these to every node before it starts.

edgeNode.on('control:connected', () => {
	state.controlConnected = true;
	// Raised inside the node's start, before the edge node reports it running, so the party id is not readable here.
	record('control:connected');
});
edgeNode.on('control:disconnected', () => {
	state.controlConnected = false;
	record('control:disconnected');
});
edgeNode.on('strand:started', ({ strandId }) => {
	record('strand:started', strandId);
	syncStrand();
});
edgeNode.on('strand:stopped', ({ strandId }) => {
	record('strand:stopped', strandId);
	syncStrand();
});
edgeNode.on('strand:error', ({ strandId, error }) => {
	state.strandError = error.message;
	record('strand:error', `${strandId}: ${error.message}`);
	syncStrand();
});
edgeNode.on('strand:writable', ({ strandId }) => {
	record('strand:writable', strandId);
	syncStrand();
});
edgeNode.on('strand:commit-held', markDelivered);
edgeNode.on('strand:idle', ({ strandId }) => record('strand:idle', strandId));
edgeNode.on('strand:hibernating', ({ strandId }) => record('strand:hibernating', strandId));
edgeNode.on('strand:waking', ({ strandId }) => record('strand:waking', strandId));
edgeNode.on('strand:revoked', ({ strandId }) => record('strand:revoked', strandId));
edgeNode.on('strand:rejoin-blocked', ({ strandId }) => record('strand:rejoin-blocked', strandId));
edgeNode.on('seed:received', ({ peerId }) => record('seed:received', peerId));
edgeNode.on('seed:applied', ({ peersAdded }) => record('seed:applied', `${peersAdded} peers`));
edgeNode.on('seed:error', ({ error }) => record('seed:error', error));
// The edge node acts on the removal itself; the log keeps the report.
edgeNode.on('cadre:removed', (removal) => {
	const by = removal.signerKey ? ` by ${ownerFingerprint(removal.signerKey)}` : '';
	record('cadre:removed', `${removal.partyId}${by}`);
});
edgeNode.onStatus(followStatus);

/**
 * `status` follows the edge node's. A `running` report for a node not attached yet attaches the
 * page layer; one for the attached node (its owner key wired after the start, by an import or a
 * retried move) only updates the owner standing. A `stopped` inside a store-run transition is a
 * step on the way to the next node, shown as `starting`.
 */
function followStatus(status: EdgeNodeStatus): void {
	switch (status.state) {
		case 'starting':
			detach();
			state.status = 'starting';
			break;
		case 'joining':
			detach();
			forgetPartyCards();
			state.status = 'joining';
			state.partyId = status.node.partyId;
			state.peerId = peerIdOf(status.node);
			break;
		case 'running':
			if (status.node === attached) syncOwner(status.owner);
			else attaching = attach(status.node, status.owner);
			break;
		case 'stopped':
			detach();
			state.status = midTransitions > 0 ? 'starting' : 'stopped';
			break;
		case 'removed':
			detach();
			forgetPartyCards();
			state.removed = {
				partyId: status.partyId,
				signerKey: status.removal.signerKey,
				...(status.formerPartyId !== undefined && { formerPartyId: status.formerPartyId }),
			};
			state.status = 'removed';
			record('removal:done', status.formerPartyId ?? '');
			break;
		case 'failed':
			detach();
			failed('edge node', status.error);
			break;
	}
}

/**
 * Attach the page layer to a node that has just come up: fill the reactive state, bring up the
 * signed chat strand and start the refresh poll. Reports `running`, or `error` when the chat
 * strand cannot be added (a `SchemaVerificationError` surfaces here). A node replaced meanwhile
 * (the status moved on while the strand was being added) is left as the later status says.
 */
async function attach(node: CadreNode, owner: OwnerGenesisResult): Promise<void> {
	attached = node;
	state.peerId = peerIdOf(node);
	state.partyId = getPartyId();
	state.controlConnected = node.isRunning;
	syncOwner(owner);
	// Relay reservation (dialability for formation) is driven inside start(); the
	// poll below keeps it current if the reservation is later lost or regained.
	syncRelay();
	try {
		await addChatStrand();
	} catch (err) {
		if (attached === node) failed('addChatStrand', err);
		return;
	}
	if (attached !== node) return;
	syncStrand();
	startRefreshPoll();
	state.removed = null;
	state.error = null;
	state.status = 'running';
}

/**
 * Resolves once the attach the last `running` report began has settled, so an action returns
 * with `status` at `running` (or `error`) rather than a step behind the edge node: the join card
 * goes on to remove the old cadre as soon as the join resolves, and that needs the node running.
 */
async function attachSettled(): Promise<void> {
	let awaited: Promise<void> | null = null;
	// A report during the wait begins another attach; wait for the last.
	while (attaching && attaching !== awaited) {
		awaited = attaching;
		await awaited;
	}
}

/** Let go of the attached node: stop polling it and clear what was read off it. */
function detach(): void {
	stopRefreshPoll();
	attached = null;
	resetNodeState();
}

function peerIdOf(node: CadreNode): string | null {
	return node.peerId?.toString() ?? null;
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

/** Put the owner step's outcome into reactive state, recording it. */
function syncOwner(owner: OwnerStanding): void {
	if (state.owner === owner) return;
	state.owner = owner;
	record(`owner:${owner}`);
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

function failed(where: string, err: unknown): void {
	state.error = errorMessage(err);
	state.status = 'error';
	pushError(where, err);
	console.error(`[reference-app-web] ${where} failed:`, err);
}

/** Whether the edge node's `failed` has already been taken by {@link followStatus}; read here, since a status assigned above narrows `state.status` for the compiler. */
function alreadyFailed(): boolean {
	return state.status === 'error';
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

/** The cards' state that belongs to the party the node ran: a join (and its rollback) and a removal forget it. */
function forgetPartyCards(): void {
	resetAddDeviceCard();
	resetMachinesCard();
}

/**
 * Run `change`, a join, dissolve or restart, which stops the node on its way to the next one: a
 * `stopped` the edge node reports meanwhile shows as `starting`, and one it ends on is a stop.
 * Resolves (or throws `change`'s error) once the store has attached to the node it ends on.
 */
async function midTransition<T>(change: () => Promise<T>): Promise<T> {
	midTransitions += 1;
	try {
		return await change();
	} finally {
		midTransitions -= 1;
		await attachSettled();
		if (midTransitions === 0 && state.status === 'starting' && edgeNode.status.state === 'stopped') state.status = 'stopped';
	}
}

// ── Actions ───────────────────────────────────────────────────────────────────

/**
 * Start the party the saved start names and attach to it. From `removed`, that is the party the
 * tab founded and left, or a fresh one of its own: the Cadre page's "Go back to your own cadre".
 */
export async function start(): Promise<void> {
	if (['starting', 'joining', 'running'].includes(state.status)) return;
	state.status = 'starting';
	state.error = null;
	let options: EdgeNodeOptions;
	try {
		options = await startOptions();
	} catch (err) {
		failed('loadSavedStart', err);
		return;
	}
	try {
		await edgeNode.start(options);
	} catch (err) {
		// The edge node reported `failed` first, and the status listener took it.
		if (!alreadyFailed()) failed('start', err);
	}
	await attachSettled();
}

/**
 * The saved start with the current relays, or a fresh founded party when none is saved. A tab
 * starts on load, so the record's `autoStart` is ignored. A record that is present but unusable
 * (the edge node logs and drops one it cannot parse) is refused rather than founded over: a fresh
 * party would orphan the one the record names, the same posture as an unreadable trusted-owner
 * anchor; clear the site's data to start over.
 */
async function startOptions(): Promise<EdgeNodeOptions> {
	const relayAddrs = resolveRelayAddrs();
	const saved = await edgeNode.loadSavedStart();
	if (saved) return { ...saved.options, relayAddrs };
	const { savedStartKey } = DEFAULT_EDGE_NODE_NAMES;
	if ((await edgeNode.nodeLocalRecords().get(savedStartKey)) !== undefined) {
		throw new Error(`The saved start (kv "${savedStartKey}") cannot be read; clear this site's data to start over`);
	}
	return { partyId: crypto.randomUUID(), bootstrapAddrs: [], relayAddrs, origin: 'founded', ownerKeyLabel: TAB_OWNER_KEY_LABEL };
}

export async function stop(): Promise<void> {
	if (state.status !== 'running') return;
	try {
		await edgeNode.stop();
	} catch (err) {
		failed('stop', err);
	}
}

/** Rebuild the running node with the current relays (Home's "Restart node"); with none running, a start. */
export async function restart(): Promise<void> {
	const running = edgeNode.options;
	if (!running) {
		await start();
		return;
	}
	await midTransition(async () => {
		try {
			await edgeNode.restart({ ...running, relayAddrs: resolveRelayAddrs() });
		} catch (err) {
			if (!alreadyFailed()) failed('restart', err);
		}
	});
}

/**
 * Join the cadre a pasted invitation names (docs/architecture.md → "An app joins an existing
 * cadre"): `EdgeNode.joinCadre`, once the invitation is decoded and found to be this tab's.
 * Already running in that party: the edge node redeems in place. Otherwise it records the
 * running party's strands for the move (refused up front when the invitation does not make the
 * tab an owner and there is something to move), stops the node and starts one in the invitation's
 * party (status `joining`; the "Add a device or app" and "Devices and nodes" cards forget what
 * belongs to the party left), and redeems there, waiting for a member until one answers or
 * `options.signal` aborts. Admitted: the saved start names the joined party, its strands are
 * adopted, and the store attaches as after any start. Anything else: the edge node starts the
 * party the tab left again and the join's error is thrown; a failure going back is the store's
 * `error`, the join's error still thrown.
 */
export async function joinCadre(encoded: string, options: JoinOptions = {}): Promise<JoinCadreResult> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	const invitation = decodeInvitationForThisTab(encoded);
	record('join:started', invitation.partyId);
	try {
		const result = await midTransition(() => edgeNode.joinCadre(invitation, { ...options, relayAddrs: resolveRelayAddrs() }));
		record('join:admitted', invitation.partyId);
		return result;
	} catch (err) {
		record('join:failed', errorMessage(err));
		throw err;
	}
}

/**
 * Adopt the strands a join left waiting, on the running node (Retry on the Cadre page):
 * `EdgeNode.finishStrandMove`, which first asks a joined party again whether it lists the tab's
 * key as an owner. `undefined` when no move waits. Throws what the adoption throws,
 * `StrandMoveNotOwnerError` while the tab's key is no owner there.
 */
export async function retryStrandMove(): Promise<StrandMoveReport | undefined> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	try {
		const report = await edgeNode.finishStrandMove();
		record('move:retried', report ? (report.failed.length === 0 ? 'done' : 'partial') : 'nothing waiting');
		return report;
	} catch (err) {
		record('move:failed', errorMessage(err));
		throw err;
	}
}

/**
 * Import owner-key text into the tab's owner slot (`EdgeNode.importOwnerKey`). A key the import
 * wires makes the edge node report `running` again with the owner `enrolled`, which
 * {@link followStatus} puts in `owner`; the cards that follow it then read their standing again.
 */
export function importOwnerKey(text: string, passphrase?: string): Promise<ImportedOwnerKey> {
	return edgeNode.importOwnerKey(text, passphrase);
}

/**
 * Remove the cadre this tab founded and left (docs/architecture.md → "Dissolving the party it
 * left"): `EdgeNode.dissolveFormerParty`; `discard` gives up the strand and join ids the running
 * party does not hold. Refused with nothing stopped when the running start names no such party or
 * a move from it waits (`StrandMovePendingError`). Otherwise the edge node stops the node, reads
 * the old party alone, removes it, and starts the running party again, which the store attaches
 * to; status `starting` meanwhile. A refusal (`FormerPartyNotEmptyError`, nothing deleted) or a
 * failure (`StoreDeleteBlockedError` with the marker kept for the next start) is thrown once the
 * party has started again; a failure of that start is the call's error, and the store's.
 */
export async function dissolveFormerParty(discard: readonly string[] = []): Promise<void> {
	if (state.status !== 'running') throw new Error('The node is not running.');
	const formerPartyId = edgeNode.options?.formerPartyId ?? '';
	record('dissolve:removing', formerPartyId);
	try {
		await midTransition(() => edgeNode.dissolveFormerParty({ discard }));
	} catch (err) {
		record('dissolve:stopped', errorMessage(err));
		throw err;
	}
	record('dissolve:removed', formerPartyId);
}

export function currentPeerId(): string | null {
	return edgeNode.node?.peerId?.toString() ?? null;
}

export function currentStrandId(): string | null {
	return getChatStrandId();
}
