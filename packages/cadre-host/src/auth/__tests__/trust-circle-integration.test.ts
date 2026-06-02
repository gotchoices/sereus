import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode } from '@serfab/cadre-core';

import { TrustCircleService } from '../trust-circle.js';
import { TrustCircleStore } from '../trust-circle-store.js';

/**
 * End-to-end integration test: stand up a real host CadreNode with a real
 * Quereus control DB and exercise the full TrustCircleService issue → redeem
 * → list → remove cycle. The "phone" peerId is derived from a fresh Ed25519
 * key (no second libp2p node) since the test only validates host-side state.
 *
 * This replaces the mock CadreNodeLike in trust-circle.test.ts with the real
 * CadreNode to validate that:
 *  - `acceptPhone` (called from redeemInvite with a sparse reconstructed
 *    invite) actually inserts a CadrePeer row;
 *  - `list()` picks up the new peer via the canonical CadrePeer query;
 *  - `removeMember` deletes the row from CadrePeer via the
 *    DELETE-with-context syntax that cadre-core trusts from
 *    `quereus/docs/sql.md`.
 */
describe('TrustCircleService — real CadreNode integration', () => {
  let tmpRoot: string;
  let host: CadreNode;
  let store: TrustCircleStore;
  let service: TrustCircleService;
  let hostAuthorityPrivateKey: string;
  let hostAuthorityPublicKey: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-tc-int-'));

    hostAuthorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    hostAuthorityPublicKey = getPublicKey(
      hostAuthorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url'
    ) as string;

    const baseId = Math.random().toString(36).slice(2);

    host = new CadreNode({
      controlNetwork: { partyId: `host-${baseId}`, bootstrapNodes: [] },
      profile: 'transaction'
    });

    await host.start();

    const db = host.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertAuthorityKey(hostAuthorityPublicKey);

    host.initializeSeedBootstrap(hostAuthorityPrivateKey);

    store = new TrustCircleStore(tmpRoot);
    service = new TrustCircleService({ cadreNode: host, store });
  }, 60_000);

  afterEach(async () => {
    try { await host.stop(); } catch { /* ignore */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('issues → redeems → lists against the real control DB (listMembers path)', async () => {
    // Derive a shape-valid peerId from a fresh Ed25519 key — same pattern as
    // packages/cadre-core/test/seed-bootstrap.spec.ts. The AuthorizedInsert
    // constraint only checks the signature over digest(PeerId,…); peerId
    // *liveness* doesn't matter for the host-side CRUD path under test.
    const phoneKey = await generateKeyPair('Ed25519');
    const phonePeerId = peerIdFromPrivateKey(phoneKey).toString();

    // Issue
    const issued = await service.issueInvite({ label: "Mom's phone" });
    expect(issued.token).toBeTruthy();
    expect(issued.encodedInvite).toBeTruthy();

    // Redeem — this calls host.acceptPhone() with the sparse reconstructed
    // invite, which in turn calls authorizePeer and inserts CadrePeer.
    const redeemed = await service.redeemInvite({
      token: issued.token,
      peerId: phonePeerId
    });
    expect(redeemed).toEqual({ peerId: phonePeerId, label: "Mom's phone" });

    // Verify directly against the control DB: the row is there.
    expect(await isInCadrePeer(host, phonePeerId)).toBe(true);

    // List — should see the peer once, labelled. Exercises the new
    // CadreNode.listMembers() path that replaced getControlDatabase().
    const snap = await service.list();
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0]!.peerId).toBe(phonePeerId);
    expect(snap.members[0]!.label).toBe("Mom's phone");
    expect(snap.pending).toHaveLength(0);
  }, 90_000);

  // The signed `CadrePeer` DELETE previously threw a Quereus deferred-constraint
  // error ("No row context found for column PeerId") inside cadre-core's
  // removePeer. That upstream bug is fixed (`quereus-cadrepeer-delete-no-row-context`,
  // landed), so the full issue → redeem → remove cycle is now exercised here.
  it('removes a member from CadrePeer', async () => {
    const phoneKey = await generateKeyPair('Ed25519');
    const phonePeerId = peerIdFromPrivateKey(phoneKey).toString();

    const issued = await service.issueInvite({ label: "Mom's phone" });
    await service.redeemInvite({ token: issued.token, peerId: phonePeerId });
    expect(await isInCadrePeer(host, phonePeerId)).toBe(true);

    await service.removeMember(phonePeerId);

    expect(await isInCadrePeer(host, phonePeerId)).toBe(false);
    expect(store.getMember(phonePeerId)).toBeUndefined();
    const afterRemove = await service.list();
    expect(afterRemove.members).toHaveLength(0);
  }, 90_000);
});

async function isInCadrePeer(node: CadreNode, peerId: string): Promise<boolean> {
  const db = node.getControlDatabase();
  if (!db) return false;
  const inner = db.getDatabase();
  for await (const row of inner.eval(
    'select PeerId from CadreControl.CadrePeer where PeerId = ?',
    [peerId]
  )) {
    if (row.PeerId === peerId) return true;
  }
  return false;
}
