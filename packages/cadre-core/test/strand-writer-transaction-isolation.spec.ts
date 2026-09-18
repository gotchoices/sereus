import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import {
  StrandTransactionBusyError,
  addMemberByManager,
  consumeInvite,
  issueInvite,
  registerMemberPeer,
  revokeMember,
  type ConsumeInviteParams,
} from '../src/strand-membership-writer.js';
import { freshKeyPair, inTransaction, openStrand, tableCount } from './strand-spec-helpers.js';

/**
 * A strand's one `Database` is shared by the app and by background membership writers (the
 * bring-up reconciler, the unpublish binding cleanup). These specs pin that a membership write
 * is one indivisible transaction on that shared connection: an app write issued while it is in
 * flight is never swept into it (and so never lost with it), and a writer told to own its
 * transaction never joins one the app has open. Local transactor throughout: the interleaving is
 * a property of the Quereus connection, not of the storage underneath.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** A closed strand with a plain app table next to the `Strand.*` schema. */
async function openAppStrand(): Promise<Awaited<ReturnType<typeof openStrand>>> {
  const strand = await openStrand('c');
  await strand.db.exec('create table Note (Id integer primary key, Body text)');
  return strand;
}

async function noteCount(db: Database): Promise<number> {
  const row = await db.get('select count(*) as c from Note');
  return Number(row?.c ?? 0);
}

/** An invitation credential whose `Invite` row was never issued, so consuming it fails at commit. */
function neverIssuedInvite(memberKey: string): ConsumeInviteParams {
  const invitePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const inviteKey = getPublicKey(invitePrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  return { inviteKey, invitePrivateKey, memberKey };
}

/**
 * Run `appWrite` the moment a writer issues its transaction batch, so the app's statement is
 * queued on the connection directly behind the batch — the interleaving that decides whether
 * the app's write can land inside the writer's transaction.
 */
function queueBehindWriterBatch(db: Database, appWrite: () => Promise<void>): { appWrite: () => Promise<void> } {
  let issued: Promise<void> | undefined;
  const exec = db.exec.bind(db);
  vi.spyOn(db, 'exec').mockImplementation((sql, params, options) => {
    const running = exec(sql, params, options);
    if (issued === undefined && sql.startsWith('begin transaction')) {
      issued = appWrite();
    }
    return running;
  });
  return {
    appWrite: () => {
      expect(issued, 'the writer never issued a transaction batch').toBeDefined();
      return issued!;
    },
  };
}

describe('an app write concurrent with a membership write', () => {
  it('survives a join that fails at commit when issued as the join starts (the reproduced loss)', async () => {
    const { db } = await openAppStrand();
    const joiner = freshKeyPair();

    const consume = consumeInvite(db, neverIssuedInvite(joiner.publicKeyB64));
    await db.exec(`insert into Note (Id, Body) values (1, 'app row')`);
    await expect(consume).rejects.toThrow(/InviteExists/);

    expect(await noteCount(db)).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(db.getAutocommit()).toBe(true);
  }, 30_000);

  it('survives a join that fails at commit when queued directly behind the join\'s batch', async () => {
    const { db } = await openAppStrand();
    const joiner = freshKeyPair();
    const app = queueBehindWriterBatch(db, () => db.exec(`insert into Note (Id, Body) values (1, 'app row')`));

    await expect(consumeInvite(db, neverIssuedInvite(joiner.publicKeyB64))).rejects.toThrow(/InviteExists/);
    await app.appWrite();

    expect(await noteCount(db)).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
    expect(db.getAutocommit()).toBe(true);
  }, 30_000);

  it('is committed alongside a join that succeeds, in either order', async () => {
    const { db, founder } = await openAppStrand();
    const first = freshKeyPair();
    const second = freshKeyPair();
    const firstInvite = await issueInvite(db, { managerKeyPair: founder });
    const secondInvite = await issueInvite(db, { managerKeyPair: founder });

    const consume = consumeInvite(db, { ...firstInvite, memberKey: first.publicKeyB64 });
    await db.exec(`insert into Note (Id, Body) values (1, 'issued as the join starts')`);
    await consume;

    const app = queueBehindWriterBatch(db, () => db.exec(`insert into Note (Id, Body) values (2, 'queued behind the batch')`));
    await consumeInvite(db, { ...secondInvite, memberKey: second.publicKeyB64 });
    await app.appWrite();

    expect(db.getAutocommit()).toBe(true);
    expect(await noteCount(db)).toBe(2);
    expect(await tableCount(db, 'Member')).toBe(3);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(2);
  }, 30_000);
});

describe('a writer that must own its transaction', () => {
  it('refuses, writing nothing, while the app holds an explicit transaction — which then commits intact', async () => {
    const { db, founder } = await openAppStrand();
    const joiner = freshKeyPair();
    const invite = await issueInvite(db, { managerKeyPair: founder });

    await db.beginTransaction();
    await db.exec(`insert into Note (Id, Body) values (1, 'inside the app transaction')`);
    const refusal: unknown = await consumeInvite(db, { ...invite, memberKey: joiner.publicKeyB64 }, { joinOpenTransaction: false })
      .then(() => 'resolved', (error: unknown) => error);
    expect(db.getAutocommit()).toBe(false);
    await db.commit();

    expect(refusal).toBeInstanceOf(StrandTransactionBusyError);
    expect(((refusal as Error).cause as Error).message).toBe('Cannot begin transaction: already in a transaction');
    expect(await noteCount(db)).toBe(1);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);

    // Nothing was tried, so the same invitation still redeems once the app's transaction is closed.
    await consumeInvite(db, { ...invite, memberKey: joiner.publicKeyB64 }, { joinOpenTransaction: false });
    expect(await tableCount(db, 'Member')).toBe(2);
  }, 30_000);

  it('a single-statement writer refuses too, and the app\'s rollback is untouched by it', async () => {
    const { db, founder } = await openAppStrand();

    await db.beginTransaction();
    await db.exec(`insert into Note (Id, Body) values (1, 'rolled back by the app')`);
    await expect(registerMemberPeer(db, { memberKeyPair: founder, peerId: 'founder-machine' }, { joinOpenTransaction: false }))
      .rejects.toBeInstanceOf(StrandTransactionBusyError);
    await db.rollback();

    expect(await noteCount(db)).toBe(0);
    expect(await tableCount(db, 'MemberPeer')).toBe(0);
    expect(db.getAutocommit()).toBe(true);
  }, 30_000);
});

describe('a statement-time failure inside a writer batch', () => {
  it('leaves no transaction open: a join for a key that is already a member collides on the Member key', async () => {
    const { db, founder } = await openAppStrand();
    const invite = await issueInvite(db, { managerKeyPair: founder });

    // `Member`'s primary key refuses the insert at statement time, before `commit` — the failure
    // shape that leaves the batch's own transaction open until the writer rolls it back.
    await expect(consumeInvite(db, { ...invite, memberKey: founder.publicKeyB64 })).rejects.toThrow(/UNIQUE constraint failed/);

    expect(db.getAutocommit()).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'ConsumedInvite')).toBe(0);
    await db.exec(`insert into Note (Id, Body) values (1, 'after the failed batch')`);
    expect(await noteCount(db)).toBe(1);
  }, 30_000);
});

describe('joined mode (the default)', () => {
  it('a writer composed inside a caller\'s transaction commits with it', async () => {
    const { db, founder } = await openAppStrand();
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

    await inTransaction(db, async () => {
      await db.exec(`insert into Note (Id, Body) values (1, 'same transaction')`);
      await revokeMember(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
    });

    expect(await tableCount(db, 'Member')).toBe(1);
    expect(await tableCount(db, 'Revocation')).toBe(1);
    expect(await noteCount(db)).toBe(1);
  }, 30_000);

  it('a writer composed inside a caller\'s transaction rolls back with it', async () => {
    const { db, founder } = await openAppStrand();
    const member = freshKeyPair();
    await addMemberByManager(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });

    await expect(inTransaction(db, async () => {
      await revokeMember(db, { managerKeyPair: founder, memberKey: member.publicKeyB64 });
      expect(await tableCount(db, 'Member')).toBe(1);
      throw new Error('the caller abandons its transaction');
    })).rejects.toThrow(/abandons/);

    expect(db.getAutocommit()).toBe(true);
    expect(await tableCount(db, 'Member')).toBe(2);
    expect(await tableCount(db, 'Revocation')).toBe(0);
  }, 30_000);
});
