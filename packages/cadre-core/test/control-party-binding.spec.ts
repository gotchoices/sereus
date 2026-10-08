import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';
import { buildAuthorizationMessage } from '../src/control-database.js';
import { cadrePeerVoucherDigest } from '../src/peer-authorization.js';
import {
  expectConstraintFailure,
  freshKeyPair,
  freshStamp,
  revocationMessage,
  signAs,
  signB64,
} from './control-constraint-helpers.js';
import type { KeyPair } from './control-constraint-helpers.js';

/**
 * Party binding of every signed `CadreControl` approval.
 *
 * Each digest the schema verifies puts `party_id()` third — the party THIS machine is
 * configured for, registered by `ControlDatabase` on its own engine — so an approval
 * signed for one party never verifies in another, even when the two share an owner key
 * (one node key owning two cadres, or a hardware owner key). Each case here signs with
 * the node's own founder key over the exact row it then writes, but builds the message
 * for a different party id, and asserts the rejection BY CONSTRAINT NAME; it then writes
 * the same row signed for the node's party, so the only thing that changed the outcome
 * is the party. The reader-side mirrors (`verifyCadrePeerVoucher`,
 * `verifyRevocationSigner`) are pinned in `peer-authorization.spec.ts`.
 *
 * One `CadreNode` per test (empty bootstrap, transaction profile), as
 * `control-authorization-domain-separation.spec.ts` boots one.
 */

const OTHER_PARTY = 'other-party';

describe('CadreControl approvals are bound to the party', () => {
  let node: CadreNode;
  let db: ControlDatabase;
  let rawDb: Database;
  let founder: KeyPair;

  beforeEach(async () => {
    founder = freshKeyPair();
    node = new CadreNode({
      controlNetwork: {
        partyId: 'party-binding-' + Math.random().toString(36).slice(2),
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

  function insertOwnerKey(signature: string, key: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.OwnerKey (Key, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?)`,
      [founder.publicKey, signature, key, stampId, founder.publicKey, signature],
    );
  }

  function insertCadrePeer(vouchSig: string, peerId: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [founder.publicKey, vouchSig, peerId, null, '', null, null, stampId, founder.publicKey, vouchSig],
    );
  }

  function insertTombstone(signature: string, rowKey: string, stampId: string): Promise<void> {
    return rawDb.exec(
      `insert into CadreControl.Revocation (TableName, RowKey, StampId, SignerKey, SignerSig)
         with context OwnerKey = ?, Signature = ?
         values (?, ?, ?, ?, ?)`,
      [founder.publicKey, signature, 'CadrePeer', rowKey, stampId, founder.publicKey, signature],
    );
  }

  async function count(sql: string, params: string[]): Promise<number> {
    const row = await rawDb.get(sql, params);
    return Number(row?.n ?? 0);
  }

  it('rejects an OwnerKey add signed for another party (Authorized), accepts it for this one', async () => {
    const second = freshKeyPair();
    const stamp = freshStamp();
    const forOther = signAs(founder, buildAuthorizationMessage('CadreControl.OwnerKey', 'add', OTHER_PARTY, [second.publicKey, stamp]));

    await expectConstraintFailure(insertOwnerKey(forOther, second.publicKey, stamp), 'Authorized');
    expect(await count('select count(1) as n from CadreControl.OwnerKey where Key = ?', [second.publicKey])).toBe(0);

    const forThis = signAs(founder, buildAuthorizationMessage('CadreControl.OwnerKey', 'add', node.partyId, [second.publicKey, stamp]));
    await insertOwnerKey(forThis, second.publicKey, stamp);
    expect(await count('select count(1) as n from CadreControl.OwnerKey where Key = ?', [second.publicKey])).toBe(1);
  }, 60_000);

  it('rejects a CadrePeer voucher minted for another party (AuthorizedInsert), accepts one for this party', async () => {
    // The shape of the attack: a stored VouchOwner / VouchSig pair copied from the other
    // party's replicated table, presented verbatim as this party's insert context.
    const peerId = '12D3KooWPartyBoundPeer';
    const stamp = freshStamp();
    const forOther = signB64(founder, cadrePeerVoucherDigest(OTHER_PARTY, peerId, stamp));

    await expectConstraintFailure(insertCadrePeer(forOther, peerId, stamp), 'AuthorizedInsert');
    expect(await count('select count(1) as n from CadreControl.CadrePeer where PeerId = ?', [peerId])).toBe(0);

    const forThis = signB64(founder, cadrePeerVoucherDigest(node.partyId, peerId, stamp));
    await insertCadrePeer(forThis, peerId, stamp);
    expect(await count('select count(1) as n from CadreControl.CadrePeer where PeerId = ?', [peerId])).toBe(1);
  }, 60_000);

  it('rejects a Revocation tombstone signed for another party (Authorized), accepts one for this party', async () => {
    // A stamp no row ever carried: RowIsGone holds, so only Authorized can refuse the row.
    const peerId = '12D3KooWPartyBoundTombstone';
    const stamp = freshStamp();
    const forOther = signAs(founder, revocationMessage(OTHER_PARTY, 'CadrePeer', peerId, stamp));

    await expectConstraintFailure(insertTombstone(forOther, peerId, stamp), 'Authorized');
    expect(await count('select count(1) as n from CadreControl.Revocation where StampId = ?', [stamp])).toBe(0);

    const forThis = signAs(founder, revocationMessage(node.partyId, 'CadrePeer', peerId, stamp));
    await insertTombstone(forThis, peerId, stamp);
    expect(await count('select count(1) as n from CadreControl.Revocation where StampId = ?', [stamp])).toBe(1);
  }, 60_000);
});
