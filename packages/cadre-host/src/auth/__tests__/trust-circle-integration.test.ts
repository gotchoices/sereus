import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '@serfab/cadre-core';

import { TrustCircleService } from '../trust-circle.js';
import { TrustCircleStore } from '../trust-circle-store.js';

/**
 * End-to-end integration test: stand up two real CadreNodes (host + phone)
 * with a real Quereus control DB, then exercise the full TrustCircleService
 * issue → redeem → list → remove cycle.
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
  let phone: CadreNode;
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

    // Distinct party IDs so the two nodes don't share a control network —
    // we only need the phone for its peerId.
    const baseId = Math.random().toString(36).slice(2);

    host = new CadreNode({
      controlNetwork: { partyId: `host-${baseId}`, bootstrapNodes: [] },
      profile: 'transaction'
    });
    phone = new CadreNode({
      controlNetwork: { partyId: `phone-${baseId}`, bootstrapNodes: [] },
      profile: 'transaction'
    });

    await host.start();
    await phone.start();

    const db = host.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertAuthorityKey(hostAuthorityPublicKey);

    host.initializeSeedBootstrap(hostAuthorityPrivateKey);

    store = new TrustCircleStore(tmpRoot);
    service = new TrustCircleService({ cadreNode: host, store });
  }, 60_000);

  afterEach(async () => {
    try { await host.stop(); } catch { /* ignore */ }
    try { await phone.stop(); } catch { /* ignore */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('completes the full issue → redeem → list → remove cycle', async () => {
    const phonePeerId = phone.peerId!.toString();

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

    // List — should see the peer once, labelled.
    const snap = await service.list();
    expect(snap.members).toHaveLength(1);
    expect(snap.members[0]!.peerId).toBe(phonePeerId);
    expect(snap.members[0]!.label).toBe("Mom's phone");
    expect(snap.pending).toHaveLength(0);

    // Remove
    await service.removeMember(phonePeerId);

    // CadrePeer row is gone (validates DELETE-with-context end-to-end).
    expect(await isInCadrePeer(host, phonePeerId)).toBe(false);

    // Local label is gone.
    expect(store.getMember(phonePeerId)).toBeUndefined();

    // list() reflects the removal.
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
