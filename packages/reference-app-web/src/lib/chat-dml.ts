/**
 * chat-dml.ts — strand-agnostic DML for the chat sApp (`Participant` + `Message`).
 *
 * Factored out of `messages.svelte.ts` so the exact same insert/select pattern
 * drives BOTH the solo chat strand (the Messages UI) and a **formed** (closed)
 * strand (the formation→convergence e2e hooks in `cadre-web.ts`). These helpers
 * take a Quereus `Database` handle rather than assuming the active solo strand,
 * so the caller resolves the target strand and the DML stays identical across
 * both paths (one source of truth for the schema's `Participant`↔`Message` FK shape).
 */

import type { Database } from '@quereus/quereus';

/** A chat message joined to its author participant, as read from a strand database. */
export interface ChatMessageRow {
	/** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
	id: string;
	participantId: string;
	content: string;
	timestamp: string;
	/** Author display name from the joined `Participant` row, when present. */
	participantName?: string;
}

/**
 * Current timestamp as an ISO string. Quereus datetime columns coerce any valid
 * input (space-form, T-form, ISO-Z) to T-separated form on read — see
 * `canonical-datetime.ts` in cadre-core.
 */
function quereusTimestamp(): string {
	return new Date().toISOString();
}

/**
 * Register (idempotently) the author as a `Participant`, then append a `Message`. The
 * `Participant` row MUST exist before the `Message` insert or the
 * `Message.ParticipantId → Participant.Id` foreign-key check rejects the write — this is
 * load-bearing for a fresh formed strand whose `Participant` table starts empty.
 * `Participant.Id = participantName` keeps the demo single-field while still exercising the
 * FK join. The primary key is generated locally as a UUID: a read-then-increment
 * of `max(Id)` would need a retry loop, because a duplicate key from two concurrent
 * peers is refused — one poster is told `UNIQUE constraint failed` and has to
 * recompute and post again (docs/schema-guide.md, "Ordering Events (There Is No
 * Commit-Order Column)"). Returns the new message id.
 */
export async function insertChatMessage(
	database: Database,
	participantName: string,
	content: string,
): Promise<string> {
	await database.exec('insert or ignore into App.Participant (Id, Name) values (?, ?)', [
		participantName,
		participantName,
	]);
	const id = crypto.randomUUID();
	await database.exec(
		'insert into App.Message (Id, ParticipantId, Content, Timestamp) values (?, ?, ?, ?)',
		[id, participantName, content, quereusTimestamp()],
	);
	return id;
}

/**
 * Read all chat messages joined to their author participant, oldest first. Order by
 * `Timestamp` (the text UUID `Id` is not chronologically sortable); `Id` is only
 * a stable tiebreak, since two peers stamping the same instant (`Timestamp` is an
 * ISO-8601 string, millisecond resolution) converge to an arbitrary-but-stable order.
 *
 * NOTE: `Timestamp` is a client-asserted clock, not a commit order — the engine
 * exposes no commit-order column. See docs/schema-guide.md "Ordering Events
 * (There Is No Commit-Order Column)".
 */
export async function selectChatMessages(database: Database): Promise<ChatMessageRow[]> {
	const messages: ChatMessageRow[] = [];
	for await (const row of database.eval(
		`select M.Id, M.ParticipantId, M.Content, M.Timestamp, P.Name as ParticipantName
		 from App.Message M
		 left join App.Participant P on P.Id = M.ParticipantId
		 order by M.Timestamp asc, M.Id asc`,
	)) {
		messages.push({
			id: row.Id as string,
			participantId: row.ParticipantId as string,
			content: row.Content as string,
			timestamp: row.Timestamp as string,
			participantName: (row.ParticipantName as string) ?? undefined,
		});
	}
	return messages;
}
