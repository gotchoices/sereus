/**
 * chat-dml.ts — strand-agnostic DML for the chat sApp (`Member` + `Message`).
 *
 * Factored out of `messages.svelte.ts` so the exact same insert/select pattern
 * drives BOTH the solo chat strand (the Messages UI) and a **formed** (closed)
 * strand (the formation→convergence e2e hooks in `cadre-web.ts`). These helpers
 * take a Quereus `Database` handle rather than assuming the active solo strand,
 * so the caller resolves the target strand and the DML stays identical across
 * both paths (one source of truth for the schema's `Member`↔`Message` FK shape).
 */

import type { Database } from '@quereus/quereus';

/** A chat message joined to its author member, as read from a strand database. */
export interface ChatMessageRow {
	/** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
	id: string;
	memberId: string;
	content: string;
	timestamp: string;
	/** Author display name from the joined `Member` row, when present. */
	memberName?: string;
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
 * Register (idempotently) the author as a `Member`, then append a `Message`. The
 * `Member` row MUST exist before the `Message` insert or the
 * `Message.MemberId → Member.Id` foreign-key check rejects the write — this is
 * load-bearing for a fresh formed strand whose `Member` table starts empty.
 * `Member.Id = memberName` keeps the demo single-field while still exercising the
 * FK join. The primary key is generated locally as a UUID (a read-then-increment
 * of `max(Id)` would collide when two peers post concurrently into a shared
 * strand). Returns the new message id.
 */
export async function insertChatMessage(
	database: Database,
	memberName: string,
	content: string,
): Promise<string> {
	await database.exec('insert or ignore into App.Member (Id, Name) values (?, ?)', [
		memberName,
		memberName,
	]);
	const id = crypto.randomUUID();
	await database.exec(
		'insert into App.Message (Id, MemberId, Content, Timestamp) values (?, ?, ?, ?)',
		[id, memberName, content, quereusTimestamp()],
	);
	return id;
}

/**
 * Read all chat messages joined to their author member, oldest first. Order by
 * `Timestamp` (the text UUID `Id` is not chronologically sortable); `Id` is only
 * a stable tiebreak, since `Timestamp` has second resolution and two peers posting
 * within the same second converge to an arbitrary-but-stable order.
 */
export async function selectChatMessages(database: Database): Promise<ChatMessageRow[]> {
	const messages: ChatMessageRow[] = [];
	for await (const row of database.eval(
		`select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
		 from App.Message M
		 left join App.Member Mem on Mem.Id = M.MemberId
		 order by M.Timestamp asc, M.Id asc`,
	)) {
		messages.push({
			id: row.Id as string,
			memberId: row.MemberId as string,
			content: row.Content as string,
			timestamp: row.Timestamp as string,
			memberName: (row.MemberName as string) ?? undefined,
		});
	}
	return messages;
}
