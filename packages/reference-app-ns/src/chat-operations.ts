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
	Id: number;
	MemberId: string;
	Content: string;
	Timestamp: string;
	/** Joined from Member table when available */
	MemberName?: string;
}

export interface ChatMember {
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

// ── Member operations ────────────────────────────────────────────────────────

/**
 * Register a member in the chat strand.
 *
 * @param strand  Active strand instance
 * @param id      Unique member identifier (typically peerId or a UUID)
 * @param name    Display name
 */
export async function insertMember(
	strand: StrandInstance,
	id: string,
	name: string,
): Promise<void> {
	const db = getDb(strand);
	await db.exec('insert or ignore into App.Member (Id, Name) values (?, ?)', [id, name]);
}

/**
 * Query all members.
 */
export async function queryMembers(strand: StrandInstance): Promise<ChatMember[]> {
	const db = getDb(strand);
	const members: ChatMember[] = [];
	for await (const row of db.eval('select Id, Name from App.Member')) {
		members.push({ Id: row.Id as string, Name: row.Name as string });
	}
	return members;
}

// ── Message operations ───────────────────────────────────────────────────────

/**
 * Insert a chat message.
 *
 * @param strand    Active strand instance
 * @param memberId  The sending member's Id
 * @param content   Message text
 * @returns         The inserted message
 */
export async function insertMessage(
	strand: StrandInstance,
	memberId: string,
	content: string,
): Promise<ChatMessage> {
	const db = getDb(strand);
	// Quereus DATETIME expects 'YYYY-MM-DD HH:MM:SS', not ISO 8601 with 'T' / 'Z'.
	const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

	const maxRow = await db.get('select max(Id) as MaxId from App.Message');
	const nextId = ((maxRow?.MaxId as number | null) ?? 0) + 1;

	await db.exec(
		`insert into App.Message (Id, MemberId, Content, Timestamp)
     values (?, ?, ?, ?)`,
		[nextId, memberId, content, now],
	);

	return {
		Id: nextId,
		MemberId: memberId,
		Content: content,
		Timestamp: now,
	};
}

/**
 * Query messages, most recent last.  Optionally join member names.
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

	for await (const row of db.eval(
		`select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
     from App.Message M
     left join App.Member Mem on Mem.Id = M.MemberId
     order by M.Id asc
     limit ?`,
		[limit],
	)) {
		messages.push({
			Id: row.Id as number,
			MemberId: row.MemberId as string,
			Content: row.Content as string,
			Timestamp: row.Timestamp as string,
			MemberName: (row.MemberName as string) ?? undefined,
		});
	}

	return messages;
}
