/**
 * send-marks.ts — what the Messages page shows under a message this tab sent until the strand's
 * other members hold it, and the line above the list while the strand's offline queue holds
 * anything. Mirrors `reference-app-rn/src/send-marks.ts` (docs/reference-app-rn.md → "Messages
 * Not Yet Delivered").
 */

import type { StrandInstance, StrandOfflineStatus, StrandQueueState } from '@serfab/cadre-core';

type QueuedTransactionStatus = StrandOfflineStatus['status'];
type QueuedFailureReason = Extract<QueuedTransactionStatus, { kind: 'failed' }>['reason'];

/** The mark on one message this tab sent; no mark once another member holds it. */
export type SendMark =
	/**
	 * Queued in this tab in offline mode. `exposed`: another writer could make it fail.
	 * `discardable`: no attempt to send it can have landed, so it can still be withdrawn.
	 */
	| { kind: 'waiting'; exposed: boolean; discardable: boolean }
	| { kind: 'sending' }
	/** Committed, held by no other member yet; `strand:commit-held` clears it. */
	| { kind: 'undelivered' }
	/** Refused when it was sent: its row has left this tab's view. */
	| { kind: 'failed'; reason: string };

/** A message this tab sent, the commit that stores it, and what its row shows. */
export interface SentMessage {
	strandId: string;
	transactionId: string;
	messageId: string;
	content: string;
	mark: SendMark;
}

// A `discarded` failure is the user's own Discard, so it clears the mark instead.
const FAILURE_TEXT: Record<Exclude<QueuedFailureReason, 'discarded'>, string> = {
	constraint: 'a rule of the chat refused it',
	'concurrent-modification': 'another member changed the same data first',
	rejected: 'the other members refused it',
	'too-large': 'it is too large',
	expired: 'it waited too long',
};

/**
 * Whether the strand reports this commit held by no other member yet: the message is lost if this
 * tab's storage goes before one holds it (docs/strands.md, "A commit's durability"). cadre-core
 * updates the record before it emits `strand:commit-held`.
 */
function isHeldOnlyHere(strand: StrandInstance, transactionId: string): boolean {
	const durability = strand.database?.commitDurability(transactionId);
	return durability !== undefined && !durability.heldElsewhere;
}

/**
 * The mark for a message whose insert just returned `transactionId`: the queue's status when the
 * offline queue holds it, else whether the commit is held only here. Call it in the same
 * synchronous step that records the mark, so a status or a `strand:commit-held` that landed while
 * the send's awaits unwound is seen here, and a later one finds the mark to change.
 */
export function markOnSend(strand: StrandInstance, transactionId: string): SendMark | null {
	const status = strand.database?.offline?.status(transactionId);
	if (status) return markForStatus(strand, status, null);
	return isHeldOnlyHere(strand, transactionId) ? { kind: 'undelivered' } : null;
}

/**
 * The mark a status of the message's queued transaction leaves, from `previous`; null clears it.
 * A committed transaction is marked as an online commit is: its durability report reached the
 * strand's record before this status was delivered.
 */
export function markForStatus(strand: StrandInstance | undefined, status: QueuedTransactionStatus, previous: SendMark | null): SendMark | null {
	switch (status.kind) {
		case 'queued':
			return { kind: 'waiting', exposed: status.outlook?.kind === 'exposed', discardable: !status.inDoubt };
		case 'outlook-changed':
			return previous?.kind === 'waiting' ? { ...previous, exposed: status.outlook.kind === 'exposed' } : previous;
		case 'submitting':
		case 'partially-committed':
			return { kind: 'sending' };
		case 'committed':
			return strand && isHeldOnlyHere(strand, status.transactionId) ? { kind: 'undelivered' } : null;
		case 'failed':
			return status.reason === 'discarded' ? null : { kind: 'failed', reason: FAILURE_TEXT[status.reason] };
	}
}

/** Whether the queue is done with the transaction, so nothing will report it again. */
export function isSettled(status: QueuedTransactionStatus): boolean {
	return status.kind === 'committed' || status.kind === 'failed';
}

/** The mark's words under the message. */
export function sendMarkText(mark: SendMark): string {
	switch (mark.kind) {
		case 'waiting':
			return mark.exposed ? 'Waiting to send · May not go through' : 'Waiting to send';
		case 'sending':
			return 'Sending';
		case 'undelivered':
			return 'Not yet delivered';
		case 'failed':
			return `Not sent: ${mark.reason}`;
	}
}

/** The line above the list while the strand's queue holds anything; null while it is empty. */
export function queueStatusLine(state: StrandQueueState['state'] | undefined): string | null {
	if (!state || state.depth === 0) return null;
	const parts = [`${state.depth} waiting to send`];
	if (state.waitingFor === 'cohort') parts.push('waiting for the other members');
	if (state.readsServedLocally) parts.push('showing saved messages');
	return parts.join(' · ');
}
