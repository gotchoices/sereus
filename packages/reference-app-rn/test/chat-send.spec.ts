/**
 * chat-send.spec.ts — a resend after a send whose outcome never came back.
 *
 * A strand write can store the row and then fail to report that it did (a non-final
 * Optimystic `TornActionError`, a lost commit response — the class cadre-core's
 * `reportsPossiblyStoredWrite` refuses to re-run). When the composer minted the message id
 * inside the insert, the user's next press of Send carried a different primary key and the
 * chat showed the message twice, on every peer, permanently.
 *
 * The fake `Database` here is that failure: it stores by `Id`, refuses a duplicate `Id`, and
 * on the first insert stores the row and THEN throws.
 */

import { describe, it, expect } from 'vitest';
import type { StrandInstance } from '@serfab/cadre-core';
import { ChatSender } from '../src/chat-send';

interface StoredRow {
  Id: string;
  ParticipantId: string;
  Content: string;
  Timestamp: string;
}

/**
 * The minimum of Quereus' `Database` that `chat-operations` uses, with a primary key that
 * refuses duplicates and a configurable number of leading inserts that store the row and then
 * throw. Anything else the code under test might run is rejected loudly rather than quietly
 * accepted, so a query changing shape fails here instead of passing against a stub.
 */
class UncertainDatabase {
  readonly rows = new Map<string, StoredRow>();
  private failuresLeft: number;

  constructor(uncertainInserts: number) {
    this.failuresLeft = uncertainInserts;
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (!/^\s*insert into App\.Message\b/.test(sql)) {
      throw new Error(`UncertainDatabase got an unexpected statement: ${sql}`);
    }
    const [id, participantId, content, timestamp] = params as [string, string, string, string];
    if (this.rows.has(id)) {
      throw new Error('UNIQUE constraint failed: App.Message.Id');
    }
    this.rows.set(id, { Id: id, ParticipantId: participantId, Content: content, Timestamp: timestamp });
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      // Stored, and then the outcome never came back. This is the whole point of the fixture.
      throw new Error('TornActionError: commit outcome unknown');
    }
  }

  async *eval(sql: string, params: unknown[] = []): AsyncIterableIterator<Record<string, unknown>> {
    if (!/^\s*select Id from App\.Message where Id = \?/.test(sql)) {
      throw new Error(`UncertainDatabase got an unexpected query: ${sql}`);
    }
    const row = this.rows.get(params[0] as string);
    if (row) yield { Id: row.Id };
  }
}

function fakeStrand(db: UncertainDatabase): StrandInstance {
  return { strandId: 's', database: { getDatabase: () => db } } as unknown as StrandInstance;
}

function contents(db: UncertainDatabase): string[] {
  return [...db.rows.values()].map((r) => r.Content).sort();
}

describe('ChatSender', () => {
  it('stores one row when the same text is sent again after an uncertain failure', async () => {
    const db = new UncertainDatabase(1);
    const sender = new ChatSender();

    await expect(sender.send(fakeStrand(db), 'me', 'hello')).rejects.toThrow(/outcome unknown/);

    const result = await sender.send(fakeStrand(db), 'me', 'hello');

    expect(result.alreadyStored).toBe(true);
    expect(result.message).toBeNull();
    expect(contents(db)).toEqual(['hello']);
  });

  it('mints a new id when the text changed before the resend', async () => {
    const db = new UncertainDatabase(1);
    const sender = new ChatSender();

    await expect(sender.send(fakeStrand(db), 'me', 'hello')).rejects.toThrow(/outcome unknown/);

    // Edited text is a different message: the first attempt did land, under its own id, and
    // reusing that id would report the edit as sent while the stored row kept the old text.
    const result = await sender.send(fakeStrand(db), 'me', 'hello there');

    expect(result.alreadyStored).toBe(false);
    expect(contents(db)).toEqual(['hello', 'hello there']);
  });
});
