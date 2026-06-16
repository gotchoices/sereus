/**
 * messages.svelte.ts — Svelte 5 runes store over the chat strand's Quereus
 * database.
 *
 * Replaces the old `@optimystic/demo` `MessageApp` wiring. Reads/writes the
 * `App.Member` / `App.Message` tables of the active chat strand directly via
 * Quereus SQL, mirroring `reference-app-rn/src/chat-operations.ts`. The strand
 * runs in `bootstrap` mode on a solo node, so writes land on the strand's
 * IndexedDB local transactor.
 *
 * Polling stays cheap: a 4s visibility-gated refresh while the route is mounted.
 */

import { getCadreNode, getChatStrandId } from './cadre-web.js';
import type { StrandInstance } from '@serfab/cadre-core';
import { insertChatMessage, selectChatMessages } from './chat-dml.js';
import { pushError } from './diagnostics.svelte.js';

const REFRESH_INTERVAL_MS = 4_000;

export interface ChatMessage {
	/** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
	Id: string;
	MemberId: string;
	Content: string;
	Timestamp: string;
	MemberName?: string;
}

interface MessagesState {
	ready: boolean;
	loading: boolean;
	error: string | null;
	messages: ChatMessage[];
	updatedMs: number | null;
}

const state = $state<MessagesState>({
	ready: false,
	loading: false,
	error: null,
	messages: [],
	updatedMs: null,
});

let pollHandle: ReturnType<typeof setInterval> | null = null;
let visibilityListener: (() => void) | null = null;
let refreshInFlight = false;

export function messagesState(): MessagesState {
	return state;
}

/** The chat strand iff it is active with an attached database, else null. */
function activeStrand(): StrandInstance | null {
	const node = getCadreNode();
	const id = getChatStrandId();
	if (!node || !id) return null;
	const strand = node.getStrand(id);
	return strand && strand.status === 'active' && strand.database ? strand : null;
}

function db(strand: StrandInstance) {
	// `database` is present because `activeStrand()` guards on it.
	return strand.database!.getDatabase();
}

/**
 * Reflect the current strand readiness into state and load the message list.
 * Cheap and idempotent — safe to call from `onMount`/`$effect`.
 */
export async function ensureReady(): Promise<void> {
	const strand = activeStrand();
	if (!strand) {
		state.ready = false;
		state.messages = [];
		return;
	}
	if (!state.ready) {
		state.ready = true;
		await refresh();
	}
}

export async function refresh(): Promise<void> {
	const strand = activeStrand();
	if (!strand) {
		state.ready = false;
		return;
	}
	if (refreshInFlight) return;
	refreshInFlight = true;
	try {
		const rows = await selectChatMessages(db(strand));
		state.messages = rows.map((r) => ({
			Id: r.id,
			MemberId: r.memberId,
			Content: r.content,
			Timestamp: r.timestamp,
			MemberName: r.memberName,
		}));
		state.ready = true;
		state.error = null;
		state.updatedMs = Date.now();
	} catch (err) {
		state.error = err instanceof Error ? err.message : String(err);
		pushError('messages.refresh', err);
	} finally {
		refreshInFlight = false;
	}
}

/**
 * Register (idempotently) the author as a member, then append a message.
 * Member.Id = the author name keeps the demo single-field while still
 * exercising the Member↔Message foreign-key join.
 */
export async function sendMessage(author: string, content: string): Promise<void> {
	const strand = activeStrand();
	if (!strand) throw new Error('Chat strand not active');
	state.loading = true;
	state.error = null;
	try {
		await insertChatMessage(db(strand), author, content);
		await refresh();
	} catch (err) {
		state.error = err instanceof Error ? err.message : String(err);
		pushError('messages.send', err);
		throw err;
	} finally {
		state.loading = false;
	}
}

/**
 * Visibility-gated polling so cross-tab / Phase-2 cross-peer writes converge.
 * Cheap by design — one strand read per tick. Stops on route unmount.
 */
export function startPolling(): void {
	if (pollHandle) return;
	const tick = () => {
		void refresh();
	};
	const begin = () => {
		if (pollHandle) return;
		tick();
		pollHandle = setInterval(tick, REFRESH_INTERVAL_MS);
	};
	const pause = () => {
		if (!pollHandle) return;
		clearInterval(pollHandle);
		pollHandle = null;
	};
	visibilityListener = () => {
		if (document.visibilityState === 'visible') begin();
		else pause();
	};
	document.addEventListener('visibilitychange', visibilityListener);
	if (document.visibilityState === 'visible') begin();
}

export function stopPolling(): void {
	if (pollHandle) {
		clearInterval(pollHandle);
		pollHandle = null;
	}
	if (visibilityListener) {
		document.removeEventListener('visibilitychange', visibilityListener);
		visibilityListener = null;
	}
}
