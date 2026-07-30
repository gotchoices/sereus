import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import {
  generatePrivateKey,
  getPublicKey,
  sign as cryptoSign,
} from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { formationVouchMessage } from '../src/control-database.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * Exercises the node-level approver-key surface — `enrollValidationKey` /
 * `removeValidationKey` / `listValidationKeys` — which is what an operator (and the
 * `cadre validation-key` command) actually calls to say which outside approvers this party
 * trusts to sign off on people joining its networks.
 *
 * The DB-level `insertValidationKey` / `deleteValidationKey` writers and their replay
 * defences are covered by `control-authorization-binding.spec.ts`. This pins the wrapper:
 * it self-signs with the node's own owner key, the enrolled set round-trips through
 * `queryValidationKeys`, blank input is refused before any write, and — the property most
 * likely to be "fixed" into a bug later — removal is NOT retroactive.
 *
 * Boots a self-signing node the way `publish-formation-invite.spec.ts` does: the node's
 * libp2p key IS its owner key, enrolled in `OwnerKey` so its self-signed control writes are
 * authorised.
 */
describe('CadreNode validation-key enrollment', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  /** A fresh base64url ed25519 keypair standing in for an outside approver. */
  function makeApprover(): { privateKey: string; publicKey: string } {
    const privateKey = generatePrivateKey('ed25519', 'base64url') as string;
    return {
      privateKey,
      publicKey: getPublicKey(privateKey, 'ed25519', 'base64url', 'base64url') as string,
    };
  }

  async function startSelfOwnerNode(enrollOwner = true): Promise<CadreNode> {
    const nodeKey = await generateKeyPair('Ed25519');
    const { publicKeyB64 } = ed25519KeyPairFromLibp2p(nodeKey);

    const n = new CadreNode({
      controlNetwork: { partyId: 'validation-key-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await n.start();

    if (enrollOwner) {
      const db = n.getControlDatabase();
      expect(db).not.toBeNull();
      await db!.insertOwnerKey(publicKeyB64);
    }
    return n;
  }

  function revocationRow(db: ControlDatabase, stampId: string): Promise<Record<string, unknown> | undefined> {
    return db.getDatabase().get(
      'select TableName, RowKey, StampId from CadreControl.Revocation where TableName = ? and StampId = ?',
      ['ValidationKey', stampId],
    );
  }

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('enroll → list shows it → remove → list is empty', async () => {
    node = await startSelfOwnerNode();
    const approver = makeApprover();

    expect(await node.listValidationKeys()).toEqual([]);

    await node.enrollValidationKey(approver.publicKey);
    expect(await node.listValidationKeys()).toEqual([approver.publicKey]);

    await node.removeValidationKey(approver.publicKey);
    expect(await node.listValidationKeys()).toEqual([]);
  }, 60_000);

  it('lists multiple enrolled keys in sorted order', async () => {
    node = await startSelfOwnerNode();
    const keys = [makeApprover().publicKey, makeApprover().publicKey, makeApprover().publicKey];

    for (const key of keys) {
      await node.enrollValidationKey(key);
    }

    expect(await node.listValidationKeys()).toEqual([...keys].sort());
  }, 60_000);

  it('removal writes a Revocation tombstone retiring the row\'s stamp', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const approver = makeApprover();

    await node.enrollValidationKey(approver.publicKey);
    const stampId = await db.queryValidationKeyStampId(approver.publicKey);
    expect(stampId).not.toBeNull();

    await node.removeValidationKey(approver.publicKey);

    const tombstone = await revocationRow(db, stampId!);
    expect(tombstone).toBeDefined();
    expect(tombstone?.RowKey).toBe(approver.publicKey);
    expect((await db.queryRevokedStamps('ValidationKey')).has(stampId!)).toBe(true);
  }, 60_000);

  it('re-enrolling the same key after removal succeeds on a fresh stamp', async () => {
    // The tombstone retires ONE stamp, not the key — so rotation (add → remove → add) must
    // still work, and the retired stamp must stay retired.
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const approver = makeApprover();

    await node.enrollValidationKey(approver.publicKey);
    const firstStamp = await db.queryValidationKeyStampId(approver.publicKey);
    await node.removeValidationKey(approver.publicKey);

    await node.enrollValidationKey(approver.publicKey);

    const secondStamp = await db.queryValidationKeyStampId(approver.publicKey);
    expect(secondStamp).not.toBeNull();
    expect(secondStamp).not.toBe(firstStamp);
    expect(await revocationRow(db, firstStamp!)).toBeDefined();
    expect(await node.listValidationKeys()).toEqual([approver.publicKey]);
  }, 60_000);

  it('removing a key that is not enrolled is a silent no-op (no throw, no tombstone)', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const absent = makeApprover();

    await expect(node.removeValidationKey(absent.publicKey)).resolves.toBeUndefined();

    expect((await db.queryRevokedStamps('ValidationKey')).size).toBe(0);
    expect(await node.listValidationKeys()).toEqual([]);
  }, 60_000);

  it('a redemption approved BEFORE removal survives the removal (removal is not retroactive)', async () => {
    // The schema's approval CHECKs run at write time, so removing an approver key narrows
    // who may approve FUTURE redemptions only. If someone later "fixes" removal into a
    // retroactive revocation, this test fails — which is the point.
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;
    const nodeOwner = ed25519KeyPairFromLibp2p((node as unknown as { identityKey: Parameters<typeof ed25519KeyPairFromLibp2p>[0] }).identityKey);
    const signAsOwner = (message: Uint8Array): string =>
      cryptoSign(message, nodeOwner.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;

    const approver = makeApprover();
    await node.enrollValidationKey(approver.publicKey);

    // Owner-provision the host strand, then mint a validation-gated invite bound to it.
    const strandId = 'strand-retro-' + rand();
    await db.insertStrand(strandId, 'o', nodeOwner.publicKeyB64, signAsOwner);
    const token = 'invite-retro-' + rand();
    await node.publishFormationInvite(token, 'sapp-retro', {
      strandId,
      validationUrl: 'https://hook.example/validate',
    });

    // Redeem it with a real approver sign-off over the exact redemption bytes.
    const usageStampId = 'usage-retro-' + rand();
    const joiner = 'peer-retro-' + rand();
    const validationSignature = cryptoSign(
      formationVouchMessage({ token, usageStampId, strandId, peerId: joiner, disclosure: '' }),
      approver.privateKey, 'ed25519', 'bytes', 'base64url', 'base64url',
    ) as string;
    await db.recordFormationUsage({
      token, strandId, peerId: joiner, usageStampId,
      validationKey: approver.publicKey, validationSignature,
    });
    expect(await db.countFormationUsage(token)).toBe(1);

    await node.removeValidationKey(approver.publicKey);

    // The approver is gone, but the join it approved is untouched.
    expect(await node.listValidationKeys()).toEqual([]);
    expect(await db.countFormationUsage(token)).toBe(1);
    // The approver's key is deliberately NOT a FormationUsage column: it arrives as write-time
    // `context.ValidationKey`, which only selects WHICH enrolled row the sign-off claims, and the
    // signature is verified against the stored `ValidationKey.Key` (see FormationUsage.Authorized
    // in schemas/control.qsql). What must survive the removal is the consent row it authorized,
    // intact and still naming the same invitation, joiner and strand.
    const usage = await db.getDatabase().get(
      'select Token, PeerId, StrandId from CadreControl.FormationUsage where UsageStampId = ?',
      [usageStampId],
    );
    expect(usage).toMatchObject({ Token: token, PeerId: joiner, StrandId: strandId });
  }, 60_000);

  it('rejects an empty or whitespace-only key before any write', async () => {
    node = await startSelfOwnerNode();
    const db = node.getControlDatabase()!;

    for (const blank of ['', '   ', '\t\n']) {
      await expect(node.enrollValidationKey(blank)).rejects.toThrow(/required/i);
      await expect(node.removeValidationKey(blank)).rejects.toThrow(/required/i);
    }

    expect(await node.listValidationKeys()).toEqual([]);
    expect((await db.queryRevokedStamps('ValidationKey')).size).toBe(0);
  }, 60_000);

  it('rejects when the node is not an enrolled owner (constraint propagates, nothing lands)', async () => {
    // Self-signing key present (past the "no signing key" guard) but not in OwnerKey, so
    // ValidationKey.AuthorizedInsert rejects the write.
    node = await startSelfOwnerNode(false);
    const approver = makeApprover();

    await expect(node.enrollValidationKey(approver.publicKey)).rejects.toThrow();

    expect(await node.listValidationKeys()).toEqual([]);
  }, 60_000);

  it('throws the named error when the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'validation-key-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    const approver = makeApprover();

    await expect(stopped.enrollValidationKey(approver.publicKey)).rejects.toThrow(
      /must be started before attempting to enroll a validation key/i,
    );
    await expect(stopped.removeValidationKey(approver.publicKey)).rejects.toThrow(
      /must be started before attempting to remove a validation key/i,
    );
    await expect(stopped.listValidationKeys()).rejects.toThrow(/must be started/i);
  });
});
