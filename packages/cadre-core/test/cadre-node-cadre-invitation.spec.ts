import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { CadreNode, CADRE_INVITATION_DEFAULT_TTL_MS, OWNER_INVITATION_DEFAULT_TTL_MS } from '../src/cadre-node.js';
import { decodeCadreInvitation, type CadreInvitation } from '../src/cadre-invite-protocol.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { newUnstartedNode, startSelfOwnerNode, type SelfOwnerNode } from './self-owner-node-helpers.js';
import { anchorWith, createConfig, inject } from './membership-gate-helpers.js';

/**
 * `CadreNode`'s cadre-invitation surface: what an owner mints (`createCadreInvitation`:
 * defaults by kind, the member list, the anchor precondition), lists and withdraws, and one
 * redemption by a started device at a started member over a real TCP connection — the
 * handler `start()` registers, reached through the libp2p stack rather than a stream double
 * (the protocol's cases are in `cadre-invite-protocol.spec.ts`).
 */

/** Epoch ms of a row's stored `datetime` (T-separated, no zone — UTC). */
function expiresAtMs(invitation: CadreInvitation): number {
  return new Date(`${invitation.invite.expiresAt}Z`).getTime();
}

/** Within a few seconds of `expected`: minting reads the clock after the test does. */
function expectAbout(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(5_000);
}

describe('CadreNode.createCadreInvitation', () => {
  let owner: SelfOwnerNode;

  beforeAll(async () => {
    owner = await startSelfOwnerNode('cadre-invitation-owner-');
    await owner.node.initializeSeedBootstrap(owner.ownerKey.privateKeyB64);
  }, 60_000);

  afterAll(async () => {
    await owner?.node.stop();
  });

  it('defaults by kind: 15 minutes and one use for an untargeted owner grant, 24 hours otherwise', async () => {
    const now = Date.now();
    const bearerOwner = (await owner.node.createCadreInvitation({ grantsOwner: true })).invitation;
    expect(bearerOwner.invite.grantsOwner).toBe(true);
    expect(bearerOwner.invite.peerId).toBeNull();
    expect(bearerOwner.invite.totalUses).toBe(1);
    expectAbout(expiresAtMs(bearerOwner), now + OWNER_INVITATION_DEFAULT_TTL_MS);

    const memberOnly = (await owner.node.createCadreInvitation({ grantsOwner: false })).invitation;
    expectAbout(expiresAtMs(memberOnly), now + CADRE_INVITATION_DEFAULT_TTL_MS);

    // Targeted at one device, an owner grant is not a bearer credential: the long default.
    const targeted = (await owner.node.createCadreInvitation({ grantsOwner: true, peerId: 'peer-target', uses: 3 })).invitation;
    expect(targeted.invite.peerId).toBe('peer-target');
    expect(targeted.invite.totalUses).toBe(3);
    expectAbout(expiresAtMs(targeted), now + CADRE_INVITATION_DEFAULT_TTL_MS);

    await expect(owner.node.createCadreInvitation({ grantsOwner: false, uses: 0 })).rejects.toThrow(/positive integer/);
  });

  it('names this machine first, carries the anchored owner keys, and round-trips through its encoding', async () => {
    const { invitation, encoded } = await owner.node.createCadreInvitation({ grantsOwner: false });
    expect(invitation.partyId).toBe(owner.node.partyId);
    expect(invitation.ownerKeys).toEqual([owner.ownerKey.publicKeyB64]);
    // Alone in its party, the invitation names exactly this machine's own addresses.
    expect(invitation.members.length).toBeGreaterThan(0);
    expect(invitation.members).toEqual(owner.node.getMultiaddrs());
    expect(decodeCadreInvitation(encoded)).toEqual(invitation);
  });

  it('lists what it minted, and a withdrawal turns live off while the row stays', async () => {
    const { invitation } = await owner.node.createCadreInvitation({ grantsOwner: false });
    const key = invitation.invite.key;
    const before = (await owner.node.listCadreInvitations()).find((status) => status.invite.key === key);
    expect(before).toMatchObject({ live: true, withdrawn: false, usesRecorded: 0 });

    expect(await owner.node.withdrawCadreInvitation(key)).toBe(true);
    expect(await owner.node.withdrawCadreInvitation(key)).toBe(false);
    const after = (await owner.node.listCadreInvitations()).find((status) => status.invite.key === key);
    expect(after).toMatchObject({ live: false, withdrawn: true, usesRecorded: 0 });
    expect(after?.invite).toEqual(invitation.invite);
  });

  it('refuses to mint with an empty anchor: a reply could not be verified against it', async () => {
    // An owner key wired but nothing anchored — unreachable through initializeSeedBootstrap,
    // which anchors the key it is given, so the precondition is pinned through injection.
    const node = new CadreNode(createConfig());
    inject(node, { members: [], anchor: await anchorWith('p') });
    (node as unknown as { seedBootstrapService: unknown }).seedBootstrapService = {
      canAuthorize: () => true,
      insertCadreInvite: async () => { throw new Error('must not be reached'); }
    };

    await expect(node.createCadreInvitation({ grantsOwner: false })).rejects.toThrow(/anchors no owner key/);
  });

  it('needs the owner key', async () => {
    const { node } = await newUnstartedNode('cadre-invitation-keyless-');
    await expect(node.createCadreInvitation({ grantsOwner: false })).rejects.toThrow(/initializeSeedBootstrap/);
  });
});

describe('CadreNode.redeemCadreInvitation', () => {
  it('a started device redeems at a started member over the network and is admitted', async () => {
    const member = await startSelfOwnerNode('cadre-invitation-member-');
    // The device joins the member's party; a stable identity, since the redemption is
    // signed with the key behind its peer id. No storage provider: each node keeps its
    // own in-memory store, so the two share nothing but the wire.
    const deviceKey = await generateKeyPair('Ed25519');
    const device = new CadreNode({
      controlNetwork: { partyId: member.node.partyId, bootstrapNodes: [] },
      privateKey: deviceKey,
      profile: 'transaction'
    });
    try {
      await member.node.initializeSeedBootstrap(member.ownerKey.privateKeyB64);
      const { invitation } = await member.node.createCadreInvitation({ grantsOwner: true });
      await device.start();

      // Wrong party: refused before anything is dialed or pinned.
      await expect(device.redeemCadreInvitation({ ...invitation, partyId: 'another-party' })).rejects.toThrow(/another-party/);
      expect(device.getTrustedOwnerStore()!.has(member.ownerKey.publicKeyB64)).toBe(false);

      const result = await device.redeemCadreInvitation(invitation);

      expect(result.peerId).toBe(member.node.peerId!.toString());
      expect(result.grantsOwner).toBe(true);
      // The member admitted the device through the chain its database now holds.
      const devicePeerId = device.peerId!.toString();
      expect((await member.node.listAuthorizedMembers()).map((row) => row.peerId)).toContain(devicePeerId);
      expect(await member.node.getControlDatabase()!.getOwnerKeys()).toContain(ed25519KeyPairFromLibp2p(deviceKey).publicKeyB64);
      // The device pinned the bundle's owner keys and remembers the member as a dial target.
      expect(device.getTrustedOwnerStore()!.has(member.ownerKey.publicKeyB64)).toBe(true);
      expect(device.getBootstrapPeerStore()!.all().get(result.peerId!)?.addrs.length).toBeGreaterThan(0);
    } finally {
      await device.stop();
      await member.node.stop();
    }
  }, 90_000);
});
