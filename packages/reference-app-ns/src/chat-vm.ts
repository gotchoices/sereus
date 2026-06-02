/**
 * chat-vm.ts — NativeScript view model for the chat message list + send.
 *
 * Replaces reference-app-rn's `use-chat.ts`. Optimystic doesn't yet expose
 * reactive subscriptions, so this polls the active strand's Quereus database on
 * a fixed interval (default 2000 ms), exposes an `ObservableArray` of message
 * rows for the ListView, registers the local member on first attach, and does an
 * optimistic append on send. Reads the active strand + local peer id from the
 * shared `CadreViewModel` (`cadre-vm.ts`).
 */

import { Observable, ObservableArray } from '@nativescript/core';
import type { StrandInstance } from '@serfab/cadre-core';
import {
	insertMember,
	insertMessage,
	queryMessages,
	queryMembers,
	type ChatMessage,
} from './chat-operations';
import { getCadreVm, type CadreViewModel } from './cadre-vm';
import { TEST_IDS } from './test-ids';

const DEFAULT_POLL_INTERVAL_MS = 2000;

/** Row shape bound by the chat ListView item template. */
export interface ChatRow {
	id: number;
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

/** Quereus stores `YYYY-MM-DD HH:MM:SS`; show just `HH:MM`. */
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
	private _memberCount = 0;

	private strand: StrandInstance | null = null;
	private memberId: string | null = null;
	private registered = false;
	private timer: ReturnType<typeof setInterval> | undefined;

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
		this.notifySendState();
	}

	get loading(): boolean {
		return this._loading;
	}

	get error(): string {
		return this._error;
	}

	get errorVisibility(): 'visible' | 'collapse' {
		return this._error ? 'visible' : 'collapse';
	}

	/** Chat status-bar text — combines connection status with member count. */
	get statusText(): string {
		if (this.cadre.connected) {
			return `Connected · ${this.cadre.strandCount} strand(s) · ${this._memberCount} member(s)`;
		}
		if (this.cadre.connecting) {
			return 'Connecting…';
		}
		return this.cadre.error || 'Not connected — go to Settings';
	}

	/** `isEnabled` for the message input. */
	get inputEnabled(): boolean {
		return this.cadre.connected && this.strand !== null;
	}

	/** `isEnabled` for the Send button. */
	get canSend(): boolean {
		return this.inputEnabled && this._draft.trim().length > 0;
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

	/** (Re)read the active strand + member id from the cadre VM. */
	private attach(): void {
		const strand = this.cadre.getFirstStrand();
		const memberId = this.cadre.getPeerId();
		const changed = strand !== this.strand || memberId !== this.memberId;
		// A new strand instance (e.g. after reconnect) needs a fresh registration.
		if (strand !== this.strand) {
			this.registered = false;
		}
		this.strand = strand;
		this.memberId = memberId;

		if (strand && memberId && !this.registered) {
			const name = `User-${memberId.slice(-4)}`;
			insertMember(strand, memberId, name)
				.then(() => {
					this.registered = true;
				})
				.catch((err) => console.warn('[chat-vm] member register failed:', err));
		}

		if (changed) {
			this.notifySendState();
		}
	}

	private async refresh(): Promise<void> {
		// A strand may be created after the chat screen is already open.
		if (!this.strand || !this.memberId) {
			this.attach();
		}
		const strand = this.strand;
		if (!strand?.database) {
			this.setLoading(false);
			return;
		}

		try {
			const [messages, members] = await Promise.all([
				queryMessages(strand),
				queryMembers(strand),
			]);
			this.setMessages(messages);
			this.setMemberCount(members.length);
			this.setError('');
		} catch (err) {
			this.setError(errMessage(err));
		} finally {
			this.setLoading(false);
		}
	}

	/** Send the current draft; optimistic append then reconcile on next poll. */
	async send(): Promise<void> {
		const text = this._draft.trim();
		if (!text) return;
		const strand = this.strand;
		const memberId = this.memberId;
		if (!strand) throw new Error('No strand attached');
		if (!memberId) throw new Error('No member id');

		this.draft = '';
		const message = await insertMessage(strand, memberId, text);
		this._messages.push(this.toRow(message, memberId));
		this.setError('');
	}

	private toRow(message: ChatMessage, ownId: string | null): ChatRow {
		const isOwn = message.MemberId === ownId;
		return {
			id: message.Id,
			content: message.Content,
			sender: message.MemberName ?? message.MemberId.slice(-6),
			time: formatTime(message.Timestamp),
			isOwn,
			senderVisibility: isOwn ? 'collapse' : 'visible',
			rowId: TEST_IDS.chat.messageRow(message.Id),
		};
	}

	private setMessages(messages: ChatMessage[]): void {
		const rows = messages.map((m) => this.toRow(m, this.memberId));
		// Replace in place so the ListView diffs against the same array instance.
		this._messages.splice(0, this._messages.length, ...rows);
	}

	private setMemberCount(count: number): void {
		if (count === this._memberCount) return;
		this._memberCount = count;
		this.notifyPropertyChange('statusText', this.statusText);
	}

	private setLoading(loading: boolean): void {
		if (loading === this._loading) return;
		this._loading = loading;
		this.notifyPropertyChange('loading', loading);
	}

	private setError(error: string): void {
		if (error === this._error) return;
		this._error = error;
		this.notifyPropertyChange('error', error);
		this.notifyPropertyChange('errorVisibility', this.errorVisibility);
	}

	private notifySendState(): void {
		this.notifyPropertyChange('inputEnabled', this.inputEnabled);
		this.notifyPropertyChange('canSend', this.canSend);
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
