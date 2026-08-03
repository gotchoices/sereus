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
import type { CadreNode, StrandStatus } from '@serfab/cadre-core';
import { pushError } from './diagnostics.svelte.js';

export type NodeStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';
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
	strandPeers: number | null;
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
	strandPeers: null,
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
	node.on('strand:idle', ({ strandId }) => record('strand:idle', strandId));
	node.on('strand:hibernating', ({ strandId }) => record('strand:hibernating', strandId));
	node.on('strand:waking', ({ strandId }) => record('strand:waking', strandId));
	node.on('seed:received', ({ peerId }) => record('seed:received', peerId));
	node.on('seed:applied', ({ peersAdded }) => record('seed:applied', `${peersAdded} peers`));
	node.on('seed:error', ({ error }) => record('seed:error', error));
}

/** Pull the current chat-strand status/peers/error into reactive state. */
function syncStrand(): void {
	const strand = getChatStrand();
	state.strandStatus = strand?.status ?? null;
	state.strandPeers = strand?.connectedPeers ?? null;
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
	if (state.status === 'starting' || state.status === 'running') return;
	state.status = 'starting';
	state.error = null;
	try {
		const node = await startCadre();
		subscribe(node);

		state.peerId = node.peerId?.toString() ?? null;
		state.partyId = getPartyId();
		state.controlConnected = node.isRunning;
		state.owner = getOwnerState().state;
		// control:connected fires inside start(), before we can subscribe; record
		// it synthetically so the event log opens with the real lifecycle step.
		record('control:connected', state.partyId ?? '');
		if (state.owner === 'error') {
			record('owner:error', getOwnerState().error ?? 'unknown');
		} else {
			record(`owner:${state.owner}`);
		}

		// Relay reservation (dialability for formation) settles inside start(); the
		// poll below keeps it current if the reservation is later lost or regained.
		syncRelay();

		// Bring up the signed chat strand. SchemaVerificationError surfaces here.
		await addChatStrand();
		syncStrand();
		startRefreshPoll();

		state.status = 'running';
	} catch (err) {
		state.error = err instanceof Error ? err.message : String(err);
		state.status = 'error';
		pushError('startCadre', err);
		console.error('[reference-app-web] startCadre failed:', err);
	}
}

export async function stop(): Promise<void> {
	if (state.status !== 'running') return;
	try {
		stopRefreshPoll();
		subscribed = false;
		await stopCadre();
		state.peerId = null;
		state.partyId = null;
		state.controlConnected = false;
		state.strandStatus = null;
		state.strandPeers = null;
		state.strandError = null;
		state.owner = 'pending';
		state.relay = noRelayState();
		state.status = 'stopped';
	} catch (err) {
		state.error = err instanceof Error ? err.message : String(err);
		state.status = 'error';
		pushError('stopCadre', err);
		console.error('[reference-app-web] stopCadre failed:', err);
	}
}

/** Stop then re-start the cadre (Home's "Restart node"). */
export async function restart(): Promise<void> {
	if (state.status === 'running') {
		await stop();
	}
	await start();
}

export function currentPeerId(): string | null {
	return getCadreNode()?.peerId?.toString() ?? null;
}

export function currentStrandId(): string | null {
	return getChatStrandId();
}
