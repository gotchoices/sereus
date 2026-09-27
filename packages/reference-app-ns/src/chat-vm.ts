/**
 * chat-vm.ts — NativeScript view model for the chat message list + send.
 *
 * Replaces reference-app-rn's `use-chat.ts`. Optimystic doesn't yet expose
 * reactive subscriptions, so this polls the active strand's Quereus database on
 * a fixed interval (default 2000 ms), exposes an `ObservableArray` of message
 * rows for the ListView, registers the local participant on first attach, and does an
 * optimistic append on send. Reads the active strand + local peer id from the
 * shared `CadreViewModel` (`cadre-vm.ts`).
 */

import { Observable, ObservableArray } from '@nativescript/core';
import type { StrandInstance } from '@serfab/cadre-core';
import {
	insertParticipant,
	insertMessage,
	messageExists,
	newChatMessageId,
	queryMessages,
	queryParticipants,
	type ChatMessage,
} from './chat-operations';
import { getCadreVm, type CadreViewModel } from './cadre-vm';
import { TEST_IDS } from './test-ids';

const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * A draft the user has submitted at least once, and the message id minted for it. Held
 * across a failed send so pressing Send again re-presents the SAME primary key rather than
 * minting a second one — see {@link ChatViewModel.send}.
 */
interface PendingDraft {
	id: string;
	text: string;
}

/** Row shape bound by the chat ListView item template. */
export interface ChatRow {
	/** Text UUID message id (collision-free across concurrent peers). */
	id: string;
	content: string;
	sender: string;
	time: string;
	isOwn: boolean;
	/** 'collapse' for own messages (no sender label), 'visible' otherwise. */
	senderVisibility: 'visible' | 'collapse';
	/** automationText for the row: `message-row-<id>`. */
	rowId: string;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Quereus stores timestamps as T-separated ISO (e.g. `YYYY-MM-DDTHH:MM:SS`); show just `HH:MM`. */
function formatTime(timestamp: string): string {
	return timestamp.length >= 16 ? timestamp.slice(11, 16) : timestamp;
}

export class ChatViewModel extends Observable {
	/** Shared cadre VM — bound from the chat status bar as `{{ cadre.* }}`. */
	readonly cadre: CadreViewModel;

	private readonly pollIntervalMs: number;
	private readonly _messages = new ObservableArray<ChatRow>();
	private _draft = '';
	private _loading = true;
	private _error = '';
	/**
	 * Last send failure, kept apart from the poll's {@link _error} so a poll that succeeds a
	 * second later does not wipe the one message the user needs to read — that a resend is safe.
	 * Cleared by the next send, not by time.
	 */
	private _sendError = '';
	private _participantCount = 0;

	private strand: StrandInstance | null = null;
	private participantId: string | null = null;
	/** The draft awaiting a resolved send, so a resend reuses its id — see {@link send}. */
	private pendingDraft: PendingDraft | null = null;
	/** True while a send is in flight, so a second tap cannot race it — see {@link send}. */
	private sending = false;
	private registered = false;
	/** Strand whose participant insert is still running, so polls don't start another. */
	private registeringStrand: StrandInstance | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Strands with a read still running — see `refresh()`. */
	private readonly readsInFlight = new Set<StrandInstance>();

	constructor(pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS) {
		super();
		this.pollIntervalMs = pollIntervalMs;
		this.cadre = getCadreVm();
		// Keep the status bar / composer state live as connection status changes.
		this.cadre.on(Observable.propertyChangeEvent, () => {
			this.notifyPropertyChange('statusText', this.statusText);
			this.notifySendState();
		});
	}

	// ── Observable props ────────────────────────────────────────────────────

	get messages(): ObservableArray<ChatRow> {
		return this._messages;
	}

	get draft(): string {
		return this._draft;
	}

	set draft(value: string) {
		if (value === this._draft) return;
		this._draft = value;
		this.notifyPropertyChange('draft', value);
	}

	get loading(): boolean {
		return this._loading;
	}

	/** A send that did not confirm wins over a poll error — it is the one the user can act on. */
	get error(): string {
		return this._sendError || this._error;
	}

	get errorVisibility(): 'visible' | 'collapse' {
		return this.error ? 'visible' : 'collapse';
	}

	/** Chat status-bar text — combines connection status with participant count. */
	get statusText(): string {
		if (this.cadre.connected) {
			return `Connected · ${this.cadre.strandCount} strand(s) · ${this._participantCount} participant(s)`;
		}
		if (this.cadre.connecting) {
			return 'Connecting…';
		}
		return this.cadre.error || 'Not connected — go to Settings';
	}

	/**
	 * `isEnabled` for the message input *and* the Send button. Both are gated only
	 * on having a live strand to write to — not on draft content — so the composer
	 * reads as active whenever chat is usable rather than looking muted until the
	 * first keystroke. `send()` no-ops on an empty draft, so an empty tap is safe.
	 */
	get inputEnabled(): boolean {
		return this.cadre.connected && this.strand !== null;
	}

	// ── Lifecycle (driven by the chat page code-behind) ─────────────────────

	/** Begin polling. Idempotent — restarts the timer and re-attaches. */
	start(): void {
		this.stop();
		this.attach();
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
	}

	stop(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	// ── Internals ───────────────────────────────────────────────────────────

	/** (Re)read the active strand + participant id from the cadre VM. */
	private attach(): void {
		const strand = this.cadre.getFirstStrand();
		const participantId = this.cadre.getPeerId();
		const changed = strand !== this.strand || participantId !== this.participantId;
		// A new strand instance (e.g. after reconnect) needs a fresh registration.
		if (strand !== this.strand) {
			this.registered = false;
		}
		this.strand = strand;
		this.participantId = participantId;

		// Gated on `strand.database`: a joiner comes up `'syncing'` with no database until
		// it has received the strand's data from another member, and a write before that
		// would fork the Participant table (it never merges — docs/strands.md, "Joining").
		// `refresh()` re-enters here every poll while unregistered, so the registration
		// lands on the first poll after the strand becomes writable.
		if (strand?.database && participantId && !this.registered && this.registeringStrand !== strand) {
			this.register(strand, participantId);
		}

		if (changed) {
			this.notifySendState();
		}
	}

	/** Insert the local participant; a commit can outlast the poll interval on a slow link. */
	private register(strand: StrandInstance, participantId: string): void {
		this.registeringStrand = strand;
		void insertParticipant(strand, participantId, `User-${participantId.slice(-4)}`)
			.then(() => {
				if (this.strand === strand) this.registered = true;
			})
			.catch((err) => console.warn('[chat-vm] participant register failed:', err))
			.finally(() => {
				if (this.registeringStrand === strand) this.registeringStrand = null;
			});
	}

	private async refresh(): Promise<void> {
		// A strand may be created after the chat screen is already open, and one that
		// is attached may still be waiting for its first sync (no registration yet).
		if (!this.strand || !this.participantId || !this.registered) {
			this.attach();
		}
		const strand = this.strand;
		if (!strand?.database) {
			this.setLoading(false);
			return;
		}
		// A strand read goes over the network and can outlast the poll interval on a slow
		// link; starting another anyway slows every read and commit on that connection until
		// delivery is minutes late. Keyed per strand instance so a read of a strand this VM
		// has since re-attached away from does not delay the first read of the new one.
		if (this.readsInFlight.has(strand)) return;
		this.readsInFlight.add(strand);

		try {
			const [messages, participants] = await Promise.all([
				queryMessages(strand),
				queryParticipants(strand),
			]);
			this.setMessages(messages);
			this.setParticipantCount(participants.length);
			this.setError('');
		} catch (err) {
			this.setError(errMessage(err));
		} finally {
			this.readsInFlight.delete(strand);
			this.setLoading(false);
		}
	}

	/**
	 * Send the current draft; optimistic append then reconcile on next poll.
	 *
	 * A strand write can fail without settling whether it landed, so the message id belongs to
	 * the draft and not to the attempt: the first Send mints one and {@link pendingDraft} holds
	 * it until a send resolves. Pressing Send again on unchanged text re-presents that same key,
	 * so the primary key guarantees at most one row however many attempts the user makes.
	 *
	 * The text match is load-bearing, not an optimisation. If the user edits the text after a
	 * failed send and the first attempt HAD landed, reusing its id would report the edit as sent
	 * while the stored row kept the old text. Edited text is a different message, and the earlier
	 * attempt landing under its own id is correct — the user did submit that text.
	 *
	 * The draft is cleared only once the send resolves: a failed send that emptied the box made
	 * the user re-type, and a re-typed message is a new draft with a new id — the path that
	 * posted the message twice.
	 *
	 * Because the box keeps its text for the whole commit, the composer stays tappable for
	 * seconds on a slow strand, so a send already in flight makes this a no-op: a second tap is
	 * the same intent, and acting on it would re-present the draft's key against its own
	 * in-flight insert — one of the two loses on a unique violation and reports "not confirmed"
	 * for a message that was stored. Silent, like the empty-draft no-op above it.
	 */
	async send(): Promise<void> {
		const text = this._draft.trim();
		if (!text || this.sending) return;
		const strand = this.strand;
		const participantId = this.participantId;
		if (!strand) throw new Error('No strand attached');
		if (!participantId) throw new Error('No participant id');

		const resend = this.pendingDraft?.text === text ? this.pendingDraft : null;
		const draft = resend ?? { id: newChatMessageId(), text };
		this.pendingDraft = draft;
		this.sending = true;
		this.setSendError('');

		try {
			// On a resend, read before writing: the earlier attempt may have landed despite
			// reporting failure, and re-inserting a stored key raises rather than reporting success.
			// NOTE: an attempt that lands in the window between this read and the insert below still
			// raises a unique violation, so the user sees an error for a message that IS stored. The
			// next tap of Send reads the row and reports success, so the app self-corrects in one
			// more tap and still cannot store a duplicate. Not worth retry machinery in a reference app.
			if (resend && (await messageExists(strand, draft.id))) {
				// Nothing written: the row is a previous attempt's, so let the next poll bring it in.
				this.pendingDraft = null;
				this.draft = '';
				await this.refresh();
				return;
			}

			const message = await insertMessage(strand, draft.id, participantId, text);
			this.pendingDraft = null;
			this.draft = '';
			this._messages.push(this.toRow(message, participantId));
			this.setError('');
		} catch (err) {
			// Not "failed": the write may in fact have landed. Repeating is safe because `draft.id`
			// survives this rejection, so a resend of unchanged text replaces rather than adds.
			this.setSendError(
				`Not confirmed sent (${errMessage(err)}). Press Send again — it can only be stored once.`,
			);
			throw err;
		} finally {
			this.sending = false;
		}
	}

	private toRow(message: ChatMessage, ownId: string | null): ChatRow {
		const isOwn = message.ParticipantId === ownId;
		return {
			id: message.Id,
			content: message.Content,
			sender: message.ParticipantName ?? message.ParticipantId.slice(-6),
			time: formatTime(message.Timestamp),
			isOwn,
			senderVisibility: isOwn ? 'collapse' : 'visible',
			rowId: TEST_IDS.chat.messageRow(message.Id),
		};
	}

	private setMessages(messages: ChatMessage[]): void {
		const rows = messages.map((m) => this.toRow(m, this.participantId));
		// Replace in place so the ListView diffs against the same array instance.
		this._messages.splice(0, this._messages.length, ...rows);
	}

	private setParticipantCount(count: number): void {
		if (count === this._participantCount) return;
		this._participantCount = count;
		this.notifyPropertyChange('statusText', this.statusText);
	}

	private setLoading(loading: boolean): void {
		if (loading === this._loading) return;
		this._loading = loading;
		this.notifyPropertyChange('loading', loading);
	}

	private setError(error: string): void {
		if (error === this._error) return;
		const before = this.error;
		this._error = error;
		this.notifyErrorChange(before);
	}

	private setSendError(error: string): void {
		if (error === this._sendError) return;
		const before = this.error;
		this._sendError = error;
		this.notifyErrorChange(before);
	}

	/** Notify only when the COMBINED text changed — a masked poll error is not a visible change. */
	private notifyErrorChange(before: string): void {
		const after = this.error;
		if (after === before) return;
		this.notifyPropertyChange('error', after);
		this.notifyPropertyChange('errorVisibility', this.errorVisibility);
	}

	private notifySendState(): void {
		this.notifyPropertyChange('inputEnabled', this.inputEnabled);
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

let vm: ChatViewModel | null = null;

/** Shared ChatViewModel — one poll loop, shared with the chat screen. */
export function getChatVm(): ChatViewModel {
	if (!vm) {
		vm = new ChatViewModel();
	}
	return vm;
}
