import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
  randomBytes,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { expectConstraintFailure } from './control-constraint-helpers.js';

/**
 * Authorization + single-use-stamp coverage for `CadreControl.StrandPartyKey` — the row
 * holding ONE party's own strand membership identity key, the private half of the
 * identity/read-secret split (gotchoices/sereus#4). Follows the ValidationKey idiom:
 * owner-signed row-bound insert, forbidden update, `'remove'`-tagged delete with a
 * mandatory same-transaction `Revocation` tombstone, and permanent stamp retirement.
 *
 * Boots one real CadreNode (empty bootstrap, transaction profile) the way
 * `control-authorization-binding.spec.ts` does, and drives both the real writers
 * (`insertStrandPartyKey` / `deleteStrandPartyKey` / `deleteStrand`) and raw SQL for
 * the attack paths. The node-level surface — publish-time mint, launch-time heal, the
 * founder bootstrap consuming the key — is covered in `publish-strand.spec.ts`.
 */
describe('StrandPartyKey authorization (row-bound + single-use stamp)', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let ownerPrivateKey: string;
  let ownerPublicKey: string;

  const signMessage = (message: Uint8Array): string =>
    cryptoSign(message, ownerPrivateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

  const rand = (): string => Math.random().toString(36).slice(2);
  const freshStamp = (): string => randomBytes(256, 'base64url') as string;

  async function partyKeyCount(): Promise<number> {
    const row = await rawDb.get('select count(1) as c from CadreControl.StrandPartyKey');
    return Number(row?.c ?? 0);
  }

  function rawInsertPartyKey(
    sig: string | null,
    id: string,
    privateKey: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.StrandPartyKey (Id, PrivateKey, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?)`,
      [ownerPublicKey, sig, id, privateKey, stampId],
    );
  }

  /** The exact bytes AuthorizedInsert verifies: ('add', Id, PrivateKey, StampId). */
  function addMessage(id: string, privateKey: string, stampId: string): Uint8Array {
    return buildAuthorizationMessage('CadreControl.StrandPartyKey', 'add', [id, privateKey, stampId]);
  }

  function revocationRow(stampId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get(
      'select TableName, RowKey, StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['StrandPartyKey', stampId],
    );
  }

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;

    node = new CadreNode({
      controlNetwork: {
        partyId: 'party-key-authz-' + rand(),
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

  it('happy path: insertStrandPartyKey lands the row and queryStrandPartyKey reads it back', async () => {
    const strandId = 'pk-happy-' + rand();
    const key = await generateStrandMemberKey();

    await db.insertStrandPartyKey(strandId, key, ownerPublicKey, signMessage);

    expect(await db.queryStrandPartyKey(strandId)).toBe(key);
    const stamp = await db.queryStrandPartyKeyStampId(strandId);
    expect(typeof stamp).toBe('string');
    expect(stamp!.length).toBeGreaterThan(0);
  });

  it('unsigned insert rejected (AuthorizedInsert)', async () => {
    const before = await partyKeyCount();
    await expectConstraintFailure(
      rawInsertPartyKey(null, 'pk-unsigned-' + rand(), await generateStrandMemberKey(), freshStamp()),
      'AuthorizedInsert',
    );
    expect(await partyKeyCount()).toBe(before);
  });

  it('signature is bound to the KEY MATERIAL: a valid approval cannot seat a different key', async () => {
    // A captured (stamp, signature) pair re-presented over an attacker-chosen
    // PrivateKey must fail — otherwise an approval doubled as a blank identity grant.
    const strandId = 'pk-tamper-' + rand();
    const approvedKey = await generateStrandMemberKey();
    const attackerKey = await generateStrandMemberKey();
    const stamp = freshStamp();
    const sig = signMessage(addMessage(strandId, approvedKey, stamp));

    const before = await partyKeyCount();
    await expectConstraintFailure(
      rawInsertPartyKey(sig, strandId, attackerKey, stamp),
      'AuthorizedInsert',
    );
    expect(await partyKeyCount()).toBe(before);
  });

  it('update rejected outright (NoUpdate) — identity cannot be rewritten in place', async () => {
    const strandId = 'pk-noupdate-' + rand();
    const key = await generateStrandMemberKey();
    await db.insertStrandPartyKey(strandId, key, ownerPublicKey, signMessage);

    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.StrandPartyKey
           with context OwnerKey = ?, Signature = ?
           set PrivateKey = ? where Id = ?`,
        [ownerPublicKey, signMessage(addMessage(strandId, 'swapped', 'x')), 'swapped', strandId],
      ),
      'NoUpdate',
    );
    expect(await db.queryStrandPartyKey(strandId)).toBe(key);
  });

  it('bare delete rejected: removal must retire the stamp in the same transaction (RevocationRecorded)', async () => {
    const strandId = 'pk-baredelete-' + rand();
    await db.insertStrandPartyKey(strandId, await generateStrandMemberKey(), ownerPublicKey, signMessage);
    const stamp = await db.queryStrandPartyKeyStampId(strandId);
    const sig = signMessage(
      buildAuthorizationMessage('CadreControl.StrandPartyKey', 'remove', [strandId, stamp!]));

    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.StrandPartyKey
           with context OwnerKey = ?, Signature = ?
           where Id = ?`,
        [ownerPublicKey, sig, strandId],
      ),
      'RevocationRecorded',
    );
    expect(await db.queryStrandPartyKey(strandId)).not.toBeNull();
  });

  it('deleteStrandPartyKey retires the stamp, and the ORIGINAL insert approval cannot re-seat the row (NotRevoked)', async () => {
    const strandId = 'pk-replay-' + rand();
    const key = await generateStrandMemberKey();
    await db.insertStrandPartyKey(strandId, key, ownerPublicKey, signMessage);
    const stamp = await db.queryStrandPartyKeyStampId(strandId);
    // Capture what an attacker replaying the enrollment would hold: the exact signed bytes.
    const capturedSig = signMessage(addMessage(strandId, key, stamp!));

    expect(await db.deleteStrandPartyKey(strandId, ownerPublicKey, signMessage)).toBe(true);

    expect(await db.queryStrandPartyKey(strandId)).toBeNull();
    const tombstone = await revocationRow(stamp!);
    expect(tombstone).toBeDefined();
    expect(tombstone?.RowKey).toBe(strandId);

    // Verbatim replay of the never-expiring insert approval: refused by retirement.
    await expectConstraintFailure(
      rawInsertPartyKey(capturedSig, strandId, key, stamp!),
      'NotRevoked',
    );

    // A legitimate re-seat mints a FRESH stamp and signature and still works.
    const rotated = await generateStrandMemberKey();
    await db.insertStrandPartyKey(strandId, rotated, ownerPublicKey, signMessage);
    expect(await db.queryStrandPartyKey(strandId)).toBe(rotated);
    expect(await db.queryStrandPartyKeyStampId(strandId)).not.toBe(stamp);
  });

  it('deleting an absent party key is a silent no-op (no throw, no tombstone)', async () => {
    const before = (await db.queryRevokedStamps('StrandPartyKey')).size;
    expect(await db.deleteStrandPartyKey('pk-absent-' + rand(), ownerPublicKey, signMessage)).toBe(false);
    expect((await db.queryRevokedStamps('StrandPartyKey')).size).toBe(before);
  });

  it('deleteStrand removes the strand AND its party key in one act, tombstoning both stamps', async () => {
    const strandId = 'pk-cascade-' + rand();
    await db.insertStrand(strandId, 'c', ownerPublicKey, signMessage, await generateStrandMemberKey());
    await db.insertStrandPartyKey(strandId, await generateStrandMemberKey(), ownerPublicKey, signMessage);
    const strandStamp = await db.queryStrandStampId(strandId);
    const partyStamp = await db.queryStrandPartyKeyStampId(strandId);

    expect(await db.deleteStrand(strandId, ownerPublicKey, signMessage)).toBe(true);

    expect(await db.queryStrand(strandId)).toBeNull();
    expect(await db.queryStrandPartyKey(strandId)).toBeNull();
    expect((await db.queryRevokedStamps('Strand')).has(strandStamp!)).toBe(true);
    expect((await db.queryRevokedStamps('StrandPartyKey')).has(partyStamp!)).toBe(true);
  });

  it('deleteStrand leaves a party key with NO Strand row alone (a joiner\'s identity)', async () => {
    // The joiner shape the next tickets build on: a StrandPartyKey row for a strand this
    // party holds no control Strand row for. deleteStrand must no-op without touching it.
    const strandId = 'pk-joiner-' + rand();
    const key = await generateStrandMemberKey();
    await db.insertStrandPartyKey(strandId, key, ownerPublicKey, signMessage);

    expect(await db.deleteStrand(strandId, ownerPublicKey, signMessage)).toBe(false);

    expect(await db.queryStrandPartyKey(strandId)).toBe(key);
  });
});
