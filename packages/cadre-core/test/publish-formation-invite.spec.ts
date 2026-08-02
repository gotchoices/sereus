import { describe, it, expect, afterEach } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode } from '../src/cadre-node.js';
import { ControlFormationUsageRecorder } from '../src/control-formation-recorder.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * Exercises {@link CadreNode.publishFormationInvite} — the node-level method the
 * RN closed-strand demo calls to make a minted invitation token *redeemable*.
 *
 * The DB-level `insertFormationInvite` is covered by
 * `control-formation-invite.spec.ts`; this pins the node wrapper end-to-end:
 * it self-signs with the node's own owner key (the `getSelfSigningKey`
 * path), lands a real `FormationInvite` row, and the row validates through a
 * `ControlFormationUsageRecorder` — i.e. the host's consent gate is armed.
 *
 * Boots a self-signing node the way `seed-bootstrap.spec.ts` does: the node's
 * libp2p key IS its owner key (`ed25519KeyPairFromLibp2p`), enrolled in
 * `OwnerKey` so its self-signed control writes are authorised.
 */
describe('CadreNode.publishFormationInvite (node-level redeemable-invite publish)', () => {
  let node: CadreNode | undefined;

  const rand = (): string => Math.random().toString(36).slice(2);

  afterEach(async () => {
    await node?.stop();
    node = undefined;
  });

  it('happy path: lands a FormationInvite row that validates via the recorder', async () => {
    ({ node } = await startSelfOwnerNode('publish-fi-', { enrollOwner: true }));
    const db = node.getControlDatabase()!;
    const token = 'invite-' + rand();

    await node.publishFormationInvite(token, 'sapp-publish', {
      expiresAtMs: Date.now() + 60_000,
    });

    const row = await db.getDatabase().get(
      'select Token, sAppId from CadreControl.FormationInvite where Token = ?',
      [token],
    );
    expect(row?.Token).toBe(token);
    expect(row?.sAppId).toBe('sapp-publish');

    // The host's responder validates redemption from exactly this row.
    const recorder = new ControlFormationUsageRecorder(db);
    const check = await recorder.isTokenValid(token);
    expect(check.valid).toBe(true);
    expect(check.invitation?.sAppId).toBe('sapp-publish');
  }, 60_000);

  it('registers the published token with the solicitation service (opens the connection gate)', async () => {
    // The gate's formation carve-out reads
    // `StrandSolicitationService.hasOutstandingInvitation`. Publishing a token
    // minted elsewhere must open it WITHOUT waiting for the durable row to be
    // readable, so the service is wired with no recorder here: a `true` answer
    // can only have come from the in-memory mint registry.
    ({ node } = await startSelfOwnerNode('publish-fi-', { enrollOwner: true }));
    node.initializeStrandSolicitation();
    const service = node.getStrandSolicitationService()!;
    expect(await service.hasOutstandingInvitation()).toBe(false);

    await node.publishFormationInvite('invite-' + rand(), 'sapp-publish-gate', {
      expiresAtMs: Date.now() + 60_000,
    });

    expect(await service.hasOutstandingInvitation()).toBe(true);
  }, 60_000);

  it('does not open the gate for an invite published already expired', async () => {
    ({ node } = await startSelfOwnerNode('publish-fi-', { enrollOwner: true }));
    node.initializeStrandSolicitation();
    const service = node.getStrandSolicitationService()!;

    await node.publishFormationInvite('invite-' + rand(), 'sapp-publish-stale', {
      expiresAtMs: Date.now() - 1,
    });

    expect(await service.hasOutstandingInvitation()).toBe(false);
  }, 60_000);

  it('rejects when the node is not an enrolled owner (constraint propagates)', async () => {
    // Self-signing key is present (so it gets past the "no signing key" guard),
    // but it is not enrolled in OwnerKey, so the
    // FormationInvite.AuthorizedAddOrRemove gate rejects the insert.
    ({ node } = await startSelfOwnerNode('publish-fi-', { enrollOwner: false }));
    const db = node.getControlDatabase()!;
    const before = await db.getDatabase().get('select count(1) as c from CadreControl.FormationInvite');

    await expect(
      node.publishFormationInvite('invite-' + rand(), 'sapp-x'),
    ).rejects.toThrow();

    const after = await db.getDatabase().get('select count(1) as c from CadreControl.FormationInvite');
    expect(Number(after?.c ?? 0)).toBe(Number(before?.c ?? 0));
  }, 60_000);

  it('throws if the node has not been started', async () => {
    const nodeKey = await generateKeyPair('Ed25519');
    const stopped = new CadreNode({
      controlNetwork: { partyId: 'publish-fi-stopped-' + rand(), bootstrapNodes: [] },
      privateKey: nodeKey,
      profile: 'transaction',
    });
    await expect(stopped.publishFormationInvite('invite-' + rand(), 'sapp-x')).rejects.toThrow(
      /must be started/i,
    );
  });
});
