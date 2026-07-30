import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { signSchema } from '../src/schema-verification.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { StrandConfig } from '../src/types.js';

/**
 * Exercises the node-level strand removal surface — `unpublishStrand`, the owner-signed
 * party-wide inverse of `publishStrand` — plus the error shape of the renamed local-only
 * `stopStrand`.
 *
 * The DB-level `deleteStrand` writer and its authorization/replay defences are covered by
 * `control-authorization-binding.spec.ts` and `control-revocation-replay.spec.ts` (non-owner
 * signer refused, add-approval replay refused, tombstone transactionality). This pins the
 * wrapper: it self-signs with the node's own owner key, the row and its tombstone land,
 * blank input is refused before any write, a closed strand's `MemberPrivateKey` dies with
 * the row, the id is NOT blacklisted for owner re-publish, and the local instance is
 * stopped by the time the promise resolves.
 *
 * Boots a self-signing node the way `validation-key-enrollment.spec.ts` does: the node's
 * libp2p key IS its owner key, enrolled in `OwnerKey` so its self-signed control writes are
 * authorised.
 */
describe('CadreNode strand unpublish', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  async function startSelfOwnerNode(): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);

    const n = new CadreNode({
      controlNetwork: { partyId: 'strand-unpublish-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await n.start();

    const db = n.getControlDatabase();
    expect(db).not.toBeNull();
    await db!.insertOwnerKey(publicKeyB64);
    return n;
  }

  function revocationRow(db: ControlDatabase, stampId: string): Promise<Record<string, unknown> | undefined> {
    return db.getDatabase().get(
      'select TableName, RowKey, StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['Strand', stampId],
    );
  }

  /** A full strand config with a real signed sApp schema, for `addStrand`. */
  function createStrandConfig(strandId: string): StrandConfig {
    const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
    const schema = 'create table Test (id text primary key);';
    const version = '1.0.0';
    return {
      strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
      sAppConfig: {
        id: authorPublicKey,
        version,
        schema,
        signature: signSchema(schema, version, authorPrivateKey),
      },
    };
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('publish → unpublish removes the row and files a Revocation tombstone retiring its stamp', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-unpub-' + rand();

    await node.publishStrand(strandId);
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);

    const stampId = await db.queryStrandStampId(strandId);
    expect(stampId).not.toBeNull();

    await node.unpublishStrand(strandId);

    expect(await db.queryStrands()).toEqual([]);
    const tombstone = await revocationRow(db, stampId!);
    expect(tombstone).toBeDefined();
    expect(tombstone?.RowKey).toBe(strandId);
    expect((await db.queryRevokedStamps('Strand')).has(stampId!)).toBe(true);
  }, 60_000);

  it('unpublishing a never-published id is a silent no-op (no throw, no tombstone)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;

    await expect(node.unpublishStrand('never-published-' + rand())).resolves.toBeUndefined();

    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('rejects an empty or whitespace-only id before any write', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;

    for (const blank of ['', '   ', '\t\n']) {
      await expect(node.unpublishStrand(blank)).rejects.toThrow(/required/i);
    }

    expect(await db.queryStrands()).toEqual([]);
    expect((await db.queryRevokedStamps('Strand')).size).toBe(0);
  }, 60_000);

  it('throws the named error shapes when the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'strand-unpublish-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });

    // stopStrand keeps its pre-existing local-lifecycle error; unpublishStrand goes
    // through requireOwnerSigningKey and reports the started-guard shape.
    await expect(stopped.stopStrand('any-strand')).rejects.toThrow(/not running/);
    await expect(stopped.unpublishStrand('any-strand')).rejects.toThrow(
      /must be started before attempting to unpublish strand/i,
    );
  });

  it('unpublishing a closed strand destroys the row and its MemberPrivateKey', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-closed-' + rand();
    const memberKey = await generateStrandMemberKey();

    await node.publishStrand(strandId, 'c', memberKey);
    expect(await db.queryStrand(strandId)).toEqual({
      Id: strandId,
      MemberPrivateKey: memberKey,
      Type: 'c',
    });

    await node.unpublishStrand(strandId);

    expect(await db.queryStrand(strandId)).toBeNull();
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);

  it('re-publishing after unpublish succeeds on a fresh stamp (the id is not blacklisted)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-republish-' + rand();

    await node.publishStrand(strandId);
    const firstStamp = await db.queryStrandStampId(strandId);
    await node.unpublishStrand(strandId);

    await node.publishStrand(strandId);

    const secondStamp = await db.queryStrandStampId(strandId);
    expect(secondStamp).not.toBeNull();
    expect(secondStamp).not.toBe(firstStamp);
    expect(await revocationRow(db, firstStamp!)).toBeDefined();
    expect((await db.queryStrands()).map((row) => row.Id)).toEqual([strandId]);
  }, 60_000);

  it('stops a locally-running instance by the time the promise resolves', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const strandId = 'strand-running-' + rand();

    await node.addStrand(createStrandConfig(strandId));
    await node.publishStrand(strandId);
    expect(node.getStrand(strandId)).toBeDefined();

    await node.unpublishStrand(strandId);

    // Pins the force-poll + explicit-stop convergence step: no waiting on the 5 s
    // watcher interval — the local instance is gone when unpublishStrand returns.
    expect(node.getStrand(strandId)).toBeUndefined();
    expect(node.getStrands().size).toBe(0);
    expect(await db.queryStrands()).toEqual([]);
  }, 60_000);
});
