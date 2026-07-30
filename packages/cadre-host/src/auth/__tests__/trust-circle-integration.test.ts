import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { CadreNode, ed25519KeyPairFromLibp2p } from '@serfab/cadre-core';

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
  let hostOwnerPrivateKey: string;
  let hostOwnerPublicKey: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cadre-host-tc-int-'));

    // Own-owner host: the node's libp2p identity key IS its owner key
    // (the cadre-cli `--owner` shape), so registerSelf can owner-sign the
    // INSERT of its own CadrePeer row.
    const hostKey = await generateKeyPair('Ed25519');
    const owner = ed25519KeyPairFromLibp2p(hostKey);
    hostOwnerPrivateKey = owner.privateKeyB64;
    hostOwnerPublicKey = owner.publicKeyB64;

    const baseId = Math.random().toString(36).slice(2);

    host = new CadreNode({
      controlNetwork: { partyId: `host-${baseId}`, bootstrapNodes: [] },
      privateKey: hostKey,
      profile: 'transaction'
    });

    await host.start();

    const db = host.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertOwnerKey(hostOwnerPublicKey);

    host.initializeSeedBootstrap(hostOwnerPrivateKey);

    // The owner writes its own CadrePeer row up-front (the implement ticket's
    // CLI change). After this the host's own peerId is a member, so it shows up
    // alongside any redeemed peers in the trust-circle listing.
    await host.registerSelf();

    store = new TrustCircleStore(tmpRoot);
    // Mirrors the self-labelling bin/host.ts does via OwnerNodeClient.getPeerId()
    // after spawning the owner node — this test bypasses that client entirely
    // (constructs TrustCircleService directly against a real CadreNode), so the
    // local label has to be seeded by hand here.
    store.addMember({
      peerId: host.peerId!.toString(),
      label: 'This device',
      addedAt: new Date().toISOString(),
      self: true,
    });
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

    // List — exercises the CadreNode.listMembers() path. CadrePeer now carries
    // the host's own self-registered row in addition to the redeemed phone.
    const snap = await service.list();
    expect(snap.members).toHaveLength(2);
    const phoneMember = snap.members.find((m) => m.peerId === phonePeerId);
    expect(phoneMember).toBeDefined();
    expect(phoneMember!.label).toBe("Mom's phone");
    // The host's own peerId is present too (unlabeled → bare peerId as label).
    expect(snap.members.some((m) => m.peerId === host.peerId!.toString())).toBe(true);
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
    // The phone is gone; the host's own self-registered row remains.
    expect(afterRemove.members.map((m) => m.peerId)).not.toContain(phonePeerId);
    expect(afterRemove.members).toHaveLength(1);
    expect(afterRemove.members[0]!.peerId).toBe(host.peerId!.toString());
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
