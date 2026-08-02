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
 *
 * IMPORTING THIS MODULE HAS A SIDE EFFECT: it registers a file-level `afterEach`
 * that shuts down every strand {@link openStrand} / {@link openRawStrand} handed
 * out, so no suite has to write its own teardown. Vitest's default
 * `isolate: true` gives each spec FILE its own module registry, so the `opened`
 * list below is per-file, never shared across files.
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

/** A strand DB with no founder bootstrap run — no Header, no Member, no Manager. */
export interface RawStrand extends ShutdownHandle {
  db: Database;
  strandId: string;
}

export interface Strand extends RawStrand {
  /**
   * The founder keypair. For a closed strand (`type: 'c'`) it is Member #1 and
   * the sole founding Manager; for an open strand (`type: 'o'`) the bootstrap
   * seats no member at all, so this is an unrelated fresh key with no rows
   * behind it.
   */
  founder: Ed25519KeyPair;
}

// NOTE: this list is per-spec-file only because vitest's default `isolate: true`
// gives each file its own module registry. If cadre-core's vitest config ever
// sets `isolate: false`, files sharing a worker would share this array and one
// file's afterEach would tear down another's strands mid-run — move the state
// into a per-file factory then.
const opened: ShutdownHandle[] = [];

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

/**
 * Open a strand DB in bootstrap mode WITHOUT the founder bootstrap — no Header,
 * no Member, no Manager. For tests that seed those rows themselves (to vary the
 * founding order), or that need a member set with NO manager at all
 * (`bootstrapFounderMembership` always seats a founding Manager, and any Manager
 * row makes `NotAManager` fire alongside the floor under test).
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

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
export async function openStrand(type: 'o' | 'c' = 'c'): Promise<Strand> {
  const raw = await openRawStrand();
  const founder = strandMemberKeyPair(await generateStrandMemberKey());
  await bootstrapFounderMembership(raw.db, {
    strandId: raw.strandId,
    type,
    sApp: makeSAppConfig(),
    founderKeyPair: type === 'c' ? founder : undefined,
  });
  // `opened` already holds `raw`, and this copy shares its `shutdown` closure —
  // teardown runs exactly once either way.
  return { ...raw, founder };
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
