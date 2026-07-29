import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * Domain separation across every signed `CadreControl` approval.
 *
 * Before this suite's fix, an owner approval was a signature over a bare field tuple
 * (`digest(field_1, ..., StampId)`) with nothing saying which TABLE or which ACTION it
 * authorized. Several rules built byte-identical tuples, so one approval satisfied
 * several different constraints — most damningly, an approval enrolling a narrow
 * `ValidationKey` was, unchanged, a valid approval enrolling that same key as a full
 * `OwnerKey` (direct privilege escalation), and the stored, replicated
 * `CadrePeer.VouchSig` column handed every reader a signature that satisfied
 * `OwnerKey.Authorized` for the peer-id string.
 *
 * Every signed message now leads with two fixed literals — a domain tag
 * (`'CadreControl.<Table>'`) and an action tag (`'add'` / `'remove'` / `'vouch'` /
 * `'publish'`) — so an approval verifies ONLY against the one rule it was minted for.
 * Each test here captures a legitimately-signed approval for one rule and asserts the
 * previously-colliding rule refuses it BY CONSTRAINT NAME.
 *
 * Every test boots its own `CadreNode` (empty bootstrap, transaction profile): these
 * probes mutate the owner set and sibling tables, so a shared database would leak
 * state between them.
 */

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

/** ed25519-sign the raw canonical message bytes (no pre-hash), as the schema's verify expects. */
function signAs(kp: KeyPair, message: Uint8Array): string {
  return cryptoSign(message, kp.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
}

describe('CadreControl approval domain separation', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  /**
   * Assert the write was rejected by one of the NAMED CHECK constraints, not by an
   * incidental SQL, binding, or transaction error. A bare `rejects.toThrow()` goes green
   * on a mistyped statement, which would silently retire the replay it claims to pin.
   */
  function expectConstraintFailure(write: Promise<unknown>, ...constraints: string[]) {
    return expect(write).rejects.toThrow(
      new RegExp(`CHECK constraint failed: (${constraints.join('|')})\\b`),
    );
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

  async function ownerKeys(): Promise<string[]> {
    const keys: string[] = [];
    for await (const row of rawDb.eval('select Key from CadreControl.OwnerKey')) {
      keys.push(String(row.Key));
    }
    return keys.sort();
  }

  beforeEach(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'domain-separation-' + Math.random().toString(36).slice(2),
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

  // ── Class A: digest(X, StampId) was shared by four rules ───────────────────

  it('rejects: a ValidationKey enrollment approval replayed as an OwnerKey insert', async () => {
    // The escalation this whole scheme exists to close. The owner enrolls a NARROW
    // validation key through the shipped writer; pre-fix, the captured signature —
    // covering the identical (Key, StampId) tuple — also satisfied
    // `OwnerKey.Authorized`, promoting the validation key to full owner.
    const validation = freshKeyPair();
    let capturedSig: string | null = null;
    await db.insertValidationKey(validation.publicKey, founder.publicKey, (message) => {
      const sig = signAs(founder, message);
      capturedSig = sig;
      return sig;
    });
    expect(capturedSig).not.toBeNull();
    const stampRow = await rawDb.get(
      'select StampId from CadreControl.ValidationKey where Key = ?',
      [validation.publicKey],
    );
    const stampId = String(stampRow?.StampId);
    const before = await ownerKeys();

    await expectConstraintFailure(
      rawInsertOwnerKey(founder.publicKey, capturedSig, validation.publicKey, stampId),
      'Authorized',
    );
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);
});
