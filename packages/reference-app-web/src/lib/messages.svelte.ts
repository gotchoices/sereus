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
		const database = db(strand);
		const messages: ChatMessage[] = [];
		// Order by Timestamp (the text UUID Id is not chronologically sortable).
		// Id is only a stable tiebreak: Timestamp has second resolution, so two
		// peers posting within the same second converge to an arbitrary-but-stable
		// order. Acceptable for the reference app.
		for await (const row of database.eval(
			`select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
			 from App.Message M
			 left join App.Member Mem on Mem.Id = M.MemberId
			 order by M.Timestamp asc, M.Id asc`,
		)) {
			messages.push({
				Id: row.Id as string,
				MemberId: row.MemberId as string,
				Content: row.Content as string,
				Timestamp: row.Timestamp as string,
				MemberName: (row.MemberName as string) ?? undefined,
			});
		}
		state.messages = messages;
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
		const database = db(strand);
		await database.exec('insert or ignore into App.Member (Id, Name) values (?, ?)', [
			author,
			author,
		]);

		// Quereus DATETIME expects 'YYYY-MM-DD HH:MM:SS' — not ISO 8601 with 'T'/'Z'.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient Date, immediately serialized to a string and discarded; never held or mutated in reactive state.
		const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
		// Generate the primary key locally as a UUID. A read-then-increment of
		// max(Id) would collide when two peers post concurrently into a shared
		// strand, since each reads the same local max before either replicates.
		const id = crypto.randomUUID();
		await database.exec(
			'insert into App.Message (Id, MemberId, Content, Timestamp) values (?, ?, ?, ?)',
			[id, author, content, now],
		);

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
