import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Database } from '@quereus/quereus';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { signSchema } from '../src/schema-verification.js';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';

/**
 * Exercises {@link CadreNode.publishStrand} — the node-level method the RN chat
 * demo calls (in `createChatStrand`) to make a newly-created strand discoverable
 * cadre-wide, the owner-signed `Strand` INSERT that `addStrand` deliberately
 * omits.
 *
 * The DB-level `insertStrand` happy path is covered by
 * `control-authorization-binding.spec.ts`; this pins the node wrapper end-to-end:
 * it self-signs with the node's own owner key (the `getSelfSigningKey` path)
 * and lands a real `Strand` row. Mirrors `publish-formation-invite.spec.ts`.
 *
 * Boots a self-signing node the way `seed-bootstrap.spec.ts` does: the node's
 * libp2p key IS its owner key (`ed25519KeyPairFromLibp2p`), enrolled in
 * `OwnerKey` so its self-signed control writes are authorised.
 */
describe('CadreNode.publishStrand (node-level discoverable-strand publish)', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function startSelfOwnerNode(enrollOwner: boolean): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);

    const n = new CadreNode({
      controlNetwork: {
        partyId: 'publish-strand-' + rand(),
        bootstrapNodes: [],
      },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await n.start();

    if (enrollOwner) {
      const db = n.getControlDatabase();
      expect(db).not.toBeNull();
      // Enroll the node's own key so its self-signed Strand insert is authorised.
      await db!.insertOwnerKey(publicKeyB64);
    }
    return n;
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('happy path: lands a Strand row queryable from the control DB', async () => {
    node = await startSelfOwnerNode(true);
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
    node = await startSelfOwnerNode(true);
    const db = node.getControlDatabase()!;
    const strandId = 'strand-c-' + rand();
    const memberKey = 'member-key-' + rand();

    await node.publishStrand(strandId, 'c', memberKey);

    const stored = await db.queryStrand(strandId);
    expect(stored?.Type).toBe('c');
    expect(stored?.MemberPrivateKey).toBe(memberKey);
  }, 60_000);

  it('rejects when the node is not an enrolled owner (constraint propagates)', async () => {
    // Self-signing key is present (past the "no signing key" guard), but it is
    // not enrolled in OwnerKey, so the Strand.Authorized gate rejects the
    // insert and the rejection must surface (no silent local-only strand).
    node = await startSelfOwnerNode(false);
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

// ── CadreNode.addStrand founder bootstrap (node-level seam) ──────────────────

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

function signedSApp() {
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, priv) };
}

async function countRow(db: Database, table: 'Header' | 'Member' | 'Manager'): Promise<number> {
  for await (const row of db.eval(`select count(1) as c from Strand.${table}`)) {
    return (row as { c: number }).c;
  }
  return 0;
}

describe('CadreNode.addStrand founder bootstrap (node-level seam)', () => {
  let node: CadreNode | undefined;

  const rand2 = (): string => Math.random().toString(36).slice(2);

  async function startNode(): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);
    const n = new CadreNode({
      controlNetwork: { partyId: 'addstrand-founder-' + rand2(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await n.start();
    await n.getControlDatabase()!.insertOwnerKey(publicKeyB64);
    return n;
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('founder of a closed strand: Header=1, Member=1, Manager=1 with derived key', async () => {
    node = await startNode();
    const strandId = 'addstrand-closed-' + rand2();
    const memberPrivateKey = await generateStrandMemberKey();

    const instance = await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: memberPrivateKey, Type: 'c' },
      sAppConfig: signedSApp(),
      founder: true,
    });

    expect(instance.status).toBe('active');
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(1);
    expect(await countRow(db, 'Manager')).toBe(1);

    const expectedKey = strandMemberKeyPair(memberPrivateKey).publicKeyB64;
    const member = await db.get('select Key from Strand.Member');
    const manager = await db.get('select MemberKey from Strand.Manager');
    expect(member?.Key).toBe(expectedKey);
    expect(manager?.MemberKey).toBe(expectedKey);
  }, 60_000);

  it('founder of an open strand: Header=1, Member=0, Manager=0, Header.Type=o', async () => {
    node = await startNode();
    const strandId = 'addstrand-open-' + rand2();

    const instance = await node.addStrand({
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: signedSApp(),
      founder: true,
    });

    expect(instance.status).toBe('active');
    const db = instance.database!.getDatabase();
    expect(await countRow(db, 'Header')).toBe(1);
    expect(await countRow(db, 'Member')).toBe(0);
    expect(await countRow(db, 'Manager')).toBe(0);

    const header = await db.get('select Type from Strand.Header');
    expect(header?.Type).toBe('o');
  }, 60_000);

  it('closed founder with null MemberPrivateKey rejects', async () => {
    node = await startNode();
    const strandId = 'addstrand-closed-nokey-' + rand2();

    await expect(
      node.addStrand({
        strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'c' },
        sAppConfig: signedSApp(),
        founder: true,
      }),
    ).rejects.toThrow(/MemberPrivateKey/i);
  }, 60_000);
});
