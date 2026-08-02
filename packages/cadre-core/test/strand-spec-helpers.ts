import { afterEach } from 'vitest';
import debug from 'debug';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import { bootstrapFounderMembership, generateStrandStampId } from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Shared setup for the `strand-*.spec.ts` suites: opening a real strand DB in
 * bootstrap mode (libp2p node + MemoryRawStorage + the optimystic local
 * transactor) via `connectToStrand` — the same path `StrandDatabase` uses —
 * and the small raw-write/read helpers those suites build on.
 */

const log = debug('sereus:cadre:test:strand-spec-helpers');

export function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig {
  return {
    id: 'sapp-author-pubkey',
    version: '1.2.3',
    schema: 'table Note (Id integer primary key, Body text not null)',
    signature: 'sapp-signature',
    ...overrides,
  };
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
export function freshKeyPair(): Ed25519KeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

export type StrandTable = 'Header' | 'Member' | 'Manager' | 'MemberPeer' | 'Invite'
  | 'ConsumedInvite' | 'CancelledInvite' | 'Revocation';

export async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

interface ShutdownHandle {
  shutdown: () => Promise<void>;
}

export interface Strand extends ShutdownHandle {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Manager. */
  founder: Ed25519KeyPair;
}

export interface RawStrand extends ShutdownHandle {
  db: Database;
  strandId: string;
}

const opened: ShutdownHandle[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
export async function openStrand(type: 'o' | 'c' = 'c'): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(db, {
    strandId,
    type,
    sApp: makeSAppConfig(),
    founderKeyPair: type === 'c' ? founder : undefined,
  });
  const strand: Strand = {
    db,
    strandId,
    founder,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

/**
 * Open a strand DB in bootstrap mode WITHOUT the founder bootstrap — no Header,
 * no Member, no Manager. For tests that need a member set with NO manager at
 * all (`bootstrapFounderMembership` always seats a founding Manager, and any
 * Manager row makes `NotAManager` fire alongside the floor under test).
 */
export async function openRawStrand(): Promise<RawStrand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const strand: RawStrand = {
    db,
    strandId,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

/**
 * Insert the singleton `Header` with the given Type. Every Header column is NOT
 * NULL (Quereus defaults unqualified columns to NOT NULL), so all are supplied
 * with placeholder values — only `Type` is load-bearing here.
 */
export async function insertHeader(db: Database, type: 'o' | 'c'): Promise<void> {
  await db.exec(
    `insert into Strand.Header
       (Id, Type, sAppId, sAppVersion, sAppSchema, sAppSignature, Engine, EngineVersion)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['strand-id', type, 'sapp', '1.0.0', 'schema', 'sig', 'engine', '1.0.0'],
  );
}

/** Raw `Member` insert with all-null context (the bootstrap-branch shape) and a fresh stamp. */
export async function rawInsertMember(db: Database, key: string): Promise<void> {
  await db.exec(
    `insert into Strand.Member (Key, StampId)
       with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
       values (?, ?)`,
    [key, generateStrandStampId()],
  );
}

/** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
export async function inTransaction(db: Database, statements: () => Promise<void>): Promise<void> {
  await db.beginTransaction();
  try {
    await statements();
    await db.commit();
  } catch (error) {
    // A failed commit() already tore the transaction down, so rollback() throws
    // "no transaction active" — log it rather than masking the real cause.
    try {
      await db.rollback();
    } catch (rollbackError) {
      log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
    }
    throw error;
  }
}
