/**
 * messages.svelte.ts — Svelte 5 runes store over the chat strand's Quereus
 * database.
 *
 * Replaces the old `@optimystic/demo` `MessageApp` wiring. Reads/writes the
 * `App.Participant` / `App.Message` tables of the active chat strand directly via
 * Quereus SQL, mirroring `reference-app-rn/src/chat-operations.ts`. The strand
 * coordinates its own writes on a solo node, so writes land on the strand's
 * IndexedDB with no peers needed.
 *
 * Polling stays cheap: a 4s visibility-gated refresh while the route is mounted.
 */

import { getCadreNode, getChatStrandId } from './cadre-web.js';
import type { StrandInstance } from '@serfab/cadre-core';
import { chatMessageExists, insertChatMessage, newChatMessageId, selectChatMessages } from './chat-dml.js';
import { pushError } from './diagnostics.svelte.js';

const REFRESH_INTERVAL_MS = 4_000;

export interface ChatMessage {
	/** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
	Id: string;
	ParticipantId: string;
	Content: string;
	Timestamp: string;
	ParticipantName?: string;
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

/**
 * A composed message that has been submitted at least once, and the id minted for it. Held
 * across a failed send so pressing Send again re-presents the SAME primary key rather than
 * minting a second one — see {@link sendMessage}. Held only while the composer still holds its
 * author and content: see {@link composerChanged} and {@link settlePendingDraft}.
 */
interface PendingDraft {
	id: string;
	author: string;
	content: string;
}

let pendingDraft: PendingDraft | null = null;

type DraftSettledListener = (author: string, content: string) => void;

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- subscriber registry read only by `settlePendingDraft`; nothing renders from it, so it must not be reactive.
const draftSettledListeners = new Set<DraftSettledListener>();

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
		const messages = rows.map((r) => ({
			Id: r.id,
			ParticipantId: r.participantId,
			Content: r.content,
			Timestamp: r.timestamp,
			ParticipantName: r.participantName,
		}));
		state.messages = messages;
		settlePendingDraft(messages);
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
 * Report the composer's author and content, trimmed as {@link sendMessage} is given them. Any
 * pair other than the pending draft's retires its key: editing away and back, or clearing and
 * retyping the same words, is a new message. Without this, a message the user cleared and later
 * typed again would be taken for a retry, found stored, and silently dropped.
 */
export function composerChanged(author: string, content: string): void {
	if (pendingDraft && (pendingDraft.author !== author || pendingDraft.content !== content)) {
		pendingDraft = null;
	}
}

/**
 * Be told when a poll shows that a send which reported failure did land, with that draft's
 * author and content, so the composer can drop its "not confirmed" error and clear the box if it
 * still holds that text. Returns the unsubscribe.
 */
export function onDraftSettled(listener: DraftSettledListener): () => void {
	draftSettledListeners.add(listener);
	return () => {
		draftSettledListeners.delete(listener);
	};
}

/**
 * If `messages` holds the pending draft's row, a send that reported failure did land: retire its
 * key and tell the composer.
 *
 * Never while a send is in flight (`state.loading` is set exactly while {@link sendMessage}
 * runs): that send's outcome is still open, and if it then failed the user would be told to
 * press Send again with no key left to re-present, so the next press would mint a new one and
 * could store the message twice. The first read after the send settles retires it instead.
 */
function settlePendingDraft(messages: readonly ChatMessage[]): void {
	const pending = pendingDraft;
	if (state.loading || !pending) return;
	if (!messages.some((m) => m.Id === pending.id)) return;
	pendingDraft = null;
	for (const listener of draftSettledListeners) listener(pending.author, pending.content);
}

/**
 * Register (idempotently) the author as a participant, then append a message.
 * Participant.Id = the author name keeps the demo single-field while still
 * exercising the Participant↔Message foreign-key join.
 *
 * A strand write can fail without settling whether it landed, so the id belongs to the
 * composed message and not to the attempt: the first Send mints one and {@link pendingDraft}
 * holds it until a send resolves, the composer stops holding that author and content, or a poll
 * shows its row. Pressing Send again on unchanged text re-presents that same key, so the primary
 * key guarantees at most one row however many attempts the user makes.
 *
 * The author/content match is load-bearing, not an optimisation. If the user edits the text
 * after a failed send and the first attempt HAD landed, reusing the id would report the edit
 * as sent while the stored row kept the old text. Edited text is a different message, and the
 * earlier attempt landing under its own id is correct — the user did submit that text.
 */
export async function sendMessage(author: string, content: string): Promise<void> {
	const strand = activeStrand();
	if (!strand) throw new Error('Chat strand not active');
	const resend =
		pendingDraft?.author === author && pendingDraft.content === content ? pendingDraft : null;
	const draft = resend ?? { id: newChatMessageId(), author, content };
	pendingDraft = draft;
	state.loading = true;
	state.error = null;
	try {
		// On a resend, read before writing: the earlier attempt may have landed even though it
		// reported failure, and re-inserting a stored key raises rather than reporting success.
		// NOTE: an attempt that lands in the window between this read and the insert below still
		// raises a unique violation, so the user sees an error for a message that IS stored. The
		// next Send reads the row and reports success, so the app self-corrects in one more tap
		// and still cannot store a duplicate. Not worth retry machinery in a reference app.
		const alreadyStored = resend !== null && (await chatMessageExists(db(strand), draft.id));
		if (!alreadyStored) {
			await insertChatMessage(db(strand), draft.id, author, content);
		}
		pendingDraft = null;
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
