import { afterEach } from 'vitest';
import debug from 'debug';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  addMemberByManager,
  bootstrapFounderMembership,
  generateStrandStampId,
  signStrandApproval,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Shared setup for the `strand-*.spec.ts` suites: opening a real strand DB
 * (libp2p node + MemoryRawStorage + an optimystic transactor — local by
 * default, network on request) via `connectToStrand` — the same path
 * `StrandDatabase` uses — and the small raw-write/read helpers those suites
 * build on.
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
  /**
   * The transactor this strand RESOLVED to (read back off the connection, not
   * the value asked for). A spec whose point is the arm it runs on can assert
   * this instead of assuming the option was honoured.
   */
  transactor: StrandTransactor;
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
 * Which optimystic transactor {@link openRawStrand} / {@link openStrand} run
 * on. `'local'` (the default) commits straight to this process's storage with no
 * peer round trips; `'network'` runs the full cluster-coordination path, which a
 * lone node resolves against itself.
 * `strand-membership-network-transactor-parity.spec.ts` uses `'network'` to
 * prove the membership constraints bite identically on both.
 *
 * Narrower than the plugin's own `StrandTransactor` (which also has `'test'`,
 * Optimystic's in-memory fake): these helpers open real strand databases.
 */
export type StrandTransactor = 'local' | 'network';

/**
 * Open a strand DB WITHOUT the founder bootstrap — no Header, no Member, no
 * Manager. For tests that seed those rows themselves (to vary the founding
 * order), or that need a member set with NO manager at all
 * (`bootstrapFounderMembership` always seats a founding Manager, and any Manager
 * row makes `NotAManager` fire alongside the floor under test).
 *
 * Defaults to the local transactor, so no pre-existing suite changes behaviour.
 */
export async function openRawStrand(transactor: StrandTransactor = 'local'): Promise<RawStrand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, transactor, storage });
  const strand: RawStrand = {
    db,
    strandId,
    // The guard below proves these are the same value; this one is typed as the
    // narrower `StrandTransactor` these helpers deal in.
    transactor,
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  // Registered BEFORE the guard so a mismatched strand is still torn down by the
  // afterEach rather than leaking its node and database out of the failing run.
  opened.push(strand);
  // Fail here rather than in the caller: a strand that silently landed the other
  // engine makes every assertion downstream a statement about the wrong thing.
  if (result.transactor !== transactor) {
    throw new Error(
      `openRawStrand asked for the '${transactor}' transactor but the strand resolved to '${result.transactor}' — `
      + 'every assertion below would be about the wrong engine',
    );
  }
  return strand;
}

/** Open a strand DB (default: local transactor) and run the founder bootstrap for the type. */
export async function openStrand(type: 'o' | 'c' = 'c', transactor: StrandTransactor = 'local'): Promise<Strand> {
  const raw = await openRawStrand(transactor);
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

/** The three tables whose rows carry a single-use `StampId` that `Strand.Revocation` can retire. */
export type StampedTable = 'Member' | 'Manager' | 'MemberPeer';

/** The live StampId of one Member row, via unfiltered scan + JS filter (the writer's scan-not-seek idiom). */
export async function memberStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select Key, StampId from Strand.Member')) {
    if (row.Key === key) return row.StampId as string;
  }
  throw new Error(`no Member row for ${key}`);
}

/** The live StampId of one Manager row, via unfiltered scan + JS filter (the writer's scan-not-seek idiom). */
export async function managerStamp(db: Database, key: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, StampId from Strand.Manager')) {
    if (row.MemberKey === key) return row.StampId as string;
  }
  throw new Error(`no Manager row for ${key}`);
}

/** The live StampId of one MemberPeer row, via unfiltered scan + JS filter (the writer's scan-not-seek idiom). */
export async function memberPeerStamp(db: Database, memberKey: string, peerId: string): Promise<string> {
  for await (const row of db.eval('select MemberKey, PeerId, StampId from Strand.MemberPeer')) {
    if (row.MemberKey === memberKey && row.PeerId === peerId) return row.StampId as string;
  }
  throw new Error(`no MemberPeer row for (${memberKey}, ${peerId})`);
}

/** Seat a fresh member (admitted by `founder`) and return its keypair. */
export async function seatMember(db: Database, founder: Ed25519KeyPair): Promise<Ed25519KeyPair> {
  const member = freshKeyPair();
  await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
  return member;
}

/**
 * File the `Strand.Revocation` tombstone retiring `stampId`, signed by `retiree`.
 * (The writer's own tombstone helper is module-private.)
 *
 * A raw delete that pins `/Authorized/` must file one of these in the same
 * transaction — otherwise `RevocationRecorded` fires too and the reported
 * constraint depends on engine evaluation order. `Strand.Revocation` has its own
 * constraint named `Authorized`, so a retiree that is not a committed member
 * fails with that same name.
 */
export async function fileTombstone(
  db: Database,
  tableName: StampedTable,
  stampId: string,
  retiree: Ed25519KeyPair,
): Promise<void> {
  await fileTombstoneNamingAnyTable(db, tableName, stampId, retiree);
}

/** Same insert as {@link fileTombstone}, but `tableName` is any string — only for tests of how the schema confines that column. */
export async function fileTombstoneNamingAnyTable(
  db: Database,
  tableName: string,
  stampId: string,
  retiree: Ed25519KeyPair,
): Promise<void> {
  const signature = signStrandApproval(['Strand.Revocation', 'retire', tableName, stampId], retiree.privateKeyB64);
  await db.exec(
    `insert into Strand.Revocation (TableName, StampId)
       with context MemberKey = ?, Signature = ?
       values (?, ?)`,
    [retiree.publicKeyB64, signature, tableName, stampId],
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
