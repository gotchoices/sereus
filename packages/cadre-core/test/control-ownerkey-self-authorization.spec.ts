import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import debug from 'debug';
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

/**
 * Escalation and destruction coverage for `CadreControl.OwnerKey`.
 *
 * Before this suite's fix the table had three holes, each measured against a real
 * control database:
 *   - the authorizer subquery read the POST-mutation row set, so a stranger could
 *     insert itself and name itself `context.OwnerKey` (and two strangers could seat
 *     each other in one transaction);
 *   - the constraint never named `delete`, so ANY owner row could be removed with no
 *     authorization at all — including the last one, which permanently bricks the
 *     party's control plane (every other CadreControl CHECK requires an OwnerKey row);
 *   - the bootstrap branch counted the post-image, so it was also true of an update
 *     that re-pointed the sole owner row, and of a same-transaction delete-then-insert
 *     swap of the sole owner.
 *
 * The authorizer set is now read from `committed.OwnerKey` (the PRE-transaction
 * snapshot), `delete` is authorized over a `'remove'`-scoped digest by a DIFFERENT
 * pre-existing owner, `update` is forbidden outright, and `MinOneOwner` floors the
 * table at one row.
 *
 * Every test boots its OWN `CadreNode` (empty bootstrap, transaction profile) seeded
 * with one founding owner: these attacks mutate the owner set — one of them emptied it
 * pre-fix — so a shared database would leak state between probes.
 */

const log = debug('sereus:cadre:test:ownerkey-authz');

interface KeyPair {
  privateKey: string;
  publicKey: string;
}

function freshKeyPair(): KeyPair {
  const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
  return {
    privateKey,
    publicKey: getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string,
  };
}

const freshStamp = (): string => randomBytes(256, 'base64url') as string;

/** ed25519-sign the raw canonical message bytes (no pre-hash), as the schema's verify expects. */
function signAs(kp: KeyPair, message: Uint8Array): string {
  return cryptoSign(message, kp.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

/** The enrollment message the insert branch binds: digest(new.Key, new.StampId). */
const enrollMessage = (key: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage([key, stampId]);

/** The removal message the delete branch binds: digest(old.Key, old.StampId, 'remove'). */
const removeMessage = (key: string, stampId: string): Uint8Array =>
  buildAuthorizationMessage([key, stampId, 'remove']);

describe('OwnerKey self-authorization and unauthorized deletion', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  async function ownerKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const row of rawDb.eval('select Key from CadreControl.OwnerKey')) {
      keys.push(String(row.Key));
    }
    return keys.sort();
  }

  async function stampIdOf(key: string): Promise<string> {
    const row = await rawDb.get('select StampId from CadreControl.OwnerKey where Key = ?', [key]);
    return String(row?.StampId);
  }

  function rawInsertOwnerKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
    stampId: string,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [contextOwner, signature, key, stampId],
    );
  }

  function rawDeleteOwnerKey(
    contextOwner: string | null,
    signature: string | null,
    key: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.OwnerKey
         with context OwnerKey = ?, Signature = ?
         where Key = ?`,
      [contextOwner, signature, key],
    );
  }

  function rawUpdateOwnerKey(fromKey: string, toKey: string): Promise<void> {
    return rawDb.exec(
      `update CadreControl.OwnerKey
         with context OwnerKey = null, Signature = null
         set Key = ?
         where Key = ?`,
      [toKey, fromKey],
    );
  }

  /** Run `statements` in one explicit transaction: commit on success, rollback on failure. */
  async function inTransaction(statements: () => Promise<void>): Promise<void> {
    await rawDb.beginTransaction();
    try {
      await statements();
      await rawDb.commit();
    } catch (error) {
      // A failed commit() already tore the transaction down, so rollback() throws
      // "no transaction active" — log it rather than masking the real cause.
      try {
        await rawDb.rollback();
      } catch (rollbackError) {
        log('Rollback after a rejected transaction was a no-op: %s', rollbackError);
      }
      throw error;
    }
  }

  /** Seat a second owner the legitimate way: the founder signs the new row. */
  async function enrollByFounder(newOwner: KeyPair): Promise<void> {
    const stamp = freshStamp();
    await rawInsertOwnerKey(
      founder.publicKey,
      signAs(founder, enrollMessage(newOwner.publicKey, stamp)),
      newOwner.publicKey,
      stamp,
    );
  }

  beforeEach(async () => {
    founder = freshKeyPair();

    node = new CadreNode({
      controlNetwork: {
        partyId: 'ownerkey-authz-' + Math.random().toString(36).slice(2),
        bootstrapNodes: [],
      },
      profile: 'transaction',
    });
    await node.start();

    const controlDb = node.getControlDatabase();
    expect(controlDb).not.toBeNull();
    db = controlDb!;
    rawDb = db.getDatabase();

    expect(await db.ensureOwnerKey(founder.publicKey)).toBe(true);
  }, 60_000);

  afterEach(async () => {
    await node?.stop();
  });

  // ── Genesis / acceptance ───────────────────────────────────────────────────

  it('genesis: ensureOwnerKey seats the founder on a fresh party', async () => {
    // The bootstrap branch now requires an EMPTY pre-transaction owner set, so this also
    // proves the tightened branch did not break the only production writer.
    expect(await ownerKeys()).toEqual([founder.publicKey]);
    expect((await stampIdOf(founder.publicKey)).length).toBeGreaterThan(0);
  }, 60_000);

  it('accepts: a pre-existing owner enrolls a second owner with a row-bound signature', async () => {
    const second = freshKeyPair();
    await enrollByFounder(second);

    expect(await ownerKeys()).toEqual([founder.publicKey, second.publicKey].sort());
  }, 60_000);

  it('accepts: a pre-existing owner removes ANOTHER owner with a remove-scoped signature', async () => {
    const second = freshKeyPair();
    await enrollByFounder(second);
    const stamp = await stampIdOf(second.publicKey);

    await rawDeleteOwnerKey(
      founder.publicKey,
      signAs(founder, removeMessage(second.publicKey, stamp)),
      second.publicKey,
    );

    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  // ── Negative control ───────────────────────────────────────────────────────

  it('negative control: a garbage signature from a REAL owner is rejected', async () => {
    // Guards against a future regression that disables the constraint outright: this
    // insert differs from the accepted enrollment above ONLY in the signature bytes, so a
    // pass here would mean `verify` is no longer evaluated.
    const before = await ownerKeys();
    const target = freshKeyPair();

    await expect(
      rawInsertOwnerKey(founder.publicKey, randomBytes(64, 'base64url') as string, target.publicKey, freshStamp()),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  // ── Self-authorization (the deferred-subquery hole) ────────────────────────

  it('rejects: a stranger enrolling itself by signing its own row', async () => {
    // Pre-fix this was ACCEPTED — the deferred CHECK saw the row being inserted, so
    // `exists (select 1 from OwnerKey A where A.Key = context.OwnerKey ...)` matched the
    // attacker's own in-flight row.
    const before = await ownerKeys();
    const attacker = freshKeyPair();
    const stamp = freshStamp();

    await expect(
      rawInsertOwnerKey(
        attacker.publicKey,
        signAs(attacker, enrollMessage(attacker.publicKey, stamp)),
        attacker.publicKey,
        stamp,
      ),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('rejects: two strangers seating each other in ONE transaction (mutual promotion)', async () => {
    const before = await ownerKeys();
    const a = freshKeyPair();
    const b = freshKeyPair();
    const stampA = freshStamp();
    const stampB = freshStamp();

    await expect(
      inTransaction(async () => {
        // B "authorizes" A ...
        await rawInsertOwnerKey(b.publicKey, signAs(b, enrollMessage(a.publicKey, stampA)), a.publicKey, stampA);
        // ... and A "authorizes" B, in the same transaction.
        await rawInsertOwnerKey(a.publicKey, signAs(a, enrollMessage(b.publicKey, stampB)), b.publicKey, stampB);
      }),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  // ── Unauthorized deletion (delete was uncovered) ───────────────────────────

  it('rejects: an unsigned delete of one owner while two exist', async () => {
    const second = freshKeyPair();
    await enrollByFounder(second);
    const before = await ownerKeys();

    await expect(rawDeleteOwnerKey(null, null, second.publicKey)).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('rejects: an unsigned delete of the LAST owner (would brick the control plane)', async () => {
    const before = await ownerKeys();

    await expect(rawDeleteOwnerKey(null, null, founder.publicKey)).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('rejects: a signed mutual removal that would EMPTY the table (MinOneOwner floor)', async () => {
    // Both removals are individually authorized — each owner existed before the
    // transaction and signs the OTHER's remove digest — so only the minimum-one-owner
    // floor stands between the party and a permanently unauthorizable control database.
    const second = freshKeyPair();
    await enrollByFounder(second);
    const before = await ownerKeys();
    const founderStamp = await stampIdOf(founder.publicKey);
    const secondStamp = await stampIdOf(second.publicKey);

    await expect(
      inTransaction(async () => {
        await rawDeleteOwnerKey(
          founder.publicKey,
          signAs(founder, removeMessage(second.publicKey, secondStamp)),
          second.publicKey,
        );
        await rawDeleteOwnerKey(
          second.publicKey,
          signAs(second, removeMessage(founder.publicKey, founderStamp)),
          founder.publicKey,
        );
      }),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('rejects: an owner signing its OWN removal (no self-resignation path)', async () => {
    const second = freshKeyPair();
    await enrollByFounder(second);
    const before = await ownerKeys();
    const stamp = await stampIdOf(second.publicKey);

    await expect(
      rawDeleteOwnerKey(second.publicKey, signAs(second, removeMessage(second.publicKey, stamp)), second.publicKey),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  // ── Sole-owner takeover (the ungated bootstrap branch) ─────────────────────

  it('rejects: an unsigned update re-pointing the sole owner row at an attacker key', async () => {
    // Pre-fix this rode the bootstrap branch: the post-update image still held exactly one
    // row, so `count(1) <= 1` was true. OwnerKey rows are now insert/delete only.
    const attacker = freshKeyPair();

    await expect(rawUpdateOwnerKey(founder.publicKey, attacker.publicKey)).rejects.toThrow();
    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  it('rejects: an unsigned delete-of-founder + insert-of-attacker in ONE transaction (sole-owner swap)', async () => {
    const attacker = freshKeyPair();

    await expect(
      inTransaction(async () => {
        await rawDeleteOwnerKey(null, null, founder.publicKey);
        await rawInsertOwnerKey(null, null, attacker.publicKey, freshStamp());
      }),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  // ── Cross-direction signature replay ──────────────────────────────────────

  it('rejects: an ENROLLMENT signature replayed as a removal', async () => {
    // The stored enrollment signature covers digest(Key, StampId); the delete branch binds
    // digest(Key, StampId, 'remove'), so the two can never substitute for each other.
    const second = freshKeyPair();
    const stamp = freshStamp();
    const enrollSig = signAs(founder, enrollMessage(second.publicKey, stamp));
    await rawInsertOwnerKey(founder.publicKey, enrollSig, second.publicKey, stamp);
    const before = await ownerKeys();

    await expect(rawDeleteOwnerKey(founder.publicKey, enrollSig, second.publicKey)).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  it('rejects: a REMOVAL signature replayed as an enrollment', async () => {
    const before = await ownerKeys();
    const target = freshKeyPair();
    const stamp = freshStamp();
    const removeSig = signAs(founder, removeMessage(target.publicKey, stamp));

    await expect(
      rawInsertOwnerKey(founder.publicKey, removeSig, target.publicKey, stamp),
    ).rejects.toThrow();
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);
});
