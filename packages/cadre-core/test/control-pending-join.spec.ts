import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { isPendingJoinConflict, pendingJoinId, PendingJoinChangedError } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { PendingJoinRow } from '../src/types.js';
import { expectConstraintFailure, freshKeyPair, signAs, type KeyPair } from './control-constraint-helpers.js';

/**
 * Authorization, outcome-shape and replace coverage for `CadreControl.PendingJoin` — the
 * party-wide record of a join this party asked for. The single-use-stamp rules it shares with
 * `JoinedStrand` (`NoUpdate`, `RevocationRecorded`, `NotRevoked`) are pinned there; the reap
 * branch is covered in `control-revocation-reap.spec.ts` and the `RowIsGone` branch in
 * `control-revocation-replay.spec.ts`.
 */
describe('PendingJoin (owner-signed, outcome written by replacement)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let owner: KeyPair;

  const asOwner = (message: Uint8Array): string => signAs(owner, message);
  const rand = (): string => Math.random().toString(36).slice(2);

  function pendingRow(): Omit<PendingJoinRow, 'StampId'> {
    const requestedAt = Date.now();
    return {
      Id: pendingJoinId('token-' + rand()),
      Invitation: 'invitation-' + rand(),
      Disclosure: '{}',
      RequestedAt: requestedAt,
      ExpiresAt: requestedAt + 86_400_000,
      Outcome: null,
      OutcomeAt: null,
      StrandId: null,
      MembershipInvite: null,
      FailureCode: null,
      FailureReason: null,
    };
  }

  function joined(row: Omit<PendingJoinRow, 'StampId'>): Omit<PendingJoinRow, 'StampId'> {
    return {
      ...row,
      Outcome: 'joined',
      OutcomeAt: Date.now(),
      StrandId: 'strand-' + rand(),
      MembershipInvite: JSON.stringify({ inviteKey: 'invite-key', invitePrivateKey: 'invite-private-key' }),
    };
  }

  async function pendingJoinCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.PendingJoin');
    return Number(row?.c ?? 0);
  }

  /** Enroll a machine of the party the legitimate way (owner-vouched), carrying `machine` as its key. */
  async function admitMachine(machine: KeyPair): Promise<void> {
    const admitted = await db.insertCadrePeer(
      { peerId: '12D3KooWPendingJoinMachine' + rand(), publicKey: machine.publicKey, multiaddr: '', updatedAt: Date.now(), sig: null },
      owner.publicKey,
      asOwner,
    );
    expect(admitted).toBe(true);
  }

  beforeAll(async () => {
    owner = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'pending-join-' + rand(),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();
    expect(await db.ensureOwnerKey(owner.publicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('an owner-signed row lands and reads back whole; the same row signed by an enrolled machine that is not an owner is refused (AuthorizedInsert)', async () => {
    const written = await db.insertPendingJoin(pendingRow(), owner.publicKey, asOwner);
    expect(await db.queryPendingJoin(written.Id)).toEqual(written);
    expect(await db.queryPendingJoins()).toEqual(expect.arrayContaining([written]));

    // A correctly formed signature, by a key the party enrolled as a machine. Only an
    // OwnerKey row authorizes a write here (tickets/blocked/decide-non-owner-machine-completes-a-pending-join.md).
    const machine = freshKeyPair();
    await admitMachine(machine);
    const before = await pendingJoinCount();
    await expectConstraintFailure(db.insertPendingJoin(pendingRow(), machine.publicKey, m => signAs(machine, m)), 'AuthorizedInsert');
    expect(await pendingJoinCount()).toBe(before);
  });

  it('a second request for the same invitation is classified as a PendingJoin conflict', async () => {
    // The caller adopts the existing row on exactly this classification, so pin it against
    // the live engine error.
    const row = pendingRow();
    await db.insertPendingJoin(row, owner.publicKey, asOwner);
    const error = await db.insertPendingJoin(row, owner.publicKey, asOwner).then(() => undefined, (e: unknown) => e);
    expect(isPendingJoinConflict(error)).toBe(true);
  });

  it('refuses a row whose columns do not fit its outcome (OutcomeShape)', async () => {
    const before = await pendingJoinCount();
    await expectConstraintFailure(
      db.insertPendingJoin({ ...joined(pendingRow()), StrandId: null }, owner.publicKey, asOwner),
      'OutcomeShape',
    );
    await expectConstraintFailure(
      db.insertPendingJoin({ ...pendingRow(), FailureCode: 'token-spent' }, owner.publicKey, asOwner),
      'OutcomeShape',
    );
    expect(await pendingJoinCount()).toBe(before);
  });

  it('replacePendingJoin turns a pending row into a joined one: the old stamp is retired and the new row is live', async () => {
    const pending = await db.insertPendingJoin(pendingRow(), owner.publicKey, asOwner);

    const written = await db.replacePendingJoin(pending.StampId, joined(pending), owner.publicKey, asOwner);

    expect(written.StampId).not.toBe(pending.StampId);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(written);
    expect((await db.queryRevokedStamps('PendingJoin')).has(pending.StampId)).toBe(true);
  });

  it('replacePendingJoin naming a stamp that is no longer live throws PendingJoinChangedError and writes nothing', async () => {
    const pending = await db.insertPendingJoin(pendingRow(), owner.publicKey, asOwner);
    const current = await db.replacePendingJoin(pending.StampId, joined(pending), owner.publicKey, asOwner);
    const revokedBefore = await db.queryRevokedStamps('PendingJoin');

    const failed = { ...pending, Outcome: 'failed' as const, OutcomeAt: Date.now(), FailureCode: 'token-spent', FailureReason: 'spent' };
    const error = await db.replacePendingJoin(pending.StampId, failed, owner.publicKey, asOwner).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(PendingJoinChangedError);
    expect((error as PendingJoinChangedError).liveStampId).toBe(current.StampId);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(current);
    expect(await db.queryRevokedStamps('PendingJoin')).toEqual(revokedBefore);
  });
});
