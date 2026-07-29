import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import debug from 'debug';
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
import type { DeviceTokenAuthorizedRow } from '../src/peer-authorization.js';
import { signDeviceTokenRecord } from '../src/device-token.js';
import { expectConstraintFailure } from './control-constraint-helpers.js';

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

const log = debug('sereus:cadre:test:domain-separation');

describe('CadreControl approval domain separation', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

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

  /** Retire a stamp into `CadreControl.Revocation` — the delete-side companion every
   * guarded delete must carry (`RevocationRecorded`), so rejection assertions stay
   * pinned to the constraint under test. Owner-signed over its OWN domain-tagged digest
   * (`Revocation.Authorized`); the delete's `'remove'` signature does not satisfy it. */
  function tombstoneStamp(tableName: 'OwnerKey' | 'CadrePeer' | 'DeviceToken', stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?)`,
      [
        founder.publicKey,
        signAs(founder, buildAuthorizationMessage('CadreControl.Revocation', 'remove', [tableName, stampId])),
        tableName,
        stampId,
      ],
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

  /** Vouch a `CadrePeer` membership row the legitimate way, so `DeviceToken`'s
   * self-update branch has a `PublicKey` to verify against. */
  async function seatCadrePeer(peerId: string, publicKey: string | null): Promise<string> {
    const stamp = freshStamp();
    const vouchSig = signB64(founder, cadrePeerVoucherDigest(peerId, stamp));
    await rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, peerId, publicKey, '', null, null, stamp, founder.publicKey, vouchSig],
    );
    return stamp;
  }

  /** The owner approval `DeviceToken.AuthorizedInsert` verifies: the WHOLE row, ending in
   * its single-use stamp. Taking the same struct the write does means a test cannot
   * approve one row and present another by accident — only on purpose. */
  function approveDeviceTokenAdd(row: DeviceTokenAuthorizedRow): string {
    return signB64(founder, deviceTokenAddDigest(row));
  }

  function rawInsertDeviceToken(
    contextOwner: string | null,
    signature: string | null,
    row: DeviceTokenAuthorizedRow,
  ): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig, StampId)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?)`,
      [contextOwner, signature, row.peerId, row.platform, row.token, row.updatedAt, row.sig, row.stampId],
    );
  }

  function rawDeleteDeviceToken(
    contextOwner: string | null,
    signature: string | null,
    peerId: string,
  ): Promise<void> {
    return rawDb.exec(
      `delete from CadreControl.DeviceToken
         with context OwnerKey = ?, Signature = ?
         where PeerId = ?`,
      [contextOwner, signature, peerId],
    );
  }

  /** The legitimate clear shape: owner-signed delete + the stamp's tombstone, one transaction. */
  function clearDeviceToken(peerId: string, stampId: string): Promise<void> {
    return inTransaction(async () => {
      await rawDeleteDeviceToken(
        founder.publicKey,
        signB64(founder, deviceTokenRemoveDigest(peerId, stampId)),
        peerId,
      );
      await tombstoneStamp('DeviceToken', stampId);
    });
  }

  function deviceTokenRow(peerId: string): Promise<Record<string, unknown> | undefined> {
    return rawDb.get(
      'select PeerId, Platform, Token, UpdatedAt, StampId from CadreControl.DeviceToken where PeerId = ?',
      [peerId],
    );
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
      'AuthorizedInsert',
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
    // The tombstone rides along so `RevocationRecorded` is satisfied and the rejection
    // stays pinned to the cross-table replay constraint alone. The OwnerKey row
    // deliberately shares the same stamp STRING — harmless, `Revocation.RowIsGone`'s
    // branches are per-table.
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDb.exec(
          `delete from CadreControl.CadrePeer
             with context OwnerKey = ?, Signature = ?
             where PeerId = ?`,
          [founder.publicKey, removeSig, second.publicKey],
        );
        await tombstoneStamp('CadrePeer', stamp);
      }),
      'AuthorizedDelete',
    );
    expect(
      await rawDb.get('select PeerId from CadreControl.CadrePeer where PeerId = ?', [second.publicKey]),
    ).toBeDefined();

    // Prove the removal signature is genuine: the rule it was minted for accepts it
    // (with the mandatory stamp retirement alongside).
    await inTransaction(async () => {
      await rawDb.exec(
        `delete from CadreControl.OwnerKey
           with context OwnerKey = ?, Signature = ?
           where Key = ?`,
        [founder.publicKey, removeSig, second.publicKey],
      );
      await tombstoneStamp('OwnerKey', stamp);
    });
    expect(await ownerKeys()).toEqual([founder.publicKey]);
  }, 60_000);

  // ── DeviceToken: one constraint used to gate insert AND delete ─────────────

  it('rejects: a DeviceToken insert approval replayed as a DeviceToken delete', async () => {
    const peerId = '12D3KooWDeviceTokenTarget';
    const row: DeviceTokenAuthorizedRow = {
      peerId, platform: 'fcm', token: 'tok-domain-sep', updatedAt: null, sig: null, stampId: freshStamp(),
    };
    const addSig = approveDeviceTokenAdd(row);
    await rawInsertDeviceToken(founder.publicKey, addSig, row);

    // The tombstone rides along so `RevocationRecorded` is satisfied and the rejection
    // stays pinned to the insert-approval-replayed-as-delete constraint alone.
    await expectConstraintFailure(
      inTransaction(async () => {
        await rawDeleteDeviceToken(founder.publicKey, addSig, peerId);
        await tombstoneStamp('DeviceToken', row.stampId);
      }),
      'AuthorizedDelete',
    );
    expect(await deviceTokenRow(peerId)).toBeDefined();

    // The properly 'remove'-tagged approval over the stored (PeerId, StampId) is what
    // deletes it — with the mandatory stamp retirement alongside.
    await clearDeviceToken(peerId, row.stampId);
    expect(await deviceTokenRow(peerId)).toBeUndefined();
  }, 60_000);

  // ── DeviceToken: the three attacks the single-use stamp closes ──────────────

  it('rejects: a DeviceToken approval presenting a row OTHER than the one approved', async () => {
    // Pre-fix the approval covered the PeerId alone, so one captured owner signature
    // authorized ANY (Platform, Token) for that peer: an attacker who held it could point
    // the party's push-wakes at a device it controlled. The digest now binds every column.
    const peerId = '12D3KooWDeviceTokenRowBinding';
    const stamp = freshStamp();
    const approved: DeviceTokenAuthorizedRow = {
      peerId, platform: 'fcm', token: 'tok-good', updatedAt: null, sig: null, stampId: stamp,
    };
    const addSig = approveDeviceTokenAdd(approved);

    // A FIRST insert with a fresh stamp, deliberately: after a clear, `NotRevoked` would
    // also be violated and which constraint Quereus names becomes ambiguous.
    await expectConstraintFailure(
      rawInsertDeviceToken(founder.publicKey, addSig, { ...approved, platform: 'apns', token: 'tok-evil' }),
      'AuthorizedInsert',
    );
    expect(await deviceTokenRow(peerId)).toBeUndefined();

    // Same approval, the row it actually approved: admitted. So the rejection above was
    // the row substitution, not a bad signature.
    await rawInsertDeviceToken(founder.publicKey, addSig, approved);
    expect((await deviceTokenRow(peerId))?.Token).toBe('tok-good');
  }, 60_000);

  it('rejects: a DeviceToken approval replayed after the token was cleared (retired stamp)', async () => {
    // The clear (logout) is the whole point of the retirement: the cleared device still
    // holds the never-expiring approval that seated its row, and a push token has NO
    // freshness ceiling to age out, so `unique` alone — which only holds over LIVE rows —
    // let the exact row come back the moment the delete freed the stamp.
    const peerId = '12D3KooWDeviceTokenCleared';
    const row: DeviceTokenAuthorizedRow = {
      peerId, platform: 'fcm', token: 'tok-cleared', updatedAt: null, sig: null, stampId: freshStamp(),
    };
    const addSig = approveDeviceTokenAdd(row);
    await rawInsertDeviceToken(founder.publicKey, addSig, row);
    await clearDeviceToken(peerId, row.stampId);
    expect(await deviceTokenRow(peerId)).toBeUndefined();

    // Replay the captured approval VERBATIM against the EXACT row it approved:
    // `AuthorizedInsert` still passes (the signature is genuine and the founder is still
    // an owner), so `NotRevoked` is the only thing standing.
    await expectConstraintFailure(
      rawInsertDeviceToken(founder.publicKey, addSig, row),
      'NotRevoked',
    );
    expect(await deviceTokenRow(peerId)).toBeUndefined();

    // Retirement is per-STAMP, not a ban on the peer: a fresh stamp + fresh approval
    // re-registers (the logout → login path).
    const reRegistered: DeviceTokenAuthorizedRow = { ...row, token: 'tok-again', stampId: freshStamp() };
    await rawInsertDeviceToken(founder.publicKey, approveDeviceTokenAdd(reRegistered), reRegistered);
    expect((await deviceTokenRow(peerId))?.Token).toBe('tok-again');
  }, 60_000);

  it('rejects: an owner-signed DeviceToken update — the owner re-touch branch is gone', async () => {
    // The removed branch verified an owner signature over `digest('CadreControl.DeviceToken',
    // 'vouch', new.PeerId)` and sat OUTSIDE the monotonicity requirement, so ONE captured
    // owner approval rewrote Platform/Token at will and could roll UpdatedAt backwards (or
    // park it in the far future, wedging the peer's own self-updates forever). No writer
    // used it; an owner correcting a row now deletes it (retiring the stamp) and re-inserts.
    const peer = freshKeyPair();
    const peerId = '12D3KooWDeviceTokenOwnerUpdate';
    // A real CadrePeer row with the peer's PublicKey, so the surviving self-update branch
    // has something to verify against — the rejection below is the ABSENT owner branch,
    // not a missing peer row.
    await seatCadrePeer(peerId, peer.publicKey);
    const first = signDeviceTokenRecord(
      { peerId, platform: 'fcm', token: 'tok-self-1', updatedAt: 1_000 },
      peer.privateKey,
    );
    const seated: DeviceTokenAuthorizedRow = { ...first, stampId: freshStamp() };
    await rawInsertDeviceToken(founder.publicKey, approveDeviceTokenAdd(seated), seated);

    // Owner context, a genuine owner signature over the digest that branch checked, and a
    // monotonically HIGHER UpdatedAt — nothing stale about it, and still refused.
    const ownerVouch = signAs(
      founder,
      buildAuthorizationMessage('CadreControl.DeviceToken', 'vouch', [peerId]),
    );
    await expectConstraintFailure(
      rawDb.exec(
        `update CadreControl.DeviceToken
           with context OwnerKey = ?, Signature = ?
           set Platform = ?, Token = ?, UpdatedAt = ?
           where PeerId = ?`,
        [founder.publicKey, ownerVouch, 'apns', 'tok-owner-rewrite', 2_000, peerId],
      ),
      'AuthorizedUpdate',
    );
    const unchanged = await deviceTokenRow(peerId);
    expect(unchanged?.Token).toBe('tok-self-1');
    expect(Number(unchanged?.UpdatedAt)).toBe(1_000);

    // The peer's OWN monotonic, self-signed update is what rotates the row.
    const second = signDeviceTokenRecord(
      { peerId, platform: 'apns', token: 'tok-self-2', updatedAt: 2_000 },
      peer.privateKey,
    );
    await rawDb.exec(
      `update CadreControl.DeviceToken
         with context OwnerKey = null, Signature = ?
         set Platform = ?, Token = ?, UpdatedAt = ?, Sig = ?
         where PeerId = ?`,
      [second.sig, second.platform, second.token, second.updatedAt, second.sig, peerId],
    );
    expect((await deviceTokenRow(peerId))?.Token).toBe('tok-self-2');
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
