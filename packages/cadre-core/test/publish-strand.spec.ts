import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { authorityKeyFromLibp2p } from '../src/authority-key.js';

/**
 * Exercises {@link CadreNode.publishStrand} — the node-level method the RN chat
 * demo calls (in `createChatStrand`) to make a newly-created strand discoverable
 * cadre-wide, the authority-signed `Strand` INSERT that `addStrand` deliberately
 * omits.
 *
 * The DB-level `insertStrand` happy path is covered by
 * `control-authorization-binding.spec.ts`; this pins the node wrapper end-to-end:
 * it self-signs with the node's own authority key (the `getSelfSigningKey` path)
 * and lands a real `Strand` row. Mirrors `publish-formation-invite.spec.ts`.
 *
 * Boots a self-signing node the way `seed-bootstrap.spec.ts` does: the node's
 * libp2p key IS its authority key (`authorityKeyFromLibp2p`), enrolled in
 * `AuthorityKey` so its self-signed control writes are authorised.
 */
describe('CadreNode.publishStrand (node-level discoverable-strand publish)', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function startSelfAuthorityNode(enrollAuthority: boolean): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = authorityKeyFromLibp2p(nodeKey);

    const n = new CadreNode({
      controlNetwork: {
        partyId: 'publish-strand-' + rand(),
        bootstrapNodes: [],
      },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await n.start();

    if (enrollAuthority) {
      const db = n.getControlDatabase();
      expect(db).not.toBeNull();
      // Enroll the node's own key so its self-signed Strand insert is authorised.
      await db!.insertAuthorityKey(publicKeyB64);
    }
    return n;
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('happy path: lands a Strand row queryable from the control DB', async () => {
    node = await startSelfAuthorityNode(true);
    const db = node.getControlDatabase()!;
    const strandId = 'strand-' + rand();

    await node.publishStrand(strandId, 'o');

    const row = await db.getDatabase().get(
      'select Id, Type from CadreControl.Strand where Id = ?',
      [strandId],
    );
    expect(row?.Id).toBe(strandId);
    expect(row?.Type).toBe('o');

    // And queryStrands (what the StrandWatcher reads) surfaces it too.
    const strands = await db.queryStrands();
    expect(strands.some((s) => s.Id === strandId && s.Type === 'o')).toBe(true);
  }, 60_000);

  it('closed strand: persists the member key so an invitee can later attach', async () => {
    node = await startSelfAuthorityNode(true);
    const db = node.getControlDatabase()!;
    const strandId = 'strand-c-' + rand();
    const memberKey = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', memberKey);

    const stored = await db.queryStrand(strandId);
    expect(stored?.Type).toBe('c');
    expect(stored?.MemberPrivateKey).toBe(memberKey);
  }, 60_000);

  it('rejects when the node is not an enrolled authority (constraint propagates)', async () => {
    // Self-signing key is present (past the "no signing key" guard), but it is
    // not enrolled in AuthorityKey, so the Strand.Authorized gate rejects the
    // insert and the rejection must surface (no silent local-only strand).
    node = await startSelfAuthorityNode(false);
    const db = node.getControlDatabase()!;
    const before = await db.getDatabase().get('select count(1) as c from CadreControl.Strand');

    await expect(node.publishStrand('strand-' + rand(), 'o')).rejects.toThrow();

    const after = await db.getDatabase().get('select count(1) as c from CadreControl.Strand');
    expect(Number(after?.c ?? 0)).toBe(Number(before?.c ?? 0));
  }, 60_000);

  it('throws if the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'publish-strand-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await expect(stopped.publishStrand('strand-' + rand(), 'o')).rejects.toThrow(/must be started/i);
  });
});
