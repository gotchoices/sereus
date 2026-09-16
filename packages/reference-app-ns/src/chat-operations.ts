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
 * Insert a chat message.
 *
 * @param strand         Active strand instance
 * @param participantId  The sending participant's Id
 * @param content        Message text
 * @returns              The inserted message
 */
export async function insertMessage(
	strand: StrandInstance,
	participantId: string,
	content: string,
): Promise<ChatMessage> {
	const db = getDb(strand);
	// Quereus datetime columns store T-separated ISO form; any valid input coerces on read.
	const now = new Date().toISOString();

	// Generate the primary key locally as a UUID. A read-then-increment of
	// max(Id) is unsafe here: two peers posting concurrently read the same local
	// max before either replicates, and the resulting duplicate key is silently
	// last-writer-wins rather than refused — one message is lost with no error.
	// See docs/schema-guide.md "Ordering Events (There Is No Commit-Order Column)".
	// NativeScript 8.8+ exposes crypto.randomUUID natively.
	const id = crypto.randomUUID();

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
