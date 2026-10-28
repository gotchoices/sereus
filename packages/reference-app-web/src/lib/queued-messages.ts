/**
 * queued-messages.ts — the Messages page's record of the messages it sent in offline mode that the
 * strand's queue has not settled yet, by the transaction that stores each. Mirrors
 * `reference-app-rn/src/queued-messages.ts`.
 *
 * The queue reports a transaction only by its id (`StampId()`), and after a reload nothing in
 * memory says which message an id stores, so the page keeps this record beside the saved start
 * (`EdgeNode.nodeLocalRecords()`) and rebuilds the rows' marks from it when the strand is
 * published again.
 */

import type { DurableSlot } from '@serfab/cadre-core';
import { kvStoreSlot, type KvStoreApi } from '@serfab/cadre-core/edge-node';

/** One queued message. */
export interface QueuedMessage {
	strandId: string;
	transactionId: string;
	messageId: string;
	content: string;
}

// Dot-free: keys of the form `<record>.<partyId>` are the edge node's.
const QUEUED_MESSAGES_KEY = 'chat-queued-messages';

/**
 * Create one per tab. Calls run one at a time, so a message added while another is being removed
 * is not lost to a read-modify-write race, and a removal called after an add lands after it.
 */
export class QueuedMessageRecord {
	private turn: Promise<unknown> = Promise.resolve();
	private readonly slot: DurableSlot;

	constructor(kv: KvStoreApi) {
		this.slot = kvStoreSlot(kv, QUEUED_MESSAGES_KEY);
	}

	add(message: QueuedMessage): Promise<void> {
		return this.update((all) => [...all.filter((m) => m.transactionId !== message.transactionId), message]);
	}

	remove(transactionId: string): Promise<void> {
		return this.update((all) => all.filter((m) => m.transactionId !== transactionId));
	}

	/** The strand's queued messages. */
	forStrand(strandId: string): Promise<QueuedMessage[]> {
		return this.inTurn(async () => (await this.read()).filter((m) => m.strandId === strandId));
	}

	private update(change: (all: QueuedMessage[]) => QueuedMessage[]): Promise<void> {
		return this.inTurn(async () => {
			const all = await this.read();
			const next = change(all);
			if (next.length !== all.length || next.some((m, i) => m !== all[i])) await this.slot.save(JSON.stringify(next));
		});
	}

	private inTurn<T>(op: () => Promise<T>): Promise<T> {
		const result = this.turn.then(op);
		this.turn = result.catch(() => undefined);
		return result;
	}

	private async read(): Promise<QueuedMessage[]> {
		const text = await this.slot.load();
		return text === undefined ? [] : parseQueuedMessages(text);
	}
}

/** The saved list, or an empty one, logged, when it is not one: the marks are a convenience, the rows are the data. */
function parseQueuedMessages(text: string): QueuedMessage[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.warn('[queued-messages] the record is not JSON; reading it as none:', err);
		return [];
	}
	if (Array.isArray(parsed) && parsed.every(isQueuedMessage)) return parsed;
	console.warn('[queued-messages] the record has the wrong shape; reading it as none:', text);
	return [];
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
	if (typeof value !== 'object' || value === null) return false;
	const { strandId, transactionId, messageId, content } = value as Record<string, unknown>;
	return typeof strandId === 'string' && typeof transactionId === 'string' && typeof messageId === 'string' && typeof content === 'string';
}
