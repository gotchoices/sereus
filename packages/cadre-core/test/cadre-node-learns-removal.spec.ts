import { describe, it, expect } from 'vitest';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { revocationDigest } from '../src/peer-authorization.js';
import type { CadreRemoval, RevocationRow } from '../src/types.js';
import { createConfig, makeOwner, vouchedRow, inject, anchorWith, type Owner, type PeerRow } from './membership-gate-helpers.js';

/**
 * A node reports its own removal from the cadre (`cadre:removed`, `removedFromCadre()`) only
 * when a `CadrePeer` tombstone names it, it has no live row, and a membership refresh of this
 * process saw its live row before: "Removing a machine" in docs/architecture.md. Driven
 * through the gate suites' fake control database, whose `queryCadrePeers` drops rows with a
 * retired stamp as the real one does.
 */

const SELF = 'self-peer';

/** A `CadrePeer` tombstone for `peerId`, signed by `owner` as `Revocation.Authorized` requires. */
function tombstoneFor(partyId: string, peerId: string, stampId: string, owner: Owner): RevocationRow {
  const signerSig = sign(revocationDigest(partyId, 'CadrePeer', peerId, stampId), owner.privateKey, 'ed25519', 'base64url', 'base64url', 'base64url') as string;
  return { tableName: 'CadrePeer', rowKey: peerId, stampId, reissuedAt: 0, signerKey: owner.publicKey, signerSig };
}

async function setUp(members: PeerRow[], tombstones: RevocationRow[]): Promise<{ node: CadreNode; owner: Owner; revoked: Set<string>; events: CadreRemoval[] }> {
  const node = new CadreNode(createConfig());
  const owner = makeOwner();
  const revoked = new Set<string>();
  inject(node, { selfPeerId: SELF, members, revoked, tombstones, anchor: await anchorWith(node.partyId, owner.publicKey) });
  const events: CadreRemoval[] = [];
  node.on('cadre:removed', (removal) => events.push(removal));
  return { node, owner, revoked, events };
}

describe('CadreNode learns it was removed', () => {
  it('reports once, from the tombstone, after its own row was seen live and then retired', async () => {
    const members: PeerRow[] = [];
    const tombstones: RevocationRow[] = [];
    const { node, owner, revoked, events } = await setUp(members, tombstones);
    const own = vouchedRow(node.partyId, SELF, owner);
    members.push(own);
    await node.refreshMembershipGate('test');
    expect(node.removedFromCadre()).toBeNull();

    revoked.add(own.stampId!);
    tombstones.push(tombstoneFor(node.partyId, SELF, own.stampId!, owner));
    await node.refreshMembershipGate('test');
    await node.refreshMembershipGate('test');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ partyId: node.partyId, stampId: own.stampId, signerKey: owner.publicKey });
    expect(node.removedFromCadre()).toBe(events[0]);
  });

  it('does not report a tombstone for itself when it never saw its own row live (a machine joining again)', async () => {
    const tombstones: RevocationRow[] = [];
    const { node, owner, events } = await setUp([], tombstones);
    tombstones.push(tombstoneFor(node.partyId, SELF, 'stamp-old', owner));

    await node.refreshMembershipGate('test');

    expect(events).toHaveLength(0);
    expect(node.removedFromCadre()).toBeNull();
  });

  it('does not report a tombstone for itself while a live row under a fresh stamp exists (re-added)', async () => {
    const members: PeerRow[] = [];
    const tombstones: RevocationRow[] = [];
    const { node, owner, revoked, events } = await setUp(members, tombstones);
    const first = vouchedRow(node.partyId, SELF, owner);
    members.push(first);
    await node.refreshMembershipGate('test');

    revoked.add(first.stampId!);
    tombstones.push(tombstoneFor(node.partyId, SELF, first.stampId!, owner));
    members.push({ ...first, stampId: 'stamp-readmitted' });
    await node.refreshMembershipGate('test');

    expect(events).toHaveLength(0);
    expect(node.removedFromCadre()).toBeNull();
  });
});
