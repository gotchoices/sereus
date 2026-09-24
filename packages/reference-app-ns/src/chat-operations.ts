/**
 * chat-operations.ts — Quereus wrappers for the simplified chat sApp.
 *
 * Operates on the StrandDatabase exposed by a StrandInstance.  The schema
 * tables live under the `App` schema namespace (StrandDatabase wraps the raw
 * DDL in `declare schema App { … }; apply schema App;`). Ported verbatim from
 * packages/reference-app-rn/src/chat-operations.ts — pure TS, no platform deps.
 */

import type { StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
	/** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
	Id: string;
	ParticipantId: string;
	Content: string;
	Timestamp: string;
	/** Joined from Participant table when available */
	ParticipantName?: string;
}

export interface ChatParticipant {
	Id: string;
	Name: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDb(strand: StrandInstance): Database {
	if (!strand.database) {
		throw new Error(
			`Strand ${strand.strandId} database not available (status: ${strand.status})`,
		);
	}
	return strand.database.getDatabase();
}

// ── Participant operations ───────────────────────────────────────────────────

/**
 * Register a participant in the chat strand.
 *
 * @param strand  Active strand instance
 * @param id      Unique participant identifier (typically peerId or a UUID)
 * @param name    Display name
 */
export async function insertParticipant(
	strand: StrandInstance,
	id: string,
	name: string,
): Promise<void> {
	const db = getDb(strand);
	await db.exec('insert or ignore into App.Participant (Id, Name) values (?, ?)', [id, name]);
}

/**
 * Query all participants.
 */
export async function queryParticipants(strand: StrandInstance): Promise<ChatParticipant[]> {
	const db = getDb(strand);
	const participants: ChatParticipant[] = [];
	for await (const row of db.eval('select Id, Name from App.Participant')) {
		participants.push({ Id: row.Id as string, Name: row.Name as string });
	}
	return participants;
}

// ── Message operations ───────────────────────────────────────────────────────

/**
 * Mint a `Message` primary key locally. A read-then-increment of max(Id) would need a retry
 * loop: two peers posting concurrently read the same local max before either replicates, and
 * the duplicate key is refused — one poster is told UNIQUE constraint failed and has to
 * recompute and post again. See docs/schema-guide.md "Ordering Events (There Is No
 * Commit-Order Column)". NativeScript 8.8+ exposes `crypto.randomUUID` natively.
 *
 * Mint once per message the user composed, NOT once per attempt to store it: a strand write
 * can fail with an outcome nobody can settle (a non-final TornActionError, a lost commit
 * response), so a key minted per attempt turns a manual resend into a second row. See
 * docs/schema-guide.md "Client-Generated Keys and Retrying a Write"; `chat-vm.ts` holds the
 * key across attempts.
 */
export function newChatMessageId(): string {
	return crypto.randomUUID();
}

/**
 * Insert a chat message under the caller's `id`.
 *
 * The key is a parameter rather than something this function invents, so that two attempts at
 * one composed message carry one key and the primary key can refuse the duplicate. See
 * {@link newChatMessageId}.
 *
 * @param strand         Active strand instance
 * @param id             The message's primary key, minted by the caller
 * @param participantId  The sending participant's Id
 * @param content        Message text
 * @returns              The inserted message
 */
export async function insertMessage(
	strand: StrandInstance,
	id: string,
	participantId: string,
	content: string,
): Promise<ChatMessage> {
	const db = getDb(strand);
	// Quereus datetime columns store T-separated ISO form; any valid input coerces on read.
	const now = new Date().toISOString();

	await db.exec(
		`insert into App.Message (Id, ParticipantId, Content, Timestamp)
     values (?, ?, ?, ?)`,
		[id, participantId, content, now],
	);

	return {
		Id: id,
		ParticipantId: participantId,
		Content: content,
		Timestamp: now,
	};
}

/**
 * Whether a message with this id is already stored — the point lookup a resend does before
 * writing, to tell "the earlier attempt never landed" from "it landed but its outcome never
 * came back". One key lookup, and only the resend path pays for it.
 *
 * Deliberately NOT `insert or ignore`: Quereus applies IGNORE to every constraint on the row,
 * matching SQLite, so a foreign-key failure would silently drop the message instead of
 * reporting it.
 */
export async function messageExists(strand: StrandInstance, id: string): Promise<boolean> {
	const db = getDb(strand);
	for await (const _row of db.eval('select Id from App.Message where Id = ?', [id])) {
		return true;
	}
	return false;
}

/**
 * Query messages, most recent last.  Optionally join participant names.
 *
 * @param strand  Active strand instance
 * @param limit   Max messages to return (default 100)
 */
export async function queryMessages(
	strand: StrandInstance,
	limit = 100,
): Promise<ChatMessage[]> {
	const db = getDb(strand);
	const messages: ChatMessage[] = [];

	// Order by Timestamp (the text UUID Id is not chronologically sortable).
	// Id is only a stable tiebreak: Timestamp has second resolution, so two
	// peers posting within the same second converge to an arbitrary-but-stable
	// order. Acceptable for the reference app.
	for await (const row of db.eval(
		`select M.Id, M.ParticipantId, M.Content, M.Timestamp, P.Name as ParticipantName
     from App.Message M
     left join App.Participant P on P.Id = M.ParticipantId
     order by M.Timestamp asc, M.Id asc
     limit ?`,
		[limit],
	)) {
		messages.push({
			Id: row.Id as string,
			ParticipantId: row.ParticipantId as string,
			Content: row.Content as string,
			Timestamp: row.Timestamp as string,
			ParticipantName: (row.ParticipantName as string) ?? undefined,
		});
	}

	return messages;
}
