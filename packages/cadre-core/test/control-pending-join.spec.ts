import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage, isPendingJoinConflict, pendingJoinId, PendingJoinChangedError } from '../src/control-database.js';
import type { ControlDatabase, JoinRequestFields } from '../src/control-database.js';
import type { JoinOutcome, PendingJoin } from '../src/types.js';
import { expectConstraintFailure, freshKeyPair, freshStamp, signAs, type KeyPair } from './control-constraint-helpers.js';

/**
 * Authorization, outcome and rewrite coverage for the pending-join tables: `CadreControl.JoinRequest`
 * and the `JoinSuccess` / `JoinFailure` outcome rows keyed by its stamp. The single-use-stamp rules
 * the request shares with `JoinedStrand` (`NoUpdate`, `RevocationRecorded`, `NotRevoked`) are pinned
 * there; the reap branch is covered in `control-revocation-reap.spec.ts` and the `RowIsGone` branch
 * in `control-revocation-replay.spec.ts`.
 */
describe('pending joins (owner-signed JoinRequest; outcome rows keyed by its stamp)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let owner: KeyPair;

  const asOwner = (message: Uint8Array): string => signAs(owner, message);
  const rand = (): string => Math.random().toString(36).slice(2);

  function request(): JoinRequestFields {
    const requestedAt = Date.now();
    return {
      Id: pendingJoinId('token-' + rand()),
      Invitation: 'invitation-' + rand(),
      Disclosure: '{}',
      RequestedAt: requestedAt,
      ExpiresAt: requestedAt + 86_400_000,
    };
  }

  function joined(): JoinOutcome {
    return {
      kind: 'joined',
      RecordedAt: Date.now(),
      StrandId: 'strand-' + rand(),
      MembershipInvite: JSON.stringify({ inviteKey: 'invite-key', invitePrivateKey: 'invite-private-key' }),
    };
  }

  function failed(code: string): JoinOutcome {
    return { kind: 'failed', RecordedAt: Date.now(), Code: code, Reason: 'reason ' + rand() };
  }

  async function count(table: 'JoinRequest' | 'JoinSuccess' | 'JoinFailure'): Promise<number> {
    const row = await rawDb.get(`select count(1) as c from CadreControl.${table}`);
    return Number(row?.c ?? 0);
  }

  /** An owner-signed `JoinSuccess` insert written directly, to reach the schema rules `recordJoinOutcome` checks first. */
  function rawJoinSuccess(requestStampId: string, outcome: JoinOutcome & { kind: 'joined' }): Promise<unknown> {
    const signature = asOwner(buildAuthorizationMessage('CadreControl.JoinSuccess', 'add',
      [requestStampId, String(outcome.RecordedAt), outcome.StrandId, outcome.MembershipInvite ?? '']));
    return rawDb.exec(`
      insert into CadreControl.JoinSuccess (RequestStampId, RecordedAt, StrandId, MembershipInvite)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?)
    `, [owner.publicKey, signature, requestStampId, outcome.RecordedAt, outcome.StrandId, outcome.MembershipInvite]);
  }

  /** As {@link rawJoinSuccess}, for `JoinFailure`. */
  function rawJoinFailure(requestStampId: string, outcome: JoinOutcome & { kind: 'failed' }): Promise<unknown> {
    const signature = asOwner(buildAuthorizationMessage('CadreControl.JoinFailure', 'add',
      [requestStampId, String(outcome.RecordedAt), outcome.Code, outcome.Reason]));
    return rawDb.exec(`
      insert into CadreControl.JoinFailure (RequestStampId, RecordedAt, Code, Reason)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?)
    `, [owner.publicKey, signature, requestStampId, outcome.RecordedAt, outcome.Code, outcome.Reason]);
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

  it('an owner-signed request lands and reads back pending; the same request signed by an enrolled machine that is not an owner is refused (AuthorizedInsert)', async () => {
    const written = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    expect(written.outcome).toBeNull();
    expect(await db.queryPendingJoin(written.Id)).toEqual(written);
    expect(await db.queryPendingJoins()).toEqual(expect.arrayContaining([written]));

    // A correctly formed signature, by a key the party enrolled as a machine. Only an
    // OwnerKey row authorizes a write here (tickets/blocked/decide-non-owner-machine-completes-a-pending-join.md).
    const machine = freshKeyPair();
    await admitMachine(machine);
    const before = await count('JoinRequest');
    await expectConstraintFailure(db.insertJoinRequest(request(), machine.publicKey, m => signAs(machine, m)), 'AuthorizedInsert');
    expect(await count('JoinRequest')).toBe(before);
  });

  it('a second request for the same invitation is classified as a pending-join conflict', async () => {
    // The caller adopts the existing request on exactly this classification, so pin it against
    // the live engine error.
    const fields = request();
    await db.insertJoinRequest(fields, owner.publicKey, asOwner);
    const error = await db.insertJoinRequest(fields, owner.publicKey, asOwner).then(() => undefined, (e: unknown) => e);
    expect(isPendingJoinConflict(error)).toBe(true);
  });

  it('recordJoinOutcome adds the outcome row for the request it names, and the join reads back with it', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    const outcome = joined();

    const written = await db.recordJoinOutcome(pending, outcome, owner.publicKey, asOwner);

    expect(written).toEqual({ ...pending, outcome });
    expect(written.StampId, 'the request is untouched: an outcome is added, not replaced in').toBe(pending.StampId);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(written);
    expect((await db.queryRevokedStamps('JoinRequest')).has(pending.StampId)).toBe(false);
  });

  it('an outcome row must name a live request stamp (RequestExists)', async () => {
    const before = await count('JoinSuccess');
    await expectConstraintFailure(rawJoinSuccess(freshStamp(), joined() as JoinOutcome & { kind: 'joined' }), 'RequestExists');
    expect(await count('JoinSuccess')).toBe(before);
  });

  it('a join recorded over a failure replaces it in one transaction; a failure can never be recorded over a join (NotJoined)', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    const failedJoin = await db.recordJoinOutcome(pending, failed('approval-refused'), owner.publicKey, asOwner);
    const outcome = joined();

    const written = await db.recordJoinOutcome(failedJoin, outcome, owner.publicKey, asOwner);

    expect(written.outcome).toEqual(outcome);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(written);
    expect(await rawDb.get('select 1 as x from CadreControl.JoinFailure where RequestStampId = ?', [pending.StampId]),
      'the superseded failure row is gone').toBeUndefined();

    const failures = await count('JoinFailure');
    await expectConstraintFailure(rawJoinFailure(pending.StampId, failed('token-spent') as JoinOutcome & { kind: 'failed' }), 'NotJoined');
    expect(await count('JoinFailure')).toBe(failures);
  });

  it('recordJoinOutcome on a join that changed throws PendingJoinChangedError carrying the live join, and writes nothing', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    const current = await db.recordJoinOutcome(pending, joined(), owner.publicKey, asOwner);

    const error = await db.recordJoinOutcome(pending, failed('token-spent'), owner.publicKey, asOwner).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(PendingJoinChangedError);
    expect((error as PendingJoinChangedError).live).toEqual(current);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(current);
  });

  it('rewritePendingJoin asks again after a finished join: the old stamp is retired with its outcome row, and the fresh request reads back pending', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    await db.recordJoinOutcome(pending, failed('expired'), owner.publicKey, asOwner);
    const { StampId: _old, outcome: _outcome, ...fields } = pending;
    const again: Omit<PendingJoin, 'StampId'> = { ...fields, RequestedAt: Date.now(), outcome: null };

    const written = await db.rewritePendingJoin(pending.StampId, again, owner.publicKey, asOwner);

    expect(written.StampId).not.toBe(pending.StampId);
    expect(written.outcome).toBeNull();
    expect(await db.queryPendingJoin(pending.Id)).toEqual(written);
    expect((await db.queryRevokedStamps('JoinRequest')).has(pending.StampId)).toBe(true);
    expect(await rawDb.get('select 1 as x from CadreControl.JoinFailure where RequestStampId = ?', [pending.StampId])).toBeUndefined();
  });

  it('rewritePendingJoin naming a stamp that is no longer live throws PendingJoinChangedError and writes nothing', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    const { StampId: _old, ...fields } = pending;
    const current = await db.rewritePendingJoin(pending.StampId, fields, owner.publicKey, asOwner);
    const revokedBefore = await db.queryRevokedStamps('JoinRequest');

    const error = await db.rewritePendingJoin(pending.StampId, fields, owner.publicKey, asOwner).then(() => undefined, (e: unknown) => e);

    expect(error).toBeInstanceOf(PendingJoinChangedError);
    expect((error as PendingJoinChangedError).live).toEqual(current);
    expect(await db.queryPendingJoin(pending.Id)).toEqual(current);
    expect(await db.queryRevokedStamps('JoinRequest')).toEqual(revokedBefore);
  });

  it('an outcome row cannot be deleted while its request lives (AuthorizedDelete); deletePendingJoin removes both and files the tombstone', async () => {
    const pending = await db.insertJoinRequest(request(), owner.publicKey, asOwner);
    await db.recordJoinOutcome(pending, joined(), owner.publicKey, asOwner);

    await expectConstraintFailure(rawDb.exec(`
      delete from CadreControl.JoinSuccess with context OwnerKey = null, Signature = null where RequestStampId = ?
    `, [pending.StampId]), 'AuthorizedDelete');
    expect(await rawDb.get('select 1 as x from CadreControl.JoinSuccess where RequestStampId = ?', [pending.StampId])).toBeDefined();

    expect(await db.deletePendingJoin(pending.Id, owner.publicKey, asOwner)).toBe(true);
    expect(await db.queryPendingJoin(pending.Id)).toBeNull();
    expect(await rawDb.get('select 1 as x from CadreControl.JoinSuccess where RequestStampId = ?', [pending.StampId])).toBeUndefined();
    expect((await db.queryRevokedStamps('JoinRequest')).has(pending.StampId)).toBe(true);
    expect(await db.deletePendingJoin(pending.Id, owner.publicKey, asOwner), 'already gone').toBe(false);
  });
});
