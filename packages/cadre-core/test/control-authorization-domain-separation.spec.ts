import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import {
  cadrePeerVoucherDigest,
  deviceTokenAddDigest,
  deviceTokenRemoveDigest,
} from '../src/peer-authorization.js';

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

/** ed25519-sign a base64url digest STRING (the peer-authorization helper encoding). */
function signB64(kp: KeyPair, digestB64url: string): string {
  return cryptoSign(digestB64url, kp.privateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
}

function freshStamp(): string {
  return 'stamp-' + Math.random().toString(36).slice(2);
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

  it('rejects: an OwnerKey enrollment approval replayed as a ValidationKey insert', async () => {
    // Reverse direction of the escalation: a full-owner grant must not double as a
    // narrow validation-key grant (same (Key, StampId) bytes, different domain tag).
    const second = freshKeyPair();
    const stamp = freshStamp();
    const enrollSig = signAs(
      founder,
      buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [second.publicKey, stamp]),
    );
    // Prove the signature is genuine: the rule it was minted for accepts it.
    await rawInsertOwnerKey(founder.publicKey, enrollSig, second.publicKey, stamp);

    await expectConstraintFailure(
      rawDb.exec(
        `insert into CadreControl.ValidationKey (Key, StampId)
           with context OwnerKey = ?, Signature = ?
           values (?, ?)`,
        [founder.publicKey, enrollSig, second.publicKey, stamp],
      ),
      'Authorized',
    );
    expect(
      await rawDb.get('select Key from CadreControl.ValidationKey where Key = ?', [second.publicKey]),
    ).toBeUndefined();
  }, 60_000);

  it('rejects: a stored CadrePeer.VouchSig replayed as an OwnerKey insert', async () => {
    // VouchSig is a STORED, REPLICATED column: every reader of the table holds it.
    // Pre-fix it covered the same bytes as an OwnerKey enrollment for Key = PeerId,
    // letting any reader append to the party's most privileged table.
    const peerId = '12D3KooWStoredVouchTarget';
    const stamp = freshStamp();
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(peerId, stamp));
    await rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, peerId, null, '', null, null, stamp, founder.publicKey, vouchSig],
    );
    // Replay exactly what a reader can lift off the replicated row.
    const row = await rawDb.get(
      'select VouchSig, StampId from CadreControl.CadrePeer where PeerId = ?',
      [peerId],
    );
    const before = await ownerKeys();

    await expectConstraintFailure(
      rawInsertOwnerKey(founder.publicKey, String(row?.VouchSig), peerId, String(row?.StampId)),
      'Authorized',
    );
    expect(await ownerKeys()).toEqual(before);
  }, 60_000);

  // ── Class B: digest(X, StampId, 'remove') was shared by two delete rules ───

  it('rejects: an OwnerKey removal approval replayed as a CadrePeer delete', async () => {
    const second = freshKeyPair();
    const stamp = freshStamp();
    const enrollSig = signAs(
      founder,
      buildAuthorizationMessage('CadreControl.OwnerKey', 'add', [second.publicKey, stamp]),
    );
    await rawInsertOwnerKey(founder.publicKey, enrollSig, second.publicKey, stamp);
    // A CadrePeer row whose (PeerId, StampId) mirror the owner row — the shape an
    // attacker would arrange so the pre-fix shared 'remove' digest lined up.
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(second.publicKey, stamp));
    await rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, second.publicKey, null, '', null, null, stamp, founder.publicKey, vouchSig],
    );

    const removeSig = signAs(
      founder,
      buildAuthorizationMessage('CadreControl.OwnerKey', 'remove', [second.publicKey, stamp]),
    );
    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.CadrePeer
           with context OwnerKey = ?, Signature = ?
           where PeerId = ?`,
        [founder.publicKey, removeSig, second.publicKey],
      ),
      'AuthorizedDelete',
    );
    expect(
      await rawDb.get('select PeerId from CadreControl.CadrePeer where PeerId = ?', [second.publicKey]),
    ).toBeDefined();

    // Prove the removal signature is genuine: the rule it was minted for accepts it.
    await rawDb.exec(
      `delete from CadreControl.OwnerKey
         with context OwnerKey = ?, Signature = ?
         where Key = ?`,
      [founder.publicKey, removeSig, second.publicKey],
    );
    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  // ── DeviceToken: one constraint used to gate insert AND delete ─────────────

  it('rejects: a DeviceToken insert approval replayed as a DeviceToken delete', async () => {
    const peerId = '12D3KooWDeviceTokenTarget';
    const addSig = signB64(founder, deviceTokenAddDigest(peerId));
    await rawDb.exec(
      `insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?)`,
      [founder.publicKey, addSig, peerId, 'fcm', 'tok-domain-sep', null, null],
    );

    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.DeviceToken
           with context OwnerKey = ?, Signature = ?
           where PeerId = ?`,
        [founder.publicKey, addSig, peerId],
      ),
      'AuthorizedDelete',
    );
    expect(
      await rawDb.get('select PeerId from CadreControl.DeviceToken where PeerId = ?', [peerId]),
    ).toBeDefined();

    // The properly 'remove'-tagged approval is what deletes it.
    await rawDb.exec(
      `delete from CadreControl.DeviceToken
         with context OwnerKey = ?, Signature = ?
         where PeerId = ?`,
      [founder.publicKey, signB64(founder, deviceTokenRemoveDigest(peerId)), peerId],
    );
    expect(
      await rawDb.get('select PeerId from CadreControl.DeviceToken where PeerId = ?', [peerId]),
    ).toBeUndefined();
  }, 60_000);

  // ── FormationInvite: one constraint used to gate insert AND delete ─────────

  it('rejects: a FormationInvite insert approval replayed as a FormationInvite delete', async () => {
    // Capture the signature the shipped writer mints; pre-split, the single
    // AuthorizedAddOrRemove constraint accepted it for the delete too, so a captured
    // insert approval could revoke the invite it created.
    const token = 'invite-domain-sep';
    let capturedSig: string | null = null;
    await db.insertFormationInvite(token, 'sapp-domain-sep', founder.publicKey, (message) => {
      const sig = signAs(founder, message);
      capturedSig = sig;
      return sig;
    });
    expect(capturedSig).not.toBeNull();

    await expectConstraintFailure(
      rawDb.exec(
        `delete from CadreControl.FormationInvite
           with context OwnerKey = ?, Signature = ?
           where Token = ?`,
        [founder.publicKey, capturedSig, token],
      ),
      'AuthorizedDelete',
    );
    expect(
      await rawDb.get('select Token from CadreControl.FormationInvite where Token = ?', [token]),
    ).toBeDefined();

    // The properly 'remove'-tagged approval over the stored row IS what revokes it.
    const stored = await rawDb.get(
      'select StampId from CadreControl.FormationInvite where Token = ?',
      [token],
    );
    const removeSig = signAs(
      founder,
      // Field order mirrors AuthorizedDelete: Token, sAppId, ExpiresAt, TotalUses,
      // ValidationUrl, StrandId, StampId — the four nullable fields sign as ''.
      buildAuthorizationMessage('CadreControl.FormationInvite', 'remove', [
        token, 'sapp-domain-sep', '', '', '', '', String(stored?.StampId),
      ]),
    );
    await rawDb.exec(
      `delete from CadreControl.FormationInvite
         with context OwnerKey = ?, Signature = ?
         where Token = ?`,
      [founder.publicKey, removeSig, token],
    );
    expect(
      await rawDb.get('select Token from CadreControl.FormationInvite where Token = ?', [token]),
    ).toBeUndefined();
  }, 60_000);
});
