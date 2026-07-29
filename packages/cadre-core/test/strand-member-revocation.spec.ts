import { describe, it, expect, afterEach } from 'vitest';
import debug from 'debug';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import {
  bootstrapFounderMembership,
  issueInvite,
  consumeInvite,
  addMemberByManager,
  revokeMember,
  leaveStrand,
  addManager,
  removeManager,
  signStrandMemberAction,
} from '../src/strand-membership-writer.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';
import type { SAppConfig } from '../src/types.js';

/**
 * Component coverage for `Strand.Member` REMOVAL — the authorization gate closed
 * by `bug-strand-member-delete-unauthorized`. Before that fix, `Member` DELETEs
 * passed through zero constraints: anyone could evict anyone (or everyone), and a
 * revoked invite-member could re-admit itself off its stale `ConsumedInvite` row.
 *
 * Every test runs against a REAL closed strand DB in bootstrap mode (libp2p node +
 * MemoryRawStorage + the optimystic local transactor) via `connectToStrand` — the
 * same path `StrandDatabase` uses — so the real apply/DML/deferred-constraint path
 * is exercised, not a fake.
 *
 * Constraint names are pinned (`rejects.toThrow(/Name/)`) ONLY where exactly one
 * constraint can fire; where several can, only the fact of a CHECK rejection is
 * pinned.
 */

const log = debug('sereus:cadre:test:strand-revocation');

function makeSAppConfig(overrides: Partial<SAppConfig> = {}): SAppConfig {
  return {
    id: 'sapp-author-pubkey',
    version: '1.2.3',
    schema: 'table Note (Id integer primary key, Body text not null)',
    signature: 'sapp-signature',
    ...overrides,
  };
}

/** A fresh, unrelated ed25519 keypair in the base64url shape the constraints consume. */
function freshKeyPair(): Ed25519KeyPair {
  const privateKeyB64 = generatePrivateKey('ed25519', 'base64url') as string;
  const publicKeyB64 = getPublicKey(privateKeyB64, 'ed25519', 'base64url', 'base64url') as string;
  return { privateKeyB64, publicKeyB64 };
}

type StrandTable = 'Header' | 'Member' | 'Manager' | 'ConsumedInvite';

async function tableCount(db: Database, table: StrandTable): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

/** True iff a `Member` row exists for this key. */
async function isMemberRow(db: Database, key: string): Promise<boolean> {
  return (await db.get('select Key from Strand.Member where Key = ?', [key])) != null;
}

interface Strand {
  db: Database;
  strandId: string;
  /** The founder keypair — Member #1 and the sole founding Manager. */
  founder: Ed25519KeyPair;
  shutdown: () => Promise<void>;
}

const opened: Strand[] = [];

/** Open a strand DB in bootstrap mode and run the founder bootstrap for the type. */
async function openStrand(type: 'o' | 'c'): Promise<Strand> {
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
async function openRawStrand(): Promise<Strand> {
  const strandId = randomUUID();
  const storage = new MemoryRawStorage();
  const db = new Database();
  const result = await connectToStrand(db, { strandId, mode: 'bootstrap', storage });
  const strand: Strand = {
    db,
    strandId,
    founder: freshKeyPair(), // unused — no bootstrap ran
    shutdown: async () => {
      await result.shutdown();
      db.close();
    },
  };
  opened.push(strand);
  return strand;
}

afterEach(async () => {
  while (opened.length > 0) {
    const strand = opened.pop()!;
    await strand.shutdown();
  }
});

/**
 * Insert the singleton `Header` with the given Type. Every Header column is NOT
 * NULL (Quereus defaults unqualified columns to NOT NULL), so all are supplied
 * with placeholder values — only `Type` is load-bearing here.
 */
async function insertHeader(db: Database, type: 'o' | 'c'): Promise<void> {
  await db.exec(
    `insert into Strand.Header
       (Id, Type, sAppId, sAppVersion, sAppSchema, sAppSignature, Engine, EngineVersion)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['strand-id', type, 'sapp', '1.0.0', 'schema', 'sig', 'engine', '1.0.0'],
  );
}

/** Raw `Member` delete with caller-chosen context — what an attacker controls. */
async function rawDeleteMember(
  db: Database,
  key: string,
  context: { managerKey?: string; managerSignature?: string; memberSignature?: string } = {},
): Promise<void> {
  await db.exec(
    `delete from Strand.Member
       with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = ?
       where Key = ?`,
    [context.managerKey ?? null, context.managerSignature ?? null, context.memberSignature ?? null, key],
  );
}

/** Raw all-null-context `Member` insert — the bootstrap-branch shape. */
async function rawInsertMember(db: Database, key: string): Promise<void> {
  await db.exec(
    `insert into Strand.Member (Key)
       with context ManagerKey = null, ManagerSignature = null, MemberSignature = null
       values (?)`,
    [key],
  );
}

/** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
async function inTransaction(db: Database, statements: () => Promise<void>): Promise<void> {
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

// ── Unauthorized removal is rejected (the original bug) ───────────────────────

describe('Member removal authorization', () => {
  it('rejects an unsigned (all-null context) removal of a non-manager member', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(2);

    // The pre-fix schema accepted exactly this. MinOneMember (1 remains) and
    // NotAManager (the target holds no Manager row) both pass, so Authorized is
    // the only constraint that can reject — pinning the name proves the gate fired.
    await expect(rawDeleteMember(db, member.publicKeyB64)).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a removal that names a REAL manager but carries a stranger\'s signature', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    const stranger = freshKeyPair();

    // The near-miss of the stranger-as-ManagerKey case below: context.ManagerKey
    // IS a committed manager, so the subquery finds its row — but verify runs
    // against A.MemberKey (the founder's key), not against whoever produced the
    // signature, so a stranger-minted approval cannot ride a borrowed identity.
    await expect(
      rawDeleteMember(db, member.publicKeyB64, {
        managerKey: founder.publicKeyB64,
        managerSignature: signStrandMemberAction('remove', member.publicKeyB64, stranger.privateKeyB64),
      }),
    ).rejects.toThrow(/Authorized/);

    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a manager removal approval minted for a DIFFERENT member key', async () => {
    const { db, founder } = await openStrand('c');
    const approved = freshKeyPair();
    const victim = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: approved.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: victim.publicKeyB64 });

    // A genuine founder approval — but minted over `approved`, presented on the
    // delete of `victim`. The digest binds old.Key, so an approval is per-target:
    // holding one member's eviction approval never evicts another.
    await expect(
      rawDeleteMember(db, victim.publicKeyB64, {
        managerKey: founder.publicKeyB64,
        managerSignature: signStrandMemberAction('remove', approved.publicKeyB64, founder.privateKeyB64),
      }),
    ).rejects.toThrow(/Authorized/);

    expect(await isMemberRow(db, victim.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, approved.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a multi-row delete carrying an approval for only ONE of the targets', async () => {
    const { db, founder } = await openStrand('c');
    const approved = freshKeyPair();
    const collateral = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: approved.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: collateral.publicKeyB64 });

    // Authorized is evaluated per ROW, so one valid approval cannot carry a batch:
    // `collateral`'s row finds no branch and the whole statement rolls back —
    // including the row the approval WAS minted for.
    await expect(
      db.exec(
        `delete from Strand.Member
           with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
           where Key in (?, ?)`,
        [
          founder.publicKeyB64,
          signStrandMemberAction('remove', approved.publicKeyB64, founder.privateKeyB64),
          approved.publicKeyB64,
          collateral.publicKeyB64,
        ],
      ),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Member')).toBe(3);
    expect(await isMemberRow(db, approved.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, collateral.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a removal signed by a stranger binding itself as ManagerKey', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    const stranger = freshKeyPair();

    // A perfectly-formed remove-tagged signature — but the signer holds no
    // committed Manager row, so the manager-removal branch finds no authorizer.
    const signature = signStrandMemberAction('remove', member.publicKeyB64, stranger.privateKeyB64);
    await expect(
      rawDeleteMember(db, member.publicKeyB64, {
        managerKey: stranger.publicKeyB64,
        managerSignature: signature,
      }),
    ).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a mass delete of the whole Member table (null context)', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(2);

    // The pre-fix schema accepted this too — a total denial of service (Member is
    // the strand's read gate). Several constraints can fire (Authorized on every
    // row, NotAManager on the founder, MinOneMember on the emptied table); which
    // reports first is engine evaluation order, so only the rejection is pinned.
    await expect(
      db.exec(
        `delete from Strand.Member
           with context ManagerKey = null, ManagerSignature = null, MemberSignature = null`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, founder.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects a same-transaction wipe-then-seat and rolls the whole batch back', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    const attacker = freshKeyPair();

    // Wipe every member and seat the attacker in ONE transaction: the attacker's
    // insert cannot ride the bootstrap branch — it is gated on the PRE-transaction
    // (committed) member set, which is non-empty regardless of the same-txn wipe.
    await expect(inTransaction(db, async () => {
      await db.exec(
        `delete from Strand.Member
           with context ManagerKey = null, ManagerSignature = null, MemberSignature = null`,
      );
      await rawInsertMember(db, attacker.publicKeyB64);
    })).rejects.toThrow(/CHECK constraint failed/);

    // The rollback restores the pre-existing rows and admits nobody.
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, founder.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, attacker.publicKeyB64)).toBe(false);
  }, 30_000);
});

// ── The unauthenticated bootstrap branch seats exactly ONE member ─────────────

describe('founding bootstrap branch', () => {
  it('seats the founding member with no signature', async () => {
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    const founding = freshKeyPair();

    await rawInsertMember(db, founding.publicKeyB64);

    expect(await tableCount(db, 'Member')).toBe(1);
  }, 30_000);

  it('rejects a founding transaction that seats MORE than one member unauthenticated', async () => {
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    const first = freshKeyPair();
    const second = freshKeyPair();

    // The committed member set is empty for BOTH inserts, so the pre-image gate
    // alone would waive authorization for an unbounded batch. The branch's
    // post-image cap is what holds the waiver to a single seat.
    await expect(inTransaction(db, async () => {
      await rawInsertMember(db, first.publicKeyB64);
      await rawInsertMember(db, second.publicKeyB64);
    })).rejects.toThrow(/Authorized/);

    expect(await tableCount(db, 'Member')).toBe(0);
  }, 30_000);
});

// ── Authorized removal paths (manager revocation + self-departure) ────────────

describe('revokeMember / leaveStrand', () => {
  it('a manager revokes a member and removes ONLY the targeted row', async () => {
    const { db, founder } = await openStrand('c');
    const keep = freshKeyPair();
    const target = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: keep.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: target.publicKeyB64 });
    expect(await tableCount(db, 'Member')).toBe(3);

    await revokeMember(db, { managerKeyPair: founder, memberKey: target.publicKeyB64 });

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, target.publicKeyB64)).toBe(false);
    expect(await isMemberRow(db, keep.publicKeyB64)).toBe(true);
    expect(await isMemberRow(db, founder.publicKeyB64)).toBe(true);
  }, 30_000);

  it('a member leaves by self-signature; another member cannot sign its departure', async () => {
    const { db, founder } = await openStrand('c');
    const memberB = freshKeyPair();
    const memberC = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: memberB.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: memberC.publicKeyB64 });

    // Member C signs the remove-tagged payload over B's key and presents it as
    // MemberSignature: the self-departure branch verifies against old.Key (= B),
    // so C's signature fails — verify pins the signer to the departing key itself.
    // MinOneMember (2 remain) and NotAManager (B holds no Manager row) pass, so
    // Authorized is the only possible rejector.
    const cSignsB = signStrandMemberAction('remove', memberB.publicKeyB64, memberC.privateKeyB64);
    await expect(
      rawDeleteMember(db, memberB.publicKeyB64, { memberSignature: cSignsB }),
    ).rejects.toThrow(/Authorized/);
    expect(await isMemberRow(db, memberB.publicKeyB64)).toBe(true);

    // B's OWN self-signature (via the writer) is accepted.
    await leaveStrand(db, { memberKeyPair: memberB });

    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await isMemberRow(db, memberB.publicKeyB64)).toBe(false);
    expect(await isMemberRow(db, memberC.publicKeyB64)).toBe(true);
  }, 30_000);
});

// ── Action-tag replay (an approval verifies only for the rule it was minted for) ──

describe('Member action-tag domain separation', () => {
  it('an "add" approval cannot be replayed as a removal', async () => {
    const { db, founder } = await openStrand('c');
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

    // The exact signature addMemberByManager minted for the admission, captured
    // and presented on a delete: the remove branch hashes the 'remove' tag, so
    // verify fails. The other delete constraints pass — Authorized is the pin.
    const addSignature = signStrandMemberAction('add', member.publicKeyB64, founder.privateKeyB64);
    await expect(
      rawDeleteMember(db, member.publicKeyB64, {
        managerKey: founder.publicKeyB64,
        managerSignature: addSignature,
      }),
    ).rejects.toThrow(/Authorized/);
    expect(await isMemberRow(db, member.publicKeyB64)).toBe(true);
  }, 30_000);

  it('a "remove" approval cannot be replayed as an admission', async () => {
    const { db, founder } = await openStrand('c');
    const target = freshKeyPair();

    // A genuine founder remove-approval over the key, presented on an INSERT:
    // the add branch hashes the 'add' tag, so verify fails; the bootstrap branch
    // is off (the committed member set is non-empty) and no invite exists.
    const removeSignature = signStrandMemberAction('remove', target.publicKeyB64, founder.privateKeyB64);
    await expect(
      db.exec(
        `insert into Strand.Member (Key)
           with context ManagerKey = ?, ManagerSignature = ?, MemberSignature = null
           values (?)`,
        [founder.publicKeyB64, removeSignature, target.publicKeyB64],
      ),
    ).rejects.toThrow(/Authorized/);
    expect(await isMemberRow(db, target.publicKeyB64)).toBe(false);
  }, 30_000);
});

// ── Revocation is durable: a stale ConsumedInvite row no longer re-admits ─────

describe('re-admission after revocation', () => {
  it('a revoked invite-member cannot re-insert itself off its stale ConsumedInvite row', async () => {
    const { db, founder } = await openStrand('c');
    const joiner = freshKeyPair();
    const { inviteKey, invitePrivateKey } = await issueInvite(db, { managerKeyPair: founder });
    await consumeInvite(db, { inviteKey, invitePrivateKey, memberKey: joiner.publicKeyB64 });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(true);

    await revokeMember(db, { managerKeyPair: founder, memberKey: joiner.publicKeyB64 });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(false);
    // The ConsumedInvite row survives (it is InsertOnly) — the old invite branch
    // would have re-admitted the joiner off it. The freshness clause (the
    // admitting ConsumedInvite's InviteKey must be absent from the committed
    // snapshot) makes the stale row inert.
    expect(await tableCount(db, 'ConsumedInvite')).toBe(1);

    await expect(rawInsertMember(db, joiner.publicKeyB64)).rejects.toThrow(/Authorized/);
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(false);

    // Re-admission takes a fresh MANAGER action — the direct-admit path works.
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: joiner.publicKeyB64 });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(true);
  }, 30_000);

  it('a revoked member re-admits ITSELF off an invite it held but never consumed', async () => {
    const { db, founder } = await openStrand('c');
    const joiner = freshKeyPair();

    // Two invites issued; the joiner consumes one and pockets the other. Invites
    // are bearer tokens with no deactivation path (`Strand.Invite`'s own TODO), so
    // the spare survives the revocation and re-admits its holder with no further
    // manager action. Revocation is NOT a re-entry gate while a member holds any
    // unconsumed invite — tracked as `feat-strand-invite-revocation`.
    const spent = await issueInvite(db, { managerKeyPair: founder });
    const spare = await issueInvite(db, { managerKeyPair: founder });
    await consumeInvite(db, {
      inviteKey: spent.inviteKey,
      invitePrivateKey: spent.invitePrivateKey,
      memberKey: joiner.publicKeyB64,
    });

    await revokeMember(db, { managerKeyPair: founder, memberKey: joiner.publicKeyB64 });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(false);

    await consumeInvite(db, {
      inviteKey: spare.inviteKey,
      invitePrivateKey: spare.invitePrivateKey,
      memberKey: joiner.publicKeyB64,
    });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(true);
  }, 30_000);

  it('a FRESH invite re-admits a revoked member (freshness clause spares legitimate joins)', async () => {
    const { db, founder } = await openStrand('c');
    const joiner = freshKeyPair();
    const first = await issueInvite(db, { managerKeyPair: founder });
    await consumeInvite(db, {
      inviteKey: first.inviteKey,
      invitePrivateKey: first.invitePrivateKey,
      memberKey: joiner.publicKeyB64,
    });
    await revokeMember(db, { managerKeyPair: founder, memberKey: joiner.publicKeyB64 });
    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(false);

    // A new invite has a new InviteKey, so its consumption is a same-transaction
    // FRESH ConsumedInvite row (ConsumedInvite's PK is InviteKey — the second
    // consume inserts a distinct row beside the stale one).
    const second = await issueInvite(db, { managerKeyPair: founder });
    await consumeInvite(db, {
      inviteKey: second.inviteKey,
      invitePrivateKey: second.invitePrivateKey,
      memberKey: joiner.publicKeyB64,
    });

    expect(await isMemberRow(db, joiner.publicKeyB64)).toBe(true);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(2);
  }, 30_000);
});

// ── Floors: the member set never empties; a manager resigns before leaving ────

describe('MinOneMember / NotAManager', () => {
  it('rejects the SOLE member leaving (min-one-member floor, isolated from NotAManager)', async () => {
    // A raw strand with ONE member and NO manager: bootstrapFounderMembership
    // always seats a founding Manager, and any Manager row would make NotAManager
    // fire too — this shape leaves MinOneMember as the only possible rejector.
    const { db } = await openRawStrand();
    await insertHeader(db, 'c');
    const soleMember = freshKeyPair();
    await rawInsertMember(db, soleMember.publicKeyB64);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Manager')).toBe(0);

    // A perfectly valid self-departure signature — rejected purely because it
    // would empty the member set (the strand's read gate) permanently.
    await expect(
      leaveStrand(db, { memberKeyPair: soleMember }),
    ).rejects.toThrow(/MinOneMember/);

    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await isMemberRow(db, soleMember.publicKeyB64)).toBe(true);
  }, 30_000);

  it('rejects revoking a member that still holds a Manager row (NotAManager)', async () => {
    const { db, founder } = await openStrand('c');
    const manager = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: manager.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: manager.publicKeyB64 });

    // Authorized passes (the founder's remove-approval is valid) and MinOneMember
    // passes (the founder member remains), so NotAManager is the clean pin.
    await expect(
      revokeMember(db, { managerKeyPair: founder, memberKey: manager.publicKeyB64 }),
    ).rejects.toThrow(/NotAManager/);
    expect(await isMemberRow(db, manager.publicKeyB64)).toBe(true);

    // After resigning its Manager row, the same revocation succeeds.
    await removeManager(db, { byManagerKeyPair: manager, targetManagerKey: manager.publicKeyB64 });
    await revokeMember(db, { managerKeyPair: founder, memberKey: manager.publicKeyB64 });
    expect(await isMemberRow(db, manager.publicKeyB64)).toBe(false);
  }, 30_000);

  it('accepts resign + revoke in ONE transaction (NotAManager reads the post-image)', async () => {
    const { db, founder } = await openStrand('c');
    const manager = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: manager.publicKeyB64 });
    await addManager(db, { byManagerKeyPair: founder, newManagerKey: manager.publicKeyB64 });

    // NotAManager is deferred, so it sees the post-image: a single transaction
    // deleting BOTH the Manager and the Member row passes. (The revocation's
    // authorizer is the founder, whose Manager row is committed — the
    // committed.Manager read is satisfied.)
    await inTransaction(db, async () => {
      await removeManager(db, { byManagerKeyPair: manager, targetManagerKey: manager.publicKeyB64 });
      await revokeMember(db, { managerKeyPair: founder, memberKey: manager.publicKeyB64 });
    });

    expect(await isMemberRow(db, manager.publicKeyB64)).toBe(false);
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [manager.publicKeyB64])).toBeUndefined();
    expect(await tableCount(db, 'Manager')).toBe(1); // the founder
  }, 30_000);
});

// ── The committed.* pin: a same-transaction manager cannot authorize ──────────

describe('committed-snapshot authorizer reads', () => {
  it('rejects a revocation authorized by a manager seated in the SAME transaction', async () => {
    const { db, founder } = await openStrand('c');
    const m2 = freshKeyPair();
    const m3 = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: m2.publicKeyB64 });
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: m3.publicKeyB64 });

    // The Manager insert itself is valid (founder-signed promotion), but M2's row
    // is NOT in the pre-transaction snapshot — Member.Authorized reads
    // committed.Manager, so M2 cannot authorize a removal in the transaction that
    // seats it. A plain from-Manager read would have accepted this.
    await expect(inTransaction(db, async () => {
      await addManager(db, { byManagerKeyPair: founder, newManagerKey: m2.publicKeyB64 });
      await revokeMember(db, { managerKeyPair: m2, memberKey: m3.publicKeyB64 });
    })).rejects.toThrow(/Authorized/);

    // The whole transaction rolled back: M2 is not a manager, M3 is still a member.
    expect(await db.get('select MemberKey from Strand.Manager where MemberKey = ?', [m2.publicKeyB64])).toBeUndefined();
    expect(await tableCount(db, 'Manager')).toBe(1);
    expect(await isMemberRow(db, m3.publicKeyB64)).toBe(true);
  }, 30_000);
});
