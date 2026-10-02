import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
  randomBytes,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage, isStrandIdConflict } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { expectConstraintFailure } from './control-constraint-helpers.js';

/**
 * Authorization + single-use-stamp coverage for `CadreControl.JoinedStrand` — the party-wide
 * record of a strand this party joined from another party. Same idiom as
 * `control-strand-party-key.spec.ts`: owner-signed row-bound insert, forbidden update,
 * `'remove'`-tagged delete with a mandatory same-transaction `Revocation` tombstone, and
 * permanent stamp retirement. The reap branch is covered in `control-revocation-reap.spec.ts`
 * and the `RowIsGone` branch in `control-revocation-replay.spec.ts`, both of which enumerate
 * the guarded tables.
 */
describe('JoinedStrand authorization (row-bound + single-use stamp)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);
  const freshStamp = (): string => randomBytes(256, 'base64url') as string;

  async function joinedStrandCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.JoinedStrand');
    return Number(row?.c ?? 0);
  }

  function rawInsertJoinedStrand(
    sig: string | null,
    id: string,
    memberPrivateKey: string | null,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.JoinedStrand (Id, Type, MemberPrivateKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, 'c', ?, ?)`,
      [ownerPublicKey, sig, id, memberPrivateKey, stampId],
    );
  }

  /** The exact bytes AuthorizedInsert verifies for a closed row: ('add', Id, 'c', MemberPrivateKey, StampId). */
  function addMessage(id: string, memberPrivateKey: string, stampId: string): Uint8Array {
    return buildAuthorizationMessage('CadreControl.JoinedStrand', 'add', [id, 'c', memberPrivateKey, stampId]);
  }

  /** Record a closed joined strand the legitimate way, returning its read secret and stamp. */
  async function recordClosed(id: string): Promise<{ key: string; stamp: string }> {
    const key = await generateStrandMemberKey();
    await db.insertJoinedStrand({ Id: id, Type: 'c', MemberPrivateKey: key }, ownerPublicKey, signMessage);
    const stamp = await db.queryJoinedStrandStampId(id);
    expect(stamp).not.toBeNull();
    return { key, stamp: stamp! };
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'joined-strand-authz-' + rand(),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    expect(await db.ensureOwnerKey(ownerPublicKey)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('happy path: insertJoinedStrand lands open and closed rows, read back as StrandRows with no founder', async () => {
    const closedId = 'js-closed-' + rand();
    const openId = 'js-open-' + rand();
    const { key } = await recordClosed(closedId);
    await db.insertJoinedStrand({ Id: openId, Type: 'o', MemberPrivateKey: null }, ownerPublicKey, signMessage);

    const closed = { Id: closedId, Type: 'c', MemberPrivateKey: key, FounderOwnerKey: null };
    const open = { Id: openId, Type: 'o', MemberPrivateKey: null, FounderOwnerKey: null };
    expect(await db.queryJoinedStrand(closedId)).toEqual(closed);
    expect(await db.queryJoinedStrand(openId)).toEqual(open);
    expect(await db.queryJoinedStrand('js-absent-' + rand())).toBeNull();
    expect(await db.queryJoinedStrands()).toEqual(expect.arrayContaining([closed, open]));
  });

  it('a repeat insert of a recorded id is classified as a JoinedStrand id conflict, not a Strand one', async () => {
    // The next caller treats "another machine already published this join" as success on
    // exactly this classification, so pin it against the live engine error.
    const id = 'js-repeat-' + rand();
    await db.insertJoinedStrand({ Id: id, Type: 'o', MemberPrivateKey: null }, ownerPublicKey, signMessage);

    const error = await db.insertJoinedStrand({ Id: id, Type: 'o', MemberPrivateKey: null }, ownerPublicKey, signMessage)
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isStrandIdConflict(error, 'JoinedStrand')).toBe(true);
    expect(isStrandIdConflict(error, 'Strand')).toBe(false);
  });

  it('unsigned insert rejected (AuthorizedInsert)', async () => {
    const before = await joinedStrandCount();
    await expectConstraintFailure(
      rawInsertJoinedStrand(null, 'js-unsigned-' + rand(), await generateStrandMemberKey(), freshStamp()),
      'AuthorizedInsert',
    );
    expect(await joinedStrandCount()).toBe(before);
  });

  it('signature is bound to the READ SECRET: a valid approval cannot seat a different MemberPrivateKey', async () => {
    const id = 'js-tamper-' + rand();
    const approvedKey = await generateStrandMemberKey();
    const attackerKey = await generateStrandMemberKey();
    const stamp = freshStamp();
    const sig = signMessage(addMessage(id, approvedKey, stamp));

    const before = await joinedStrandCount();
    await expectConstraintFailure(rawInsertJoinedStrand(sig, id, attackerKey, stamp), 'AuthorizedInsert');
    expect(await joinedStrandCount()).toBe(before);
  });

  it('update rejected outright (NoUpdate) — the read secret cannot be rewritten in place', async () => {
    const id = 'js-noupdate-' + rand();
    const { key } = await recordClosed(id);

    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.JoinedStrand
           with context OwnerKey = ?, Signature = ?
           set MemberPrivateKey = ? where Id = ?`,
        [ownerPublicKey, signMessage(addMessage(id, 'swapped', 'x')), 'swapped', id],
      ),
      'NoUpdate',
    );
    expect((await db.queryJoinedStrand(id))?.MemberPrivateKey).toBe(key);
  });

  it('bare signed delete rejected: removal must retire the stamp in the same transaction (RevocationRecorded)', async () => {
    const id = 'js-baredelete-' + rand();
    const { stamp } = await recordClosed(id);
    const sig = signMessage(buildAuthorizationMessage('CadreControl.JoinedStrand', 'remove', [id, stamp]));

    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.JoinedStrand
           with context OwnerKey = ?, Signature = ?
           where Id = ?`,
        [ownerPublicKey, sig, id],
      ),
      'RevocationRecorded',
    );
    expect(await db.queryJoinedStrand(id)).not.toBeNull();
  });

  it('deleteJoinedStrand retires the stamp, and the ORIGINAL insert approval cannot re-seat the row (NotRevoked)', async () => {
    const id = 'js-replay-' + rand();
    const { key, stamp } = await recordClosed(id);
    const capturedSig = signMessage(addMessage(id, key, stamp));

    expect(await db.deleteJoinedStrand(id, ownerPublicKey, signMessage)).toBe(true);
    expect(await db.queryJoinedStrand(id)).toBeNull();
    expect((await db.queryRevokedStamps('JoinedStrand')).has(stamp)).toBe(true);

    await expectConstraintFailure(rawInsertJoinedStrand(capturedSig, id, key, stamp), 'NotRevoked');
    expect(await db.queryJoinedStrand(id)).toBeNull();
  });
});
