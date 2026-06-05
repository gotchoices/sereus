/**
 * chat-operations.ts — Quereus wrappers for the simplified chat sApp.
 *
 * Operates on the StrandDatabase exposed by a StrandInstance.  The schema
 * tables live under the `App` schema namespace (StrandDatabase wraps the raw
 * DDL in `declare schema App { … }; apply schema App;`).
 */

import type { StrandInstance } from '@serfab/cadre-core';
import type { Database } from '@quereus/quereus';
import { uuid } from './uuid';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  /** Globally-unique text id (UUID) — generated locally, collision-free across peers. */
  Id: string;
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
    throw new Error(`Strand ${strand.strandId} database not available (status: ${strand.status})`);
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
  await db.exec(
    'insert or ignore into App.Member (Id, Name) values (?, ?)',
    [id, name],
  );
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

  // Generate the primary key locally as a UUID. A read-then-increment of
  // max(Id) would collide when two peers post concurrently into a shared
  // strand, since each reads the same local max before either replicates.
  const id = uuid();

  await db.exec(
    `insert into App.Message (Id, MemberId, Content, Timestamp)
     values (?, ?, ?, ?)`,
    [id, memberId, content, now],
  );

  return {
    Id: id,
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

  // Order by Timestamp (the text UUID Id is not chronologically sortable).
  // Id is only a stable tiebreak: Timestamp has second resolution, so two
  // peers posting within the same second converge to an arbitrary-but-stable
  // order. Acceptable for the reference app.
  for await (const row of db.eval(
    `select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
     from App.Message M
     left join App.Member Mem on Mem.Id = M.MemberId
     order by M.Timestamp asc, M.Id asc
     limit ?`,
    [limit],
  )) {
    messages.push({
      Id: row.Id as string,
      MemberId: row.MemberId as string,
      Content: row.Content as string,
      Timestamp: row.Timestamp as string,
      MemberName: (row.MemberName as string) ?? undefined,
    });
  }

  return messages;
}

